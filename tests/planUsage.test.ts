import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LARGE_FILE_BYTES,
  PLAN_USAGE_FILENAME,
  READ_INTERVAL_MS,
  createPlanUsageReader,
  parsePlanUsage,
  parsePlanUsageTail,
  resolvePlanUsagePath,
  toPlanUsage,
} from '../src/sources/planUsage.js';
import type { Logger } from '../src/log.js';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

function sample(t: number, fh: number, sd: number): string {
  return JSON.stringify({ t, org: ORG, u: { fh, sd } });
}

function file(samples: string[]): string {
  return `{"version":2,"samples":[${samples.join(',')}]}`;
}

function fakeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { logger: { warn, info: vi.fn() } as unknown as Logger, warn };
}

describe('resolvePlanUsagePath', () => {
  it('points at Roaming — the file did not move to Local with the logs', () => {
    const resolved = resolvePlanUsagePath({ APPDATA: 'C:\\Roaming', LOCALAPPDATA: 'C:\\Local' });

    expect(resolved).toBe(path.join('C:\\Roaming', 'Claude', PLAN_USAGE_FILENAME));
    expect(resolved).not.toContain('Local');
  });

  it('returns null when APPDATA is not set', () => {
    expect(resolvePlanUsagePath({})).toBe(null);
  });
});

describe('toPlanUsage', () => {
  it('reads the two percentages and the timestamp', () => {
    const usage = toPlanUsage({ t: 1786058038582, org: ORG, u: { fh: 55, sd: 22 } });

    expect(usage?.shortWindowPercent).toBe(55);
    expect(usage?.longWindowPercent).toBe(22);
    expect(usage?.at.getTime()).toBe(1786058038582);
  });

  it('NEVER carries the org identifier out', () => {
    const usage = toPlanUsage({ t: 1, org: ORG, u: { fh: 1, sd: 2 } });

    expect(Object.keys(usage ?? {})).toEqual(['shortWindowPercent', 'longWindowPercent', 'at']);
    expect(JSON.stringify(usage)).not.toContain(ORG);
    expect(JSON.stringify(usage)).not.toContain('org');
  });

  it('rejects anything missing a timestamp or the usage object', () => {
    expect(toPlanUsage({ org: ORG, u: { fh: 1, sd: 2 } })).toBe(null);
    expect(toPlanUsage({ t: 1, org: ORG })).toBe(null);
    expect(toPlanUsage({ t: 1, u: { fh: 1 } })).toBe(null);
    expect(toPlanUsage({ t: 'now', u: { fh: 1, sd: 2 } })).toBe(null);
    expect(toPlanUsage(null)).toBe(null);
    expect(toPlanUsage([])).toBe(null);
  });
});

describe('parsePlanUsage', () => {
  it('parses the verified format', () => {
    const usage = parsePlanUsage(
      '{"version":2,"samples":[{"t":1786058038582,"org":"x","u":{"fh":55,"sd":22}}]}'
    );

    expect(usage?.shortWindowPercent).toBe(55);
    expect(usage?.longWindowPercent).toBe(22);
  });

  it('parses a file that carries a UTF-8 BOM', () => {
    // Claude Desktop does not write one today, but this file is read from disk and
    // every such read in the project tolerates a mark — one rule, not per-file luck.
    const usage = parsePlanUsage(
      '﻿{"version":2,"samples":[{"t":1786058038582,"org":"x","u":{"fh":55,"sd":22}}]}'
    );

    expect(usage?.shortWindowPercent).toBe(55);
  });

  it('takes the newest sample by t, not the last in the array', () => {
    const usage = parsePlanUsage(
      file([sample(3000, 30, 3), sample(9000, 90, 9), sample(6000, 60, 6)])
    );
    expect(usage?.shortWindowPercent).toBe(90);
  });

  it('skips malformed samples but keeps the good ones', () => {
    const usage = parsePlanUsage(
      `{"version":2,"samples":[{"t":1},${sample(5000, 50, 5)},{"u":{"fh":1,"sd":2}}]}`
    );
    expect(usage?.shortWindowPercent).toBe(50);
  });

  it('returns null for broken JSON rather than throwing', () => {
    expect(parsePlanUsage('{"version":2,"samples":[')).toBe(null);
    expect(parsePlanUsage('')).toBe(null);
    expect(parsePlanUsage('not json at all')).toBe(null);
  });

  it('returns null when there are no usable samples', () => {
    expect(parsePlanUsage('{"version":2,"samples":[]}')).toBe(null);
    expect(parsePlanUsage('{"version":2}')).toBe(null);
  });
});

