import { describe, expect, it } from 'vitest';

import { formatReport, runCalibration, suggest, summarise } from '../src/calibrate.js';
import { busyThreshold } from '../src/state.js';
import type { BusyCalibration } from '../src/state.js';
import type { ClaudeProcessInfo, ProcessSampler } from '../src/sources/process.js';

/** A sampler that replays a fixed list of CPU readings. */
function scriptedSampler(values: readonly number[], cores = 12): ProcessSampler {
  let index = 0;
  let last: ClaudeProcessInfo = {
    running: false,
    mainPid: null,
    allPids: [],
    startTime: null,
    cpuPercent: 0,
  };
  return {
    get last() {
      return last;
    },
    cores: () => Promise.resolve(cores),
    sample: () => {
      const value = values[index++];
      last =
        value === undefined
          ? { running: false, mainPid: null, allPids: [], startTime: null, cpuPercent: 0 }
          : { running: true, mainPid: 1, allPids: [1], startTime: new Date(0), cpuPercent: value };
      return Promise.resolve(last);
    },
  };
}

describe('summarise', () => {
  it('reports the distribution in percent of one core', () => {
    const stats = summarise([0.1, 0.2, 0.3, 1, 2, 3, 4, 5, 20, 40], 12);

    expect(stats.samples).toBe(10);
    expect(stats.cores).toBe(12);
    expect(stats.min).toBeCloseTo(0.1, 2);
    expect(stats.max).toBeCloseTo(40, 2);
    expect(stats.median).toBeCloseTo(2.5, 2);
    expect(stats.p90).toBeGreaterThan(stats.median);
    expect(stats.baseline).toBeLessThan(stats.median);
  });

  it('handles an empty sample list', () => {
    const stats = summarise([], 12);
    expect(stats.samples).toBe(0);
    expect(stats.max).toBe(0);
  });
});

describe('suggest', () => {
  it('puts the threshold between the idle floor and the busy band', () => {
    // Shaped like the target machine: idle around 0.3, work around 4.
    const values = [...Array<number>(40).fill(0.3), ...Array<number>(10).fill(4)];
    const stats = summarise(values, 12);
    const suggestion = suggest(stats);

    expect(suggestion.effectiveThreshold).toBeGreaterThan(stats.baseline);
    expect(suggestion.effectiveThreshold).toBeLessThan(stats.p90);
  });

  it('produces config values that actually fire on the measured work', () => {
    const values = [...Array<number>(40).fill(0.32), ...Array<number>(10).fill(3.9)];
    const stats = summarise(values, 12);
    const suggestion = suggest(stats);

    const calibration: BusyCalibration = {
      baselineWindowSec: 300,
      baselinePercentile: suggestion.baselinePercentile,
      thresholdMultiplier: suggestion.thresholdMultiplier,
      thresholdDeltaPercent: suggestion.thresholdDeltaPercent,
      exitFactor: 0.6,
    };

    const threshold = busyThreshold(stats.baseline, calibration);
    expect(3.9).toBeGreaterThan(threshold);
    expect(0.32).toBeLessThan(threshold);
  });

  it('flags a low-contrast sample (calibrated while idle)', () => {
    const stats = summarise(Array<number>(50).fill(0.3), 12);
    expect(suggest(stats).lowContrast).toBe(true);
  });

  it('does not flag a sample with real spread', () => {
    const values = [...Array<number>(40).fill(0.3), ...Array<number>(10).fill(30)];
    expect(suggest(summarise(values, 12)).lowContrast).toBe(false);
  });

  it('never recommends a threshold idle noise alone would reach', () => {
    const stats = summarise(Array<number>(50).fill(0), 12);
    const suggestion = suggest(stats);

    expect(suggestion.effectiveThreshold).toBeGreaterThanOrEqual(0.5);
    expect(suggestion.thresholdDeltaPercent).toBeGreaterThan(0);
  });

  it('keeps the multiplier in a sane range even with a near-zero baseline', () => {
    const values = [...Array<number>(45).fill(0.001), ...Array<number>(5).fill(50)];
    const suggestion = suggest(summarise(values, 12));

    expect(suggestion.thresholdMultiplier).toBeGreaterThanOrEqual(1.5);
    expect(suggestion.thresholdMultiplier).toBeLessThanOrEqual(100);
  });
});

describe('formatReport', () => {
  it('prints the distribution and a pasteable config block', () => {
    const values = [...Array<number>(40).fill(0.3), ...Array<number>(10).fill(4)];
    const stats = summarise(values, 12);
    const report = formatReport(stats, suggest(stats));

    expect(report).toContain('percent of ONE core');
    expect(report).toContain('idle floor');
    expect(report).toContain('"busy": {');
    expect(report).toContain('"thresholdDeltaPercent"');
    expect(report).toContain('12 cores');
  });

  it('the config block it prints is valid JSON', () => {
    const values = [...Array<number>(40).fill(0.3), ...Array<number>(10).fill(4)];
    const stats = summarise(values, 12);
    const report = formatReport(stats, suggest(stats));

    const start = report.indexOf('  "busy": {');
    const block = report.slice(start);
    const parsed: unknown = JSON.parse('{' + block + '}');

    expect(parsed).toHaveProperty('busy.thresholdMultiplier');
  });

  it('says so plainly when Claude was not running', () => {
    const report = formatReport(summarise([], 12), suggest(summarise([], 12)));
    expect(report).toContain('does not appear to be running');
  });

  it('warns when the sample has no contrast', () => {
    const stats = summarise(Array<number>(50).fill(0.3), 12);
    expect(formatReport(stats, suggest(stats))).toContain('WARNING');
  });
});

describe('runCalibration', () => {
  it('collects samples for the requested duration', async () => {
    let clock = 0;
    const { stats } = await runCalibration({
      durationMs: 10_000,
      intervalMs: 1000,
      sampler: scriptedSampler([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
    });

    expect(stats.samples).toBe(10);
    expect(stats.cores).toBe(12);
  });

  it('skips samples taken while Claude is not running', async () => {
    let clock = 0;
    const { stats } = await runCalibration({
      durationMs: 5000,
      intervalMs: 1000,
      // First sample is the reference point; then only 3 readings before the
      // scripted list runs out and the sampler reports "not running".
      sampler: scriptedSampler([0, 1, 2, 3]),
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
    });

    expect(stats.samples).toBe(3);
  });

  it('reports progress', async () => {
    let clock = 0;
    const seen: number[] = [];
    await runCalibration({
      durationMs: 3000,
      intervalMs: 1000,
      sampler: scriptedSampler([0, 5, 6, 7]),
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      onProgress: (_elapsed, cpu) => seen.push(cpu),
    });

    expect(seen).toEqual([5, 6, 7]);
  });
});
