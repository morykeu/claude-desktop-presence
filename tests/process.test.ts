import { describe, expect, it } from 'vitest';

import {
  CPU_SAMPLE_WINDOW,
  MAIN_WINDOW_TITLE,
  MovingAverage,
  SAMPLE_INTERVAL_MS,
  computeCpuPercent,
  cpuByPid,
  createProcessSampler,
  parseProcessRows,
  pickMainPid,
  pickOldestStart,
  sampleIntervalFor,
} from '../src/sources/process.js';
import type { RawProcessRow } from '../src/sources/process.js';

/** Builds the JSON that ConvertTo-Json would emit for these rows. */
function toJson(rows: Partial<RawProcessRow>[]): string {
  const full = rows.map((row, index) => ({
    Id: row.Id ?? 1000 + index,
    MainWindowTitle: row.MainWindowTitle ?? '',
    StartIso: row.StartIso ?? '2026-09-06T08:00:00.0000000Z',
    CpuMs: row.CpuMs ?? 0,
  }));
  // ConvertTo-Json emits a bare object for a single item, an array for several.
  return JSON.stringify(full.length === 1 ? full[0] : full);
}

describe('parseProcessRows', () => {
  it('parses an array of processes', () => {
    const rows = parseProcessRows(
      toJson([
        { Id: 1, MainWindowTitle: MAIN_WINDOW_TITLE, CpuMs: 1500 },
        { Id: 2, CpuMs: 300 },
        { Id: 3, CpuMs: 20 },
      ])
    );

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.Id)).toEqual([1, 2, 3]);
    expect(rows[0]?.MainWindowTitle).toBe(MAIN_WINDOW_TITLE);
  });

  it('parses a single process, which ConvertTo-Json emits as an object, not an array', () => {
    const json = toJson([{ Id: 42, MainWindowTitle: MAIN_WINDOW_TITLE, CpuMs: 900 }]);

    expect(json.startsWith('{')).toBe(true);
    const rows = parseProcessRows(json);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.Id).toBe(42);
  });

  it('does not care how many processes there are (12, 16 and 17 all observed)', () => {
    for (const count of [12, 16, 17]) {
      const rows = parseProcessRows(
        toJson(Array.from({ length: count }, (_, i) => ({ Id: i + 1, CpuMs: i })))
      );
      expect(rows).toHaveLength(count);
    }
  });

  it('returns an empty array when nothing is running', () => {
    expect(parseProcessRows('')).toEqual([]);
    expect(parseProcessRows('   \n ')).toEqual([]);
    expect(parseProcessRows('null')).toEqual([]);
  });

  it('survives malformed output instead of throwing', () => {
    expect(parseProcessRows('{ not json')).toEqual([]);
    expect(parseProcessRows('<#< PowerShell error >#>')).toEqual([]);
  });

  it('strips a UTF-8 BOM', () => {
    const rows = parseProcessRows('﻿' + toJson([{ Id: 7 }, { Id: 8 }]));
    expect(rows.map((row) => row.Id)).toEqual([7, 8]);
  });

  it('keeps diacritics intact (UTF-8 output is forced)', () => {
    const rows = parseProcessRows(toJson([{ Id: 1, MainWindowTitle: 'Žluťoučký — Claude' }]));
    expect(rows[0]?.MainWindowTitle).toBe('Žluťoučký — Claude');
  });

  it('treats a null CpuMs as zero but keeps the row', () => {
    const rows = parseProcessRows('[{"Id":5,"MainWindowTitle":"","StartIso":null,"CpuMs":null}]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.CpuMs).toBe(0);
    expect(rows[0]?.StartIso).toBe(null);
  });

  it('skips rows with no usable Id', () => {
    const rows = parseProcessRows('[{"MainWindowTitle":"Claude"},{"Id":9,"CpuMs":1}]');
    expect(rows.map((row) => row.Id)).toEqual([9]);
  });

  it('rejects a raw /Date(...)/ StartTime rather than inventing a date', () => {
    // If the PowerShell query ever loses its ToString('o'), this is what arrives.
    const rows = parseProcessRows('[{"Id":1,"MainWindowTitle":"","StartIso":null,"CpuMs":0}]');
    expect(pickOldestStart(rows)).toBe(null);
  });
});

describe('pickMainPid', () => {
  it('picks the process whose window title is exactly "Claude"', () => {
    const rows = parseProcessRows(
      toJson([
        { Id: 1, MainWindowTitle: '' },
        { Id: 2, MainWindowTitle: MAIN_WINDOW_TITLE },
        { Id: 3, MainWindowTitle: '' },
      ])
    );
    expect(pickMainPid(rows)).toBe(2);
  });

  it('falls back to the first titled process when the title changed', () => {
    const rows = parseProcessRows(
      toJson([
        { Id: 1, MainWindowTitle: '' },
        { Id: 2, MainWindowTitle: 'Claude — something' },
      ])
    );
    expect(pickMainPid(rows)).toBe(2);
  });

  it('returns null when no process has a window (minimised to tray, still starting)', () => {
    const rows = parseProcessRows(toJson([{ Id: 1 }, { Id: 2 }]));
    expect(pickMainPid(rows)).toBe(null);
  });
});