describe('parsePlanUsageTail', () => {
  it('finds the last complete sample in a chunk', () => {
    const chunk = `${sample(1000, 10, 1)},${sample(2000, 20, 2)}]}`;
    expect(parsePlanUsageTail(chunk)?.shortWindowPercent).toBe(20);
  });

  it('survives a chunk that starts in the middle of an object', () => {
    const chunk = `0,"org":"x","u":{"fh":9,"sd":9}},${sample(2000, 20, 2)}]}`;
    expect(parsePlanUsageTail(chunk)?.shortWindowPercent).toBe(20);
  });

  it('falls back to the previous sample when the last one is truncated mid-write', () => {
    const chunk = `${sample(1000, 10, 1)},${sample(2000, 20, 2)},{"t":3000,"org":"x","u":{"fh":30`;
    expect(parsePlanUsageTail(chunk)?.shortWindowPercent).toBe(20);
  });

  it('does not mistake the nested usage object for a sample', () => {
    // {"fh":..,"sd":..} is encountered first when scanning backwards and has no t.
    expect(parsePlanUsageTail(sample(1000, 10, 1))?.at.getTime()).toBe(1000);
  });

  it('handles braces inside strings', () => {
    const chunk = `{"t":1000,"org":"}{weird}","u":{"fh":11,"sd":2}}]}`;
    expect(parsePlanUsageTail(chunk)?.shortWindowPercent).toBe(11);
  });

  it('returns null when nothing complete is in the chunk', () => {
    expect(parsePlanUsageTail('"t":3000,"u":{"fh":3')).toBe(null);
    expect(parsePlanUsageTail('')).toBe(null);
  });

  it('never carries the org identifier out', () => {
    const usage = parsePlanUsageTail(`${sample(1000, 10, 1)}]}`);
    expect(JSON.stringify(usage)).not.toContain(ORG);
  });
});

