import { describe, expect, it } from 'vitest';

import {
  BASELINE_PERCENTILE,
  MIN_BUSY_RATIO,
  PHASE_INSTRUCTIONS,
  analyse,
  formatReport,
  runCalibration,
  summarisePhase,
} from '../src/calibrate.js';
import { busyThreshold } from '../src/state.js';
import type { BusyCalibration } from '../src/state.js';
import type { ClaudeProcessInfo, ProcessSampler } from '../src/sources/process.js';

const OFFLINE: ClaudeProcessInfo = {
  running: false,
  mainPid: null,
  allPids: [],
  startTime: null,
  cpuPercent: 0,
};

/** A sampler that replays a fixed list of CPU readings, then reports "not running". */
function scriptedSampler(values: readonly number[], cores = 12): ProcessSampler {
  let index = 0;
  let last: ClaudeProcessInfo = OFFLINE;
  return {
    get last() {
      return last;
    },
    cores: () => Promise.resolve(cores),
    sample: () => {
      const value = values[index++];
      last =
        value === undefined
          ? OFFLINE
          : { running: true, mainPid: 1, allPids: [1], startTime: new Date(0), cpuPercent: value };
      return Promise.resolve(last);
    },
  };
}

/** Runs both phases on a virtual clock. */
async function calibrate(script: readonly number[], idleMs = 4000, busyMs = 6000) {
  let clock = 0;
  return runCalibration({
    idleDurationMs: idleMs,
    busyDurationMs: busyMs,
    intervalMs: 1000,
    sampler: scriptedSampler(script),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  });
}

describe('summarisePhase', () => {
  it('reports the distribution in percent of one core', () => {
    const stats = summarisePhase([0.1, 0.2, 0.3, 1, 2, 3, 4, 5, 20, 40]);

    expect(stats.samples).toBe(10);
    expect(stats.min).toBeCloseTo(0.1, 2);
    expect(stats.max).toBeCloseTo(40, 2);
    expect(stats.median).toBeCloseTo(2.5, 2);
    expect(stats.p90).toBeGreaterThan(stats.median);
  });

  it('handles an empty phase', () => {
    expect(summarisePhase([]).samples).toBe(0);
  });
});

describe('analyse', () => {
  const idle = Array<number>(15).fill(0.32);
  const busy = Array<number>(30).fill(3.9);

  it('places the threshold 40 % of the way from the floor to the busy median', () => {
    const result = analyse(idle, busy, 12);

    // 0.32 + 0.4 * (3.9 - 0.32) = 1.752
    expect(result.floor).toBeCloseTo(0.32, 2);
    expect(result.threshold).toBeCloseTo(1.75, 1);
    expect(result.valid).toBe(true);
  });

  it('produces config values that fire on the measured work but not on idle', () => {
    const result = analyse(idle, busy, 12);
    const calibration: BusyCalibration = {
      baselineWindowSec: 300,
      baselinePercentile: result.suggestion.baselinePercentile,
      thresholdMultiplier: result.suggestion.thresholdMultiplier,
      thresholdDeltaPercent: result.suggestion.thresholdDeltaPercent,
      exitFactor: 0.6,
    };

    const threshold = busyThreshold(result.floor, calibration);
    expect(3.9).toBeGreaterThan(threshold);
    expect(0.32).toBeLessThan(threshold);
  });

  it('reads the floor at the same percentile the daemon uses at runtime', () => {
    expect(BASELINE_PERCENTILE).toBe(10);
    expect(analyse(idle, busy, 12).suggestion.baselinePercentile).toBe(BASELINE_PERCENTILE);
  });

  it('rejects the result when phase 2 never rose above the floor', () => {
    // The user did not send Claude anything in phase 2.
    const result = analyse(idle, Array<number>(30).fill(0.35), 12);

    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('Phase 2');
  });

  it('accepts exactly at the ratio boundary and rejects just below it', () => {
    const floor = 1;
    const flat = Array<number>(15).fill(floor);

    const atBoundary = analyse(flat, Array<number>(10).fill(floor * MIN_BUSY_RATIO + 0.01), 12);
    const below = analyse(flat, Array<number>(10).fill(floor * MIN_BUSY_RATIO - 0.01), 12);

    expect(atBoundary.valid).toBe(true);
    expect(below.valid).toBe(false);
  });

  it('rejects a near-zero phase 2 even though the ratio rule would pass', () => {
    // Floor 0 makes "median < 1.5 * floor" vacuously false; without an absolute
    // check, measuring nothing at all would count as a valid calibration.
    const result = analyse(Array<number>(15).fill(0), Array<number>(30).fill(0), 12);

    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('never started working');
  });

  it('rejects the result when Claude was not running', () => {
    expect(analyse([], [], 12).valid).toBe(false);
    expect(analyse(idle, [], 12).invalidReason).toContain('not running');
  });

  it('keeps the multiplier in a sane range with a near-zero floor', () => {
    const result = analyse(Array<number>(15).fill(0.001), Array<number>(30).fill(50), 12);

    expect(result.suggestion.thresholdMultiplier).toBeGreaterThanOrEqual(1.5);
    expect(result.suggestion.thresholdMultiplier).toBeLessThanOrEqual(100);
    expect(result.suggestion.thresholdDeltaPercent).toBeGreaterThan(0);
  });

  it('would not have been fooled by the single-phase run that measured a 1.69 % floor', () => {
    // The old one-phase calibration never saw Claude go quiet, so it called 1.69 %
    // the idle floor. With the phases separated, an idle phase that is genuinely
    // idle produces a much lower floor from the same busy readings.
    const result = analyse(Array<number>(15).fill(0.32), Array<number>(30).fill(2.91), 12);

    expect(result.floor).toBeLessThan(1);
    expect(result.valid).toBe(true);
  });
});

