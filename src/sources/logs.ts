/**
 * Reading the Claude Desktop logs — whitelist of regexes only, nothing else (SPEC §5).
 *
 * Verified facts (SPEC §0, 2026-09-06):
 *  - the LIVE directory is %LOCALAPPDATA%\Claude\Logs (capital L)
 *  - %APPDATA%\Claude\logs is a leftover from the 2026-08-21 update; it still exists
 *    and still holds old files, so it MUST NOT be used
 *  - the right directory is whichever candidate (plus logDirOverride) has the newest
 *    main.log mtime; checked at startup and every LOG_DIR_RECHECK_MS
 *  - tools/call is NOT written to mcp.log in this version (only tools/list,
 *    prompts/list, resources/list), so there is nothing to parse there
 *
 * Three things that are easy to get wrong here:
 *
 * 1. NO BACKLOG REPLAY. main.log is 4 MB on the target machine. Reading it from the
 *    start would find yesterday's "Received permission response ... (tool: X)" and
 *    show a tool name the moment the daemon boots. So: scan the last
 *    BOOTSTRAP_SCAN_BYTES once for the static values (appVersion, mcpServerCount),
 *    then jump the offset to EOF and tail live from there.
 *
 * 2. Claude Desktop holds main.log open for writing. Everything is opened read-only
 *    and every read is allowed to fail (EBUSY/EACCES) — log it, try again next tick,
 *    never throw.
 *
 * 3. mcpActivity now outranks CPU in the state machine, so it matters more than it
 *    used to. It is a plain fs.stat on mcp-server-*.log and is checked every tick,
 *    independently of the (slower) log tailing.
 */

import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { Logger } from '../log.js';

/** How often the live log directory is re-evaluated. */
export const LOG_DIR_RECHECK_MS = 5 * 60_000;

/** How long a tool name from the permission dialog stays valid. */
export const RECENT_TOOL_TTL_MS = 30_000;

/** Window in which an mcp-server-*.log mtime change counts as activity. */
export const MCP_ACTIVITY_WINDOW_MS = 10_000;

/** How much of the tail is scanned once at startup for static values. */
export const BOOTSTRAP_SCAN_BYTES = 256 * 1024;

/** Upper bound on one tail read, so a long pause cannot allocate the whole file. */
export const MAX_TAIL_BYTES = 1024 * 1024;

/** Repeated IO failures are logged at most this often, to keep the daemon log usable. */
const WARN_THROTTLE_MS = 60_000;

export const MAIN_LOG_FILENAME = 'main.log';
const MCP_LOG_PATTERN = /^mcp-server-.*\.log$/i;

/**
 * The whitelist. ONLY what matches here is ever processed — privacy is not a
 * post-processing step, it is the reason this is a whitelist.
 */
export const PATTERNS = {
  /** main.log — first match wins, then it is cached. */
  appVersion: /Claude_(\d+\.\d+\.\d+\.\d+)_x64__/,
  /**
   * main.log — NOTE: written ONLY when the user clicks through a tool permission
   * dialog, not on every call. Not a reliable source.
   *
   * The dash sits at the end of the class rather than being escaped as \- (as in
   * SPEC §P4) — same meaning, minus a useless escape.
   */
  recentTool: /Received permission response for [\da-f-]+: \w+ \(tool: ([\w:.-]+)\)/,
  /** main.log */
  mcpServerCount: /mcpServerStatus returned (\d+) servers/,
} as const;

/** One pass over the logs. Every field may be null — the daemon has to survive that. */
export interface LogExtracts {
  appVersion: string | null;
  recentTool: string | null;
  mcpServerCount: number | null;
  /** An mcp-server-*.log was touched within MCP_ACTIVITY_WINDOW_MS. */
  mcpActivity: boolean;
}

export interface LogWatcherOptions {
  logDirOverride: string | null;
  logger?: Logger;
  now?: () => number;
  /** Extra candidate directories; defaults to the two known Claude locations. */
  candidates?: readonly string[];
}

export interface LogWatcher {
  /** The directory currently in use, or null when no candidate exists. */
  readonly logDir: string | null;
  /** Everything: directory recheck, tail, MCP activity. */
  poll(): Promise<LogExtracts>;
  /**
   * Just the MCP mtime check. Cheap enough to call every tick, and it has to be —
   * mcpActivity outranks CPU in the state machine.
   */
  pollMcpActivity(): Promise<boolean>;
  /** Last computed values, without touching the disk. */
  readonly last: LogExtracts;
}

const EMPTY_EXTRACTS: LogExtracts = {
  appVersion: null,
  recentTool: null,
  mcpServerCount: null,
  mcpActivity: false,
};

