import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BOOTSTRAP_SCAN_BYTES,
  MAIN_LOG_FILENAME,
  MAX_TAIL_BYTES,
  PATTERNS,
  RECENT_TOOL_TTL_MS,
  createLogWatcher,
  defaultLogDirCandidates,
  extractFromChunk,
  pickLogDir,
} from '../src/sources/logs.js';
import type { Logger } from '../src/log.js';

const VERSION_LINE =
  '    at Object.<anonymous> (C:\\Program Files\\WindowsApps\\Claude_1.46388.4.0_x64__pzs8sxrjxfjjc\\app\\main.js:1:1)';
const TOOL_LINE =
  '2026-09-06 10:00:00 Received permission response for 1a2b3c4d-5e6f: once (tool: Bash)';
const MCP_COUNT_LINE = '2026-09-06 10:00:01 mcpServerStatus returned 22 servers';
const PRIVATE_LINE = '2026-09-06 10:00:02 user asked about their bank password hunter2';

function fakeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const info = vi.fn();
  return { logger: { warn, info } as unknown as Logger, warn };
}

describe('defaultLogDirCandidates', () => {
  it('offers the live Local directory and the stale Roaming one', () => {
    const candidates = defaultLogDirCandidates({
      LOCALAPPDATA: 'C:\\Local',
      APPDATA: 'C:\\Roaming',
    });

    expect(candidates).toEqual([
      path.join('C:\\Local', 'Claude', 'Logs'),
      path.join('C:\\Roaming', 'Claude', 'logs'),
    ]);
  });

  it('skips a location the environment does not define', () => {
    expect(defaultLogDirCandidates({ LOCALAPPDATA: 'C:\\Local' })).toHaveLength(1);
    expect(defaultLogDirCandidates({})).toEqual([]);
  });
});

describe('pickLogDir', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cdp-logs-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeDir(name: string, mtimeSecondsAgo: number): string {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, MAIN_LOG_FILENAME);
    writeFileSync(file, 'x', 'utf8');
    const when = new Date(Date.now() - mtimeSecondsAgo * 1000);
    utimesSync(file, when, when);
    return dir;
  }

  it('picks the directory whose main.log is newest', async () => {
    const stale = makeDir('roaming', 60 * 60 * 24 * 16);
    const live = makeDir('local', 5);

    expect(await pickLogDir([stale, live])).toBe(live);
    expect(await pickLogDir([live, stale])).toBe(live);
  });

  it('is the whole defence against the August 2026 move', async () => {
    // The stale Roaming directory still exists and still parses; only mtime tells
    // them apart.
    const stale = makeDir('roaming', 60 * 60 * 24 * 16);
    expect(statSync(path.join(stale, MAIN_LOG_FILENAME)).isFile()).toBe(true);
    expect(await pickLogDir([stale])).toBe(stale);
  });

  it('ignores candidates with no main.log', async () => {
    const live = makeDir('local', 5);
    expect(await pickLogDir([path.join(root, 'nope'), live])).toBe(live);
  });

  it('returns null when no candidate exists', async () => {
    expect(await pickLogDir([path.join(root, 'a'), path.join(root, 'b')])).toBe(null);
    expect(await pickLogDir([])).toBe(null);
  });
});

describe('extractFromChunk — the whitelist', () => {
  it('pulls the app version out of a stack trace', () => {
    expect(extractFromChunk(VERSION_LINE).appVersion).toBe('1.46388.4.0');
  });

  it('pulls the tool name out of a permission response', () => {
    expect(extractFromChunk(TOOL_LINE).recentTool).toBe('Bash');
  });

  it('handles namespaced MCP tool names', () => {
    const line = TOOL_LINE.replace('Bash', 'mcp__server__do-thing.v2');
    expect(extractFromChunk(line).recentTool).toBe('mcp__server__do-thing.v2');
  });

  it('pulls the MCP server count', () => {
    expect(extractFromChunk(MCP_COUNT_LINE).mcpServerCount).toBe(22);
  });

  it('takes the newest value when a chunk holds several', () => {
    const chunk = [MCP_COUNT_LINE, MCP_COUNT_LINE.replace('22', '25')].join('\n');
    expect(extractFromChunk(chunk).mcpServerCount).toBe(25);
  });

  it('extracts NOTHING from a line that is not on the whitelist', () => {
    const found = extractFromChunk(PRIVATE_LINE);
    expect(found).toEqual({ appVersion: null, recentTool: null, mcpServerCount: null });
  });

  it('never surfaces conversation content, even next to a match', () => {
    const chunk = [PRIVATE_LINE, TOOL_LINE, PRIVATE_LINE].join('\n');
    const found = extractFromChunk(chunk);

    expect(found.recentTool).toBe('Bash');
    expect(JSON.stringify(found)).not.toContain('hunter2');
    expect(JSON.stringify(found)).not.toContain('bank');
  });

  it('does not parse tools/call — this version does not log it', () => {
    const mcpLine = '2026-09-06 10:00:00 {"method":"tools/call","params":{"name":"Read"}}';
    expect(extractFromChunk(mcpLine)).toEqual({
      appVersion: null,
      recentTool: null,
      mcpServerCount: null,
    });
    expect(Object.keys(PATTERNS)).toEqual(['appVersion', 'recentTool', 'mcpServerCount']);
  });
});