describe('formatReport', () => {
  const idle = Array<number>(15).fill(0.32);
  const busy = Array<number>(30).fill(3.9);

  it('prints both phases and a pasteable config block', () => {
    const report = formatReport(analyse(idle, busy, 12));

    expect(report).toContain('Phase 1 — idle');
    expect(report).toContain('Phase 2 — working');
    expect(report).toContain('percent of ONE core');
    expect(report).toContain('idle floor');
    expect(report).toContain('"busy": {');
    expect(report).toContain('12 cores');
  });

  it('the config block it prints is valid JSON', () => {
    const report = formatReport(analyse(idle, busy, 12));
    const block = report.slice(report.indexOf('  "busy": {'));
    const parsed: unknown = JSON.parse('{' + block + '}');

    expect(parsed).toHaveProperty('busy.thresholdMultiplier');
  });

  it('says the result is unusable rather than dressing it up', () => {
    const report = formatReport(analyse(idle, Array<number>(30).fill(0.33), 12));

    expect(report).toContain('RESULT NOT USABLE');
    expect(report).not.toContain('"busy": {');
    expect(report).toContain('phase 2');
  });
});

describe('runCalibration', () => {
  it('samples both phases separately', async () => {
    // 4 idle samples, then 6 busy ones (the first sample of each phase is the
    // reference point and produces no reading).
    const result = await calibrate([0, 0.3, 0.3, 0.3, 0.3, 0, 4, 4, 4, 4, 4, 4]);

    expect(result.idle.samples).toBe(4);
    expect(result.busy.samples).toBe(6);
    expect(result.idle.median).toBeCloseTo(0.3, 2);
    expect(result.busy.median).toBeCloseTo(4, 2);
    expect(result.cores).toBe(12);
  });

  it('announces each phase with an instruction the user can follow', async () => {
    const announced: [number, string][] = [];
    let clock = 0;

    await runCalibration({
      idleDurationMs: 2000,
      busyDurationMs: 2000,
      intervalMs: 1000,
      sampler: scriptedSampler([0, 0.3, 0.3, 0, 4, 4]),
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      announce: (phase, instruction) => {
        announced.push([phase, instruction]);
        return Promise.resolve();
      },
    });

    expect(announced.map(([phase]) => phase)).toEqual([1, 2]);
    expect(announced[0]?.[1]).toContain('leave Claude alone');
    expect(announced[1]?.[1]).toContain('long prompt');
  });

  it('skips samples taken while Claude is not running', async () => {
    const result = await calibrate([0, 1, 2], 4000, 4000);

    expect(result.idle.samples).toBe(2);
    expect(result.busy.samples).toBe(0);
    expect(result.valid).toBe(false);
  });

  it('reports progress per phase', async () => {
    const seen: [number, number][] = [];
    let clock = 0;

    await runCalibration({
      idleDurationMs: 2000,
      busyDurationMs: 2000,
      intervalMs: 1000,
      sampler: scriptedSampler([0, 0.3, 0.4, 0, 5, 6]),
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      onProgress: (phase, _elapsed, cpu) => seen.push([phase, cpu]),
    });

    expect(seen).toEqual([
      [1, 0.3],
      [1, 0.4],
      [2, 5],
      [2, 6],
    ]);
  });
});

describe('PHASE_INSTRUCTIONS', () => {
  it('tells the user what to do, not what the code is doing', () => {
    expect(PHASE_INSTRUCTIONS[1]).toMatch(/leave Claude alone/i);
    expect(PHASE_INSTRUCTIONS[2]).toMatch(/generate/i);
  });
});