/** The two locations Claude Desktop has used. Order does not matter — mtime decides. */
export function defaultLogDirCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const local = env['LOCALAPPDATA'];
  const roaming = env['APPDATA'];
  if (local !== undefined && local !== '') candidates.push(path.join(local, 'Claude', 'Logs'));
  if (roaming !== undefined && roaming !== '')
    candidates.push(path.join(roaming, 'Claude', 'logs'));
  return candidates;
}

/**
 * Picks the candidate whose main.log was written most recently.
 *
 * This is the whole defence against the August 2026 move: the stale Roaming directory
 * still exists and still parses fine, it is just months out of date.
 */
export async function pickLogDir(candidates: readonly string[]): Promise<string | null> {
  let best: { dir: string; mtimeMs: number } | null = null;

  for (const dir of candidates) {
    try {
      const stat = await fs.stat(path.join(dir, MAIN_LOG_FILENAME));
      if (!stat.isFile()) continue;
      if (best === null || stat.mtimeMs > best.mtimeMs) best = { dir, mtimeMs: stat.mtimeMs };
    } catch {
      // Missing or unreadable candidate: just not a contender.
    }
  }
  return best?.dir ?? null;
}

/** Applies the whitelist to a chunk of log text. Nothing else is looked at. */
export function extractFromChunk(chunk: string): {
  appVersion: string | null;
  recentTool: string | null;
  mcpServerCount: number | null;
} {
  let appVersion: string | null = null;
  let recentTool: string | null = null;
  let mcpServerCount: number | null = null;

  for (const line of chunk.split('\n')) {
    if (appVersion === null) {
      const version = PATTERNS.appVersion.exec(line);
      if (version?.[1] !== undefined) appVersion = version[1];
    }
    // Last match wins for these two — the newest line in the chunk is the current one.
    const tool = PATTERNS.recentTool.exec(line);
    if (tool?.[1] !== undefined) recentTool = tool[1];

    const count = PATTERNS.mcpServerCount.exec(line);
    if (count?.[1] !== undefined) {
      const parsed = Number.parseInt(count[1], 10);
      if (Number.isFinite(parsed)) mcpServerCount = parsed;
    }
  }

  return { appVersion, recentTool, mcpServerCount };
}