describe('createLogWatcher', () => {
  let dir: string;
  let mainLog: string;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cdp-watch-'));
    mainLog = path.join(dir, MAIN_LOG_FILENAME);
    clock = 1_000_000;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function watcher(logger?: Logger) {
    return createLogWatcher({
      logDirOverride: null,
      candidates: [dir],
      now: () => clock,
      ...(logger ? { logger } : {}),
    });
  }

  it('finds the log directory and reports it', async () => {
    writeFileSync(mainLog, VERSION_LINE + '\n', 'utf8');
    const w = watcher();
    await w.poll();
    expect(w.logDir).toBe(dir);
  });

  it('survives having no log directory at all', async () => {
    const w = createLogWatcher({ logDirOverride: null, candidates: [], now: () => clock });
    const result = await w.poll();

    expect(w.logDir).toBe(null);
    expect(result).toEqual({
      appVersion: null,
      recentTool: null,
      mcpServerCount: null,
      mcpActivity: false,
    });
  });

  describe('no backlog replay', () => {
    it('does NOT pick up a stale tool name from the existing file', async () => {
      // Yesterday's permission click is sitting in the file when the daemon starts.
      writeFileSync(mainLog, [VERSION_LINE, TOOL_LINE, MCP_COUNT_LINE].join('\n') + '\n', 'utf8');

      const result = await watcher().poll();

      expect(result.recentTool).toBe(null);
      // The static values are still picked up from the same scan.
      expect(result.appVersion).toBe('1.46388.4.0');
      expect(result.mcpServerCount).toBe(22);
    });

    it('picks up a tool name that arrives after startup', async () => {
      writeFileSync(mainLog, TOOL_LINE + '\n', 'utf8');
      const w = watcher();
      expect((await w.poll()).recentTool).toBe(null);

      appendFileSync(mainLog, TOOL_LINE.replace('Bash', 'Edit') + '\n', 'utf8');
      expect((await w.poll()).recentTool).toBe('Edit');
    });

    it('only scans the tail of a large file', async () => {
      // Version line at the very top, then more than the scan window of filler.
      const filler = 'x'.repeat(BOOTSTRAP_SCAN_BYTES + 50_000);
      writeFileSync(mainLog, VERSION_LINE + '\n' + filler + '\n', 'utf8');

      // Out of the scanned window, so it is not found — and that is correct: the
      // alternative is reading 4 MB on every start.
      expect((await watcher().poll()).appVersion).toBe(null);
    });

    it('starts tailing from the end of the file', async () => {
      writeFileSync(mainLog, 'x'.repeat(5000) + '\n', 'utf8');
      const w = watcher();
      await w.poll();

      appendFileSync(mainLog, MCP_COUNT_LINE.replace('22', '7') + '\n', 'utf8');
      expect((await w.poll()).mcpServerCount).toBe(7);
    });
  });

  describe('tailing', () => {
    it('holds back a partial last line until it is complete', async () => {
      writeFileSync(mainLog, 'start\n', 'utf8');
      const w = watcher();
      await w.poll();

      // Half-written record: must not match yet.
      appendFileSync(mainLog, MCP_COUNT_LINE.slice(0, 30), 'utf8');
      expect((await w.poll()).mcpServerCount).toBe(null);

      appendFileSync(mainLog, MCP_COUNT_LINE.slice(30) + '\n', 'utf8');
      expect((await w.poll()).mcpServerCount).toBe(22);
    });

    it('keeps multi-byte characters intact across a read boundary', async () => {
      writeFileSync(mainLog, 'start\n', 'utf8');
      const w = watcher();
      await w.poll();

      // The diacritics have to sit AFTER the matched part; replacing "servers"
      // itself would just break the pattern.
      const line = MCP_COUNT_LINE + ' — Kryštof, běžící přes příliš žluťoučký kůň';
      const bytes = Buffer.from(line + '\n', 'utf8');
      // Split in the middle of the multi-byte run.
      appendFileSync(mainLog, bytes.subarray(0, bytes.length - 12));
      await w.poll();
      appendFileSync(mainLog, bytes.subarray(bytes.length - 12));

      expect((await w.poll()).mcpServerCount).toBe(22);
    });

    it('restarts from the top when the file shrinks (rotation)', async () => {
      writeFileSync(mainLog, 'x'.repeat(5000) + '\n', 'utf8');
      const w = watcher();
      await w.poll();

      writeFileSync(mainLog, MCP_COUNT_LINE.replace('22', '3') + '\n', 'utf8');
      expect((await w.poll()).mcpServerCount).toBe(3);
    });

    it('skips ahead instead of allocating a huge read', async () => {
      writeFileSync(mainLog, 'start\n', 'utf8');
      const { logger, warn } = fakeLogger();
      const w = watcher(logger);
      await w.poll();

      appendFileSync(mainLog, 'y'.repeat(MAX_TAIL_BYTES + 100_000) + '\n', 'utf8');
      appendFileSync(mainLog, MCP_COUNT_LINE.replace('22', '9') + '\n', 'utf8');

      expect((await w.poll()).mcpServerCount).toBe(9);
      expect(warn.mock.calls.some((call) => String(call[0]).includes('skipping ahead'))).toBe(true);
    });

    it('reports nothing rather than throwing when main.log disappears', async () => {
      writeFileSync(mainLog, VERSION_LINE + '\n', 'utf8');
      const { logger, warn } = fakeLogger();
      const w = watcher(logger);
      await w.poll();

      rmSync(mainLog);
      const result = await w.poll();

      expect(result.appVersion).toBe('1.46388.4.0');
      expect(warn).toHaveBeenCalled();
    });

    it('throttles repeated IO warnings so the daemon log stays readable', async () => {
      writeFileSync(mainLog, VERSION_LINE + '\n', 'utf8');
      const { logger, warn } = fakeLogger();
      const w = watcher(logger);
      await w.poll();
      rmSync(mainLog);

      for (let i = 0; i < 20; i += 1) {
        clock += 2000;
        await w.poll();
      }

      // 20 ticks over 40 s must not produce 20 warnings.
      expect(warn.mock.calls.length).toBeLessThan(5);
    });
  });

  describe('recentTool expiry', () => {
    it('drops the tool name after the TTL', async () => {
      writeFileSync(mainLog, 'start\n', 'utf8');
      const w = watcher();
      await w.poll();

      appendFileSync(mainLog, TOOL_LINE + '\n', 'utf8');
      expect((await w.poll()).recentTool).toBe('Bash');

      clock += RECENT_TOOL_TTL_MS - 1;
      expect((await w.poll()).recentTool).toBe('Bash');

      clock += 2;
      expect((await w.poll()).recentTool).toBe(null);
    });
  });

  describe('mcpActivity', () => {
    function writeMcpLog(name: string, secondsAgo: number): void {
      const file = path.join(dir, name);
      writeFileSync(file, 'x', 'utf8');
      const when = new Date(clock - secondsAgo * 1000);
      utimesSync(file, when, when);
    }

    it('is true when an mcp-server log was just touched', async () => {
      writeFileSync(mainLog, 'start\n', 'utf8');
      writeMcpLog('mcp-server-Filesystem.log', 2);

      expect((await watcher().poll()).mcpActivity).toBe(true);
    });

    it('is false when every mcp-server log is stale', async () => {
      writeFileSync(mainLog, 'start\n', 'utf8');
      writeMcpLog('mcp-server-Filesystem.log', 60);

      expect((await watcher().poll()).mcpActivity).toBe(false);
    });

    it('ignores files that are not mcp-server logs', async () => {
      writeFileSync(mainLog, 'start\n', 'utf8');
      writeFileSync(path.join(dir, 'mcp.log'), 'x', 'utf8');

      expect((await watcher().poll()).mcpActivity).toBe(false);
    });

    it('can be polled on its own, without tailing the log', async () => {
      // mcpActivity outranks CPU in the state machine, so it has to be cheap enough
      // to check every tick rather than only when the logs are read.
      writeFileSync(mainLog, 'start\n', 'utf8');
      writeMcpLog('mcp-server-Fetch.log', 1);

      const w = watcher();
      expect(await w.pollMcpActivity()).toBe(true);
    });

    it('picks up a newly created server log after the directory is rechecked', async () => {
      writeFileSync(mainLog, 'start\n', 'utf8');
      const w = watcher();
      expect(await w.pollMcpActivity()).toBe(false);

      writeMcpLog('mcp-server-New.log', 1);
      // The file list is cached until the directory recheck comes round.
      clock += 6 * 60_000;
      writeMcpLog('mcp-server-New.log', 1);

      expect(await w.pollMcpActivity()).toBe(true);
    });
  });

  it('exposes the last computed values without touching the disk', async () => {
    writeFileSync(mainLog, VERSION_LINE + '\n', 'utf8');
    const w = watcher();
    const result = await w.poll();
    expect(w.last).toEqual(result);
  });
});