describe('createPlanUsageReader', () => {
  let dir: string;
  let filePath: string;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cdp-plan-'));
    filePath = path.join(dir, PLAN_USAGE_FILENAME);
    clock = 1_000_000;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function reader(logger?: Logger) {
    return createPlanUsageReader({ filePath, now: () => clock, ...(logger ? { logger } : {}) });
  }

  it('reads the newest sample', async () => {
    writeFileSync(filePath, file([sample(1000, 10, 1), sample(2000, 55, 22)]), 'utf8');

    const usage = await reader().read();
    expect(usage?.shortWindowPercent).toBe(55);
    expect(usage?.longWindowPercent).toBe(22);
  });

  describe('caching', () => {
    it('does not touch the disk again inside the interval', async () => {
      writeFileSync(filePath, file([sample(1000, 10, 1)]), 'utf8');
      const r = reader();
      expect((await r.read())?.shortWindowPercent).toBe(10);

      writeFileSync(filePath, file([sample(2000, 99, 9)]), 'utf8');
      clock += READ_INTERVAL_MS - 1;
      expect((await r.read())?.shortWindowPercent).toBe(10);
    });

    it('re-reads once the interval has passed', async () => {
      writeFileSync(filePath, file([sample(1000, 10, 1)]), 'utf8');
      const r = reader();
      await r.read();

      writeFileSync(filePath, file([sample(2000, 99, 9)]), 'utf8');
      clock += READ_INTERVAL_MS;
      expect((await r.read())?.shortWindowPercent).toBe(99);
    });

    it('exposes the last value without a read', async () => {
      writeFileSync(filePath, file([sample(1000, 10, 1)]), 'utf8');
      const r = reader();
      await r.read();
      expect(r.last?.shortWindowPercent).toBe(10);
    });
  });

  describe('missing versus mid-write', () => {
    it('returns null when the file does not exist', async () => {
      expect(await reader().read()).toBe(null);
    });

    it('goes back to null if the file disappears later', async () => {
      writeFileSync(filePath, file([sample(1000, 10, 1)]), 'utf8');
      const r = reader();
      await r.read();

      rmSync(filePath);
      clock += READ_INTERVAL_MS;

      expect(await r.read()).toBe(null);
      expect(r.last).toBe(null);
    });

    it('keeps the last known value when the file is caught mid-write', async () => {
      writeFileSync(filePath, file([sample(1000, 55, 22)]), 'utf8');
      const { logger, warn } = fakeLogger();
      const r = reader(logger);
      expect((await r.read())?.shortWindowPercent).toBe(55);

      // Truncated write.
      writeFileSync(filePath, '{"version":2,"samples":[{"t":2000,"org":"x","u":{"fh', 'utf8');
      clock += READ_INTERVAL_MS;

      const usage = await r.read();
      expect(usage?.shortWindowPercent).toBe(55);
      expect(warn).toHaveBeenCalled();
    });

    it('keeps the last known value when the file becomes unreadable', async () => {
      writeFileSync(filePath, file([sample(1000, 42, 4)]), 'utf8');
      const r = reader();
      await r.read();

      rmSync(filePath);
      mkdirSync(filePath);
      clock += READ_INTERVAL_MS;

      expect((await r.read())?.shortWindowPercent).toBe(42);
    });

    it('returns null when APPDATA is not available', async () => {
      const r = createPlanUsageReader({ filePath: null, now: () => clock });
      expect(await r.read()).toBe(null);
    });
  });

  describe('large files', () => {
    it('reads only the tail past the size limit', async () => {
      // A realistic shape: a huge run of old samples, then the newest at the end.
      const padding = Array.from({ length: 90_000 }, (_, i) => sample(i, 1, 1)).join(',');
      const contents = `{"version":2,"samples":[${padding},${sample(9_999_999, 77, 33)}]}`;
      expect(contents.length).toBeGreaterThan(LARGE_FILE_BYTES);
      writeFileSync(filePath, contents, 'utf8');

      const usage = await reader().read();
      expect(usage?.shortWindowPercent).toBe(77);
      expect(usage?.longWindowPercent).toBe(33);
    });

    it('still parses the whole file below the limit', async () => {
      // Below the limit the newest sample is found by t, wherever it sits.
      const contents = file([sample(9000, 88, 8), sample(1000, 10, 1)]);
      writeFileSync(filePath, contents, 'utf8');

      expect((await reader().read())?.shortWindowPercent).toBe(88);
    });
  });

  describe('privacy', () => {
    it('never puts the org identifier in the returned value', async () => {
      writeFileSync(filePath, file([sample(1000, 55, 22)]), 'utf8');
      expect(JSON.stringify(await reader().read())).not.toContain(ORG);
    });

    it('never puts file content — and so never the org — in the daemon log', async () => {
      writeFileSync(filePath, `{"version":2,"samples":[{"t":1,"org":"${ORG}","u":{"fh`, 'utf8');
      const { logger, warn } = fakeLogger();
      await reader(logger).read();

      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(ORG);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('samples');
    });

    it('throttles warnings so a broken file cannot flood the log', async () => {
      writeFileSync(filePath, '{"samples":[{"t":1,"u":{', 'utf8');
      const { logger, warn } = fakeLogger();
      const r = reader(logger);

      for (let i = 0; i < 20; i += 1) {
        await r.read();
        clock += READ_INTERVAL_MS;
      }

      expect(warn.mock.calls.length).toBeLessThan(5);
    });
  });
});