/** EBUSY / EACCES / ENOENT and friends, for a readable warning. */
function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLogWatcher(options: LogWatcherOptions): LogWatcher {
  const now = options.now ?? (() => Date.now());
  const candidates = [
    ...(options.logDirOverride !== null ? [options.logDirOverride] : []),
    ...(options.candidates ?? defaultLogDirCandidates()),
  ];

  let logDir: string | null = null;
  let logDirCheckedAt = Number.NEGATIVE_INFINITY;

  let offset = 0;
  let bootstrapped = false;
  let decoder = new StringDecoder('utf8');
  let pendingLine = '';

  let appVersion: string | null = null;
  let mcpServerCount: number | null = null;
  let recentTool: { name: string; at: number } | null = null;

  let mcpFiles: string[] | null = null;
  let mcpActivity = false;

  let last: LogExtracts = EMPTY_EXTRACTS;
  const warnedAt = new Map<string, number>();

  /** Keeps a failing file from filling the daemon log with one line per tick. */
  function warnThrottled(key: string, message: string, fields?: Record<string, unknown>): void {
    const at = now();
    if (at - (warnedAt.get(key) ?? Number.NEGATIVE_INFINITY) < WARN_THROTTLE_MS) return;
    warnedAt.set(key, at);
    options.logger?.warn(message, fields);
  }

  function resetTail(): void {
    offset = 0;
    bootstrapped = false;
    decoder = new StringDecoder('utf8');
    pendingLine = '';
  }

  async function refreshLogDir(force = false): Promise<void> {
    const at = now();
    if (!force && at - logDirCheckedAt < LOG_DIR_RECHECK_MS) return;
    logDirCheckedAt = at;

    // The server list is re-read on this cadence too: an MCP server started
    // mid-session creates a brand new mcp-server-*.log, and mcpActivity now outranks
    // CPU, so missing one matters more than it used to.
    mcpFiles = null;

    const picked = await pickLogDir(candidates);
    if (picked !== logDir) {
      options.logger?.info('log directory selected', { dir: picked ?? '(none)' });
      logDir = picked;
      resetTail();
    }
  }

  /**
   * Opened read-only every time: Claude Desktop holds this file open for writing, and
   * on Windows that makes a shared read the only thing that reliably works.
   */
  async function readRange(filePath: string, from: number, length: number): Promise<Buffer | null> {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(filePath, constants.O_RDONLY);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, from);
      return buffer.subarray(0, bytesRead);
    } catch (error) {
      const code = errorCode(error);
      warnThrottled(`read:${filePath}`, 'could not read a Claude log, will retry', {
        code: code === '' ? describeError(error) : code,
      });
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /**
   * One-off scan of the tail for values that do not change often. recentTool is
   * deliberately NOT taken from here — a permission click from yesterday is not
   * something happening now.
   */
  async function bootstrap(filePath: string, size: number): Promise<void> {
    const from = Math.max(0, size - BOOTSTRAP_SCAN_BYTES);
    const buffer = await readRange(filePath, from, size - from);
    if (buffer !== null) {
      const found = extractFromChunk(buffer.toString('utf8'));
      appVersion ??= found.appVersion;
      if (found.mcpServerCount !== null) mcpServerCount = found.mcpServerCount;
    }

    // Live tailing starts at the end regardless of whether the scan worked.
    offset = size;
    bootstrapped = true;
    decoder = new StringDecoder('utf8');
    pendingLine = '';
  }

  async function tailMainLog(): Promise<void> {
    if (logDir === null) return;
    const filePath = path.join(logDir, MAIN_LOG_FILENAME);

    let size: number;
    try {
      size = (await fs.stat(filePath)).size;
    } catch (error) {
      warnThrottled(`stat:${filePath}`, 'could not stat main.log, will retry', {
        code: errorCode(error) || describeError(error),
      });
      return;
    }

    if (!bootstrapped) {
      await bootstrap(filePath, size);
      return;
    }

    // Smaller than last time means the file rotated; start over from the top.
    if (size < offset) {
      options.logger?.info('main.log rotated, restarting the tail');
      offset = 0;
      decoder = new StringDecoder('utf8');
      pendingLine = '';
    }
    if (size === offset) return;

    let from = offset;
    if (size - from > MAX_TAIL_BYTES) {
      // Missed a lot (a suspended machine, a stalled daemon). Skip the middle rather
      // than allocating it; the values we care about are near the end anyway.
      from = size - MAX_TAIL_BYTES;
      decoder = new StringDecoder('utf8');
      pendingLine = '';
      warnThrottled('skip', 'main.log grew faster than it was read, skipping ahead', {
        skippedBytes: from - offset,
      });
    }

    const buffer = await readRange(filePath, from, size - from);
    if (buffer === null) return;
    offset = from + buffer.length;

    // The decoder holds back a split multi-byte sequence; pendingLine holds back a
    // partial last line so a half-written record is never matched.
    const text = pendingLine + decoder.write(buffer);
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak === -1) {
      pendingLine = text;
      return;
    }
    pendingLine = text.slice(lastBreak + 1);

    const found = extractFromChunk(text.slice(0, lastBreak));
    appVersion ??= found.appVersion;
    if (found.mcpServerCount !== null) mcpServerCount = found.mcpServerCount;
    if (found.recentTool !== null) recentTool = { name: found.recentTool, at: now() };
  }

  async function listMcpLogs(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir);
      return entries.filter((name) => MCP_LOG_PATTERN.test(name));
    } catch (error) {
      warnThrottled(`readdir:${dir}`, 'could not list the log directory, will retry', {
        code: errorCode(error) || describeError(error),
      });
      return [];
    }
  }

  async function checkMcpActivity(): Promise<boolean> {
    if (logDir === null) return false;

    // The file list is refreshed on the directory recheck cadence; the stat calls
    // themselves run every tick.
    mcpFiles ??= await listMcpLogs(logDir);

    const cutoff = now() - MCP_ACTIVITY_WINDOW_MS;
    for (const name of mcpFiles) {
      try {
        const stat = await fs.stat(path.join(logDir, name));
        if (stat.mtimeMs >= cutoff) return true;
      } catch {
        // A server log that vanished is not activity; the next refresh drops it.
      }
    }
    return false;
  }

  function currentExtracts(): LogExtracts {
    const tool =
      recentTool !== null && now() - recentTool.at < RECENT_TOOL_TTL_MS ? recentTool.name : null;
    if (tool === null) recentTool = null;

    last = { appVersion, recentTool: tool, mcpServerCount, mcpActivity };
    return last;
  }

  return {
    get logDir() {
      return logDir;
    },
    get last() {
      return last;
    },

    async pollMcpActivity(): Promise<boolean> {
      await refreshLogDir();
      mcpActivity = await checkMcpActivity();
      return mcpActivity;
    },

    async poll(): Promise<LogExtracts> {
      await refreshLogDir();
      await tailMainLog();
      mcpActivity = await checkMcpActivity();
      return currentExtracts();
    },
  };
}