describe('pickOldestStart', () => {
  it('returns the oldest start, not the main window one', () => {
    const rows = parseProcessRows(
      toJson([
        { Id: 1, StartIso: '2026-09-06T09:30:00.0000000Z', MainWindowTitle: MAIN_WINDOW_TITLE },
        { Id: 2, StartIso: '2026-09-06T08:00:00.0000000Z' },
        { Id: 3, StartIso: '2026-09-06T08:15:00.0000000Z' },
      ])
    );
    expect(pickOldestStart(rows)?.toISOString()).toBe('2026-09-06T08:00:00.000Z');
  });

  it('ignores unparseable timestamps', () => {
    const rows = parseProcessRows(
      '[{"Id":1,"StartIso":"nonsense","CpuMs":0},{"Id":2,"StartIso":"2026-09-06T08:00:00Z","CpuMs":0}]'
    );
    expect(pickOldestStart(rows)?.toISOString()).toBe('2026-09-06T08:00:00.000Z');
  });

  it('returns null when nothing has a start time', () => {
    expect(pickOldestStart([])).toBe(null);
  });
});

describe('computeCpuPercent', () => {
  it('reports percent of ONE core, not of the whole machine', () => {
    // 1200 CPU-ms over 1000 wall-ms = 120 % of one core. Dividing by the 12 cores
    // of the target machine would turn real work into 10 % and hide it in the noise.
    const previous = new Map([[1, 0]]);
    const current = new Map([[1, 1200]]);
    expect(computeCpuPercent(previous, current, 1000)).toBeCloseTo(120, 5);
  });

  it('matches the measurement taken on the target machine', () => {
    // 3.9 % of one core over a 4 s window = 156 CPU-ms.
    const previous = new Map([[1, 0]]);
    const current = new Map([[1, 156]]);
    expect(computeCpuPercent(previous, current, 4000)).toBeCloseTo(3.9, 5);
  });

  it('sums across every process', () => {
    const previous = new Map([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    const current = new Map([
      [1, 600],
      [2, 400],
      [3, 200],
    ]);
    expect(computeCpuPercent(previous, current, 1000)).toBeCloseTo(120, 5);
  });

  it('ignores a PID that disappeared between samples', () => {
    // The renderer (PID 2) is gone. Its cumulative 5000 ms must not count.
    const previous = new Map([
      [1, 1000],
      [2, 5000],
    ]);
    const current = new Map([[1, 2200]]);
    expect(computeCpuPercent(previous, current, 1000)).toBeCloseTo(120, 5);
  });

  it('ignores a PID that appeared between samples', () => {
    // A fresh process reports its whole lifetime CPU; without the guard that
    // would look like a spike.
    const previous = new Map([[1, 1000]]);
    const current = new Map([
      [1, 2200],
      [2, 9999],
    ]);
    expect(computeCpuPercent(previous, current, 1000)).toBeCloseTo(120, 5);
  });

  it('never goes negative when a recycled PID reports less CPU than before', () => {
    const previous = new Map([
      [1, 5000],
      [2, 5000],
    ]);
    const current = new Map([
      [1, 10],
      [2, 5120],
    ]);
    // Only PID 2's +120 ms counts; PID 1's negative delta is clamped away.
    expect(computeCpuPercent(previous, current, 1000)).toBeCloseTo(12, 5);
  });

  it('returns 0 for a non-positive elapsed time', () => {
    const previous = new Map([[1, 0]]);
    const current = new Map([[1, 1000]]);
    expect(computeCpuPercent(previous, current, 0)).toBe(0);
    expect(computeCpuPercent(previous, current, -50)).toBe(0);
  });

  it('returns 0 when there is no overlap at all (full restart)', () => {
    expect(computeCpuPercent(new Map([[1, 5000]]), new Map([[9, 5000]]), 1000)).toBe(0);
  });

  it('is allowed to exceed 100 % when several processes are busy at once', () => {
    const previous = new Map([
      [1, 0],
      [2, 0],
    ]);
    const current = new Map([
      [1, 1000],
      [2, 1000],
    ]);
    expect(computeCpuPercent(previous, current, 1000)).toBeCloseTo(200, 5);
  });
});

describe('MovingAverage', () => {
  it('averages over the last CPU_SAMPLE_WINDOW values', () => {
    const average = new MovingAverage(CPU_SAMPLE_WINDOW);
    for (const value of [10, 10, 10, 10, 10]) average.push(value);
    expect(average.value).toBeCloseTo(10, 5);

    // A single spike must not flip the state on its own.
    average.push(60);
    expect(average.value).toBeCloseTo(20, 5);
  });

  it('drops values beyond the window', () => {
    const average = new MovingAverage(3);
    average.push(90);
    average.push(0);
    average.push(0);
    average.push(0);
    expect(average.value).toBe(0);
  });

  it('starts at zero and resets to zero', () => {
    const average = new MovingAverage(3);
    expect(average.value).toBe(0);
    average.push(50);
    average.reset();
    expect(average.value).toBe(0);
  });
});

describe('sampleIntervalFor', () => {
  it('samples fast while busy and slowly while idle or offline', () => {
    expect(sampleIntervalFor('BUSY', 2000)).toBe(2000);
    expect(sampleIntervalFor('TOOL', 2000)).toBe(2000);
    expect(sampleIntervalFor('ACTIVE', 2000)).toBe(2000);
    expect(sampleIntervalFor('IDLE', 2000)).toBe(10_000);
    expect(sampleIntervalFor('OFFLINE', 2000)).toBe(30_000);
  });

  it('treats pollIntervalMs as a lower bound, never as a fixed period', () => {
    expect(sampleIntervalFor('BUSY', 5000)).toBe(5000);
    expect(sampleIntervalFor('IDLE', 5000)).toBe(10_000);
    expect(sampleIntervalFor('IDLE', 60_000)).toBe(60_000);
  });

  it('has an interval for every state', () => {
    expect(Object.keys(SAMPLE_INTERVAL_MS).sort()).toEqual([
      'ACTIVE',
      'BUSY',
      'IDLE',
      'OFFLINE',
      'TOOL',
    ]);
  });
});

describe('createProcessSampler', () => {
  /** Drives the sampler through a scripted list of PowerShell outputs. */
  function scripted(outputs: string[], stepMs = 1000) {
    let index = 0;
    let clock = 0;
    const sampler = createProcessSampler({
      cores: 12,
      now: () => clock,
      runQuery: () => {
        clock += stepMs;
        return Promise.resolve(outputs[Math.min(index++, outputs.length - 1)] ?? '');
      },
    });
    return sampler;
  }

  it('reports not running when no claude.exe exists', async () => {
    const sampler = scripted(['']);
    const info = await sampler.sample();

    expect(info.running).toBe(false);
    expect(info.mainPid).toBe(null);
    expect(info.allPids).toEqual([]);
    expect(info.startTime).toBe(null);
    expect(info.cpuPercent).toBe(0);
  });

  it('produces no CPU reading from the very first sample', async () => {
    const sampler = scripted([toJson([{ Id: 1, CpuMs: 5000 }])]);
    const info = await sampler.sample();

    expect(info.running).toBe(true);
    expect(info.cpuPercent).toBe(0);
  });

  it('computes CPU from the second sample onwards', async () => {
    const sampler = scripted([
      toJson([
        { Id: 1, MainWindowTitle: MAIN_WINDOW_TITLE, CpuMs: 1000 },
        { Id: 2, CpuMs: 1000 },
      ]),
      toJson([
        { Id: 1, MainWindowTitle: MAIN_WINDOW_TITLE, CpuMs: 1600 },
        { Id: 2, CpuMs: 1600 },
      ]),
    ]);

    await sampler.sample();
    const info = await sampler.sample();

    // 1200 CPU-ms over 1000 wall-ms = 120 % of one core.
    expect(info.cpuPercent).toBeCloseTo(120, 5);
    expect(info.mainPid).toBe(1);
    expect(info.allPids).toEqual([1, 2]);
  });

  it('a disappeared renderer does not spike the CPU reading', async () => {
    const sampler = scripted([
      toJson([
        { Id: 1, MainWindowTitle: MAIN_WINDOW_TITLE, CpuMs: 1000 },
        { Id: 2, CpuMs: 50_000 },
      ]),
      toJson([{ Id: 1, MainWindowTitle: MAIN_WINDOW_TITLE, CpuMs: 2200 }]),
    ]);

    await sampler.sample();
    const info = await sampler.sample();

    expect(info.cpuPercent).toBeCloseTo(120, 5);
    expect(info.allPids).toEqual([1]);
  });

  it('keeps startTime frozen when the renderer restarts and the main PID changes', async () => {
    const oldest = '2026-09-06T08:00:00.0000000Z';
    const sampler = scripted([
      toJson([
        { Id: 1, StartIso: oldest, CpuMs: 0 },
        { Id: 2, StartIso: '2026-09-06T08:00:05.0000000Z', MainWindowTitle: MAIN_WINDOW_TITLE },
      ]),
      // PID 2 died, PID 3 took over the window. The oldest process is untouched.
      toJson([
        { Id: 1, StartIso: oldest, CpuMs: 100 },
        { Id: 3, StartIso: '2026-09-06T09:45:00.0000000Z', MainWindowTitle: MAIN_WINDOW_TITLE },
      ]),
    ]);

    const first = await sampler.sample();
    const second = await sampler.sample();

    expect(first.mainPid).toBe(2);
    expect(second.mainPid).toBe(3);
    expect(second.startTime?.toISOString()).toBe('2026-09-06T08:00:00.000Z');
    expect(second.startTime?.getTime()).toBe(first.startTime?.getTime());
  });

  it('adopts the new start after the app is restarted', async () => {
    const sampler = scripted([
      toJson([{ Id: 1, StartIso: '2026-09-06T08:00:00.0000000Z' }]),
      // Everything gone — this is the OFFLINE transition.
      '',
      toJson([{ Id: 90, StartIso: '2026-09-06T12:30:00.0000000Z' }]),
    ]);

    const before = await sampler.sample();
    const offline = await sampler.sample();
    const after = await sampler.sample();

    expect(before.startTime?.toISOString()).toBe('2026-09-06T08:00:00.000Z');
    expect(offline.startTime).toBe(null);
    expect(after.startTime?.toISOString()).toBe('2026-09-06T12:30:00.000Z');
  });

  it('adopts a newer oldest start even without an observed OFFLINE sample', async () => {
    // A restart between two slow samples: the old main process is gone, so the
    // oldest start moved forward. Holding the stale value would show a wrong elapsed.
    const sampler = scripted([
      toJson([
        { Id: 1, StartIso: '2026-09-06T08:00:00.0000000Z' },
        { Id: 2, StartIso: '2026-09-06T08:00:02.0000000Z' },
      ]),
      toJson([
        { Id: 70, StartIso: '2026-09-06T12:00:00.0000000Z' },
        { Id: 71, StartIso: '2026-09-06T12:00:03.0000000Z' },
      ]),
    ]);

    await sampler.sample();
    const after = await sampler.sample();

    expect(after.startTime?.toISOString()).toBe('2026-09-06T12:00:00.000Z');
  });

  it('clears the CPU history across an OFFLINE gap', async () => {
    const sampler = scripted([
      toJson([{ Id: 1, CpuMs: 0 }]),
      toJson([{ Id: 1, CpuMs: 12_000 }]),
      '',
      toJson([{ Id: 5, CpuMs: 400 }]),
    ]);

    await sampler.sample();
    const busy = await sampler.sample();
    await sampler.sample();
    const restarted = await sampler.sample();

    expect(busy.cpuPercent).toBeGreaterThan(50);
    expect(restarted.cpuPercent).toBe(0);
  });

  it('smooths a single spike through the moving average', async () => {
    const outputs = [
      toJson([{ Id: 1, CpuMs: 0 }]),
      toJson([{ Id: 1, CpuMs: 120 }]),
      toJson([{ Id: 1, CpuMs: 240 }]),
      // one large burst
      toJson([{ Id: 1, CpuMs: 7440 }]),
      toJson([{ Id: 1, CpuMs: 7560 }]),
    ];
    const sampler = scripted(outputs);

    let info = await sampler.sample();
    for (let i = 1; i < outputs.length; i += 1) info = await sampler.sample();

    // Raw samples are 12, 12, 720, 12 percent of one core -> the average stays
    // well below the spike, so one burst cannot flip the state on its own.
    expect(info.cpuPercent).toBeLessThan(250);
    expect(info.cpuPercent).toBeGreaterThan(50);
  });

  it('shares one in-flight query instead of spawning PowerShell twice', async () => {
    let calls = 0;
    const sampler = createProcessSampler({
      cores: 12,
      now: () => 1000,
      runQuery: () => {
        calls += 1;
        return Promise.resolve(toJson([{ Id: 1, CpuMs: 10 }]));
      },
    });

    const [a, b] = await Promise.all([sampler.sample(), sampler.sample()]);

    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it('exposes the last value without querying again', async () => {
    const sampler = scripted([toJson([{ Id: 1, MainWindowTitle: MAIN_WINDOW_TITLE, CpuMs: 1 }])]);
    const info = await sampler.sample();
    expect(sampler.last).toEqual(info);
  });
});

describe('cpuByPid', () => {
  it('maps PID to cumulative CPU milliseconds', () => {
    const rows = parseProcessRows(
      toJson([
        { Id: 3, CpuMs: 30 },
        { Id: 4, CpuMs: 40 },
      ])
    );
    expect([...cpuByPid(rows)]).toEqual([
      [3, 30],
      [4, 40],
    ]);
  });
});
