import { describe, expect, it } from 'vitest';

import {
  BASELINE_PERCENTILE,
  BUSY_EDGE_PERCENTILE,
  CONSERVATIVE_MULTIPLIER,
  IDLE_EDGE_PERCENTILE,
  MIN_BUSY_RATIO,
  MULTIPLIER_HEADROOM,
  PHASE_INSTRUCTIONS,
  analyse,
  busyBlockLines,
  formatReport,
  runCalibration,
  summarisePhase,
} from '../src/calibrate.js';
import { BUSY_DEFAULTS, parseConfig } from '../src/config.js';
import { MEASURED_IDLE, MEASURED_WORK } from '../src/measurement.js';
import { percentile } from '../src/sources/process.js';
import { busyThreshold } from '../src/state.js';
import type { BusyCalibration } from '../src/state.js';
import { scriptedSampler } from './helpers/samplers.js';

/** analyse rounds to two decimals; the tests compare against the same rounding. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** The wall clock the recording tests pin, so sample timestamps are predictable. */
const RUN_STARTED_AT = new Date('2026-09-07T09:00:00.000Z');

/** Runs both phases on a virtual clock, returning the whole run. */
async function calibrateRun(script: readonly number[], idleMs = 4000, busyMs = 6000) {
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
    startedAt: () => RUN_STARTED_AT,
  });
}

/** Just the analysis, for the tests that do not care about the readings. */
async function calibrate(script: readonly number[], idleMs = 4000, busyMs = 6000) {
  return (await calibrateRun(script, idleMs, busyMs)).result;
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

  it('places the threshold midway between the two edges, not at a chosen fraction', () => {
    const result = analyse(idle, busy, 12);

    // Both phases are flat, so p95 of idle is 0.32 and p5 of work is 3.9.
    expect(result.floor).toBeCloseTo(0.32, 2);
    expect(result.idleEdge).toBeCloseTo(0.32, 2);
    expect(result.busyEdge).toBeCloseTo(3.9, 2);
    expect(result.threshold).toBeCloseTo((0.32 + 3.9) / 2, 2);
    expect(result.valid).toBe(true);
  });

  it('reads the two edges at the documented percentiles', () => {
    const result = analyse(MEASURED_IDLE, MEASURED_WORK, 12);

    expect(result.idleEdge).toBe(round2(percentile(MEASURED_IDLE, IDLE_EDGE_PERCENTILE)));
    expect(result.busyEdge).toBe(round2(percentile(MEASURED_WORK, BUSY_EDGE_PERCENTILE)));
    expect(result.threshold).toBe(round2((result.idleEdge + result.busyEdge) / 2));
  });

  it('does not depend on the busy median any more', () => {
    // The old rule keyed off the median, so stretching the top of phase 2 moved the
    // threshold. The edges do not care what happens well above the bottom of work.
    const stretched = [...busy.slice(0, -1), 40];
    const before = analyse(idle, busy, 12).threshold;
    const after = analyse(idle, stretched, 12).threshold;

    expect(after).toBe(before);
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
    // Not a restated literal: this is the same constant the config schema defaults to.
    expect(BASELINE_PERCENTILE).toBe(BUSY_DEFAULTS.baselinePercentile);
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

describe('analyse — against the measured machine', () => {
  const result = analyse(MEASURED_IDLE, MEASURED_WORK, 12);

  it('finds the measured idle floor', () => {
    expect(result.floor).toBeCloseTo(1.07, 1);
    expect(result.valid).toBe(true);
  });

  it('does not derive the multiplier as threshold / floor', () => {
    // That is what it used to do, and on this data it produced 4.2. Multiplied by a
    // runtime floor of 2.3 that lands at 9.66 — above the median of real work — and
    // BUSY stops happening at all.
    expect(result.suggestion.thresholdMultiplier).not.toBeCloseTo(4.2, 1);
    expect(result.suggestion.thresholdMultiplier).toBe(CONSERVATIVE_MULTIPLIER);
  });

  it('still fires on real work after the floor has drifted upwards', () => {
    const drifted = busyThreshold(2.3, result.suggestion);
    expect(drifted).toBeLessThan(result.busy.median);
  });

  it('keeps the delta in charge, with the multiplier as the safety net', () => {
    const atMeasuredFloor = busyThreshold(result.floor, result.suggestion);

    // The delta path decides here; the multiplier path is well below it.
    expect(result.floor + result.suggestion.thresholdDeltaPercent).toBeCloseTo(atMeasuredFloor, 1);
    expect(result.floor * result.suggestion.thresholdMultiplier).toBeLessThan(atMeasuredFloor);
  });

  it('derives an exit threshold above the worst idle sample', () => {
    // A fixed 0.6 would land below the idle max here, and an ordinary idle spike would
    // keep BUSY latched forever. The exact factor is derived, so it is not restated.
    expect(result.suggestion.exitFactor).toBeGreaterThan(BUSY_DEFAULTS.exitFactor);
    expect(result.exitThreshold).toBeGreaterThan(result.idle.max);
    expect(result.threshold * BUSY_DEFAULTS.exitFactor).toBeLessThan(result.idle.max);
    expect(result.hysteresisDisabled).toBe(false);
  });

  it('separates idle from work with no overlap', () => {
    expect(result.overlapping).toBe(false);
    expect(result.separation).toBeGreaterThan(0);
    expect(result.threshold).toBeGreaterThan(result.idle.max);
    expect(result.threshold).toBeLessThan(result.busy.min);
  });
});

describe('analyse — separation between the two phases', () => {
  it('reports clean separation on the measured machine', () => {
    const result = analyse(MEASURED_IDLE, MEASURED_WORK, 12);

    expect(result.idleEdge).toBeLessThan(result.busyEdge);
    expect(result.separation).toBe(round2(result.busyEdge - result.idleEdge));
    expect(result.overlapping).toBe(false);
    expect(formatReport(result)).not.toContain('overlap');
  });

  it('flags distributions that overlap, and still returns a usable-looking config', () => {
    // Phase 2 rose well clear of the floor, so the existing check passes: the user did
    // send Claude something. Idle just reaches into it, which is a different problem
    // and used to go entirely unreported.
    const noisyIdle = [1, 1.2, 1.4, 1.6, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9];
    const work = [5, 6, 7, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13];

    const result = analyse(noisyIdle, work, 12);

    expect(result.valid).toBe(true);
    expect(result.invalidReason).toBeNull();
    expect(result.overlapping).toBe(true);
    expect(result.separation).toBeLessThanOrEqual(0);
  });

  it('says so in the report, distinctly from RESULT NOT USABLE', () => {
    const noisyIdle = [1, 1.2, 1.4, 1.6, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9];
    const work = [5, 6, 7, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13];

    const report = formatReport(analyse(noisyIdle, work, 12));

    expect(report).toContain('WARNING: idle and working overlap');
    expect(report).not.toContain('RESULT NOT USABLE');
    // The suggestion is still printed: it is the best available guess, and the warning
    // says as much rather than leaving the user with nothing.
    expect(report).toContain('"busy": {');
  });

  it('does not confuse overlap with a phase 2 that never happened', () => {
    // Phase 2 flat on the floor: invalid, and no overlap warning to muddy the message.
    const flat = Array<number>(15).fill(0.32);
    const report = formatReport(analyse(flat, Array<number>(30).fill(0.33), 12));

    expect(report).toContain('RESULT NOT USABLE');
    expect(report).not.toContain('WARNING: idle and working overlap');
  });

  it('does not claim overlap when a phase is empty', () => {
    // Nothing was sampled, so there is nothing to overlap. That case is already
    // reported as invalid and must not pick up a second, misleading complaint.
    expect(analyse([], [], 12).overlapping).toBe(false);
    expect(analyse(Array<number>(15).fill(1), [], 12).overlapping).toBe(false);
  });

  it('prints both edges so the reader can check the separation themselves', () => {
    const report = formatReport(analyse(MEASURED_IDLE, MEASURED_WORK, 12));

    expect(report).toContain(`idle edge`);
    expect(report).toContain(`work edge`);
    expect(report).toContain(`(p${IDLE_EDGE_PERCENTILE} of phase 1)`);
    expect(report).toContain(`(p${BUSY_EDGE_PERCENTILE} of phase 2)`);
  });
});

describe('analyse — multiplier cap', () => {
  it('pulls the multiplier down when the floor is high enough to matter', () => {
    // floor 4, work median 12: 4 * 2.5 = 10 would sit right on top of real work.
    const result = analyse(Array<number>(15).fill(4), Array<number>(30).fill(12), 12);

    expect(result.multiplierCapped).toBe(true);
    expect(result.floor * result.suggestion.thresholdMultiplier).toBeLessThanOrEqual(
      result.busy.median * MULTIPLIER_HEADROOM + 0.01
    );
  });

  it('leaves it alone when the floor is low', () => {
    const result = analyse(MEASURED_IDLE, MEASURED_WORK, 12);
    expect(result.multiplierCapped).toBe(false);
  });

  it('never goes below the schema minimum', () => {
    // An absurd floor: no multiplier can satisfy the headroom rule.
    const result = analyse(Array<number>(15).fill(50), Array<number>(30).fill(80), 12);
    expect(result.suggestion.thresholdMultiplier).toBeGreaterThanOrEqual(1);
  });
});

describe('analyse — exit factor', () => {
  it('keeps the default when idle is far below the threshold', () => {
    const result = analyse(Array<number>(15).fill(0.3), Array<number>(30).fill(10), 12);
    expect(result.suggestion.exitFactor).toBe(BUSY_DEFAULTS.exitFactor);
  });

  it('raises it as the idle maximum approaches the threshold', () => {
    const noisyIdle = [...Array<number>(14).fill(1), 3.9];
    const result = analyse(noisyIdle, Array<number>(30).fill(10), 12);

    expect(result.suggestion.exitFactor).toBeGreaterThan(BUSY_DEFAULTS.exitFactor);
    expect(result.exitThreshold).toBeGreaterThan(result.idle.max);
  });

  it('caps at 1 and says so when idle reaches the trigger level', () => {
    const result = analyse([...Array<number>(14).fill(1), 20], Array<number>(30).fill(10), 12);

    expect(result.suggestion.exitFactor).toBeLessThanOrEqual(1);
    expect(result.hysteresisDisabled).toBe(true);
    expect(formatReport(result)).toContain('no room');
  });
});

describe('the emitted config block is accepted by the config schema', () => {
  // The check that catches this whole class of bug for good. The calibrator spent
  // several commits printing p10 / 300 s after the runtime had moved to p5 / 1800 s —
  // a block its own validator would have rejected outright.
  const cases: [string, readonly number[], readonly number[]][] = [
    ['the measured machine', MEASURED_IDLE, MEASURED_WORK],
    ['a quiet machine', Array<number>(15).fill(0.32), Array<number>(30).fill(3.9)],
    ['a noisy machine', Array<number>(15).fill(8), Array<number>(30).fill(30)],
    ['a high floor', Array<number>(15).fill(4), Array<number>(30).fill(12)],
    ['a near-zero floor', Array<number>(15).fill(0.001), Array<number>(30).fill(50)],
    ['a huge spread', Array<number>(15).fill(0.1), Array<number>(30).fill(180)],
  ];

  it.each(cases)('parseConfig accepts the suggestion for %s', (_label, idleValues, busyValues) => {
    const result = analyse(idleValues, busyValues, 12);
    const parsed = parseConfig({ clientId: '1234567890123456789', busy: result.suggestion });

    if (!parsed.ok)
      throw new Error('the calibrator emitted an invalid config: ' + parsed.problems.join('; '));
    expect(parsed.config.busy).toEqual(result.suggestion);
    expect(parsed.warnings).toEqual([]);
  });

  it.each(cases)(
    'the printed block parses and validates for %s',
    (_label, idleValues, busyValues) => {
      const report = formatReport(analyse(idleValues, busyValues, 12));
      const block = report.slice(report.indexOf('  "busy": {'));
      const fromText: unknown = JSON.parse('{' + block + '}');

      const parsed = parseConfig({ clientId: '1234567890123456789', ...(fromText as object) });
      if (!parsed.ok)
        throw new Error('the printed block is invalid: ' + parsed.problems.join('; '));
    }
  );

  it('emits exactly the keys the busy section has, no more and no fewer', () => {
    const result = analyse(MEASURED_IDLE, MEASURED_WORK, 12);

    expect(Object.keys(result.suggestion).sort()).toEqual(Object.keys(BUSY_DEFAULTS).sort());
  });

  it('busyBlockLines renders every key with valid JSON commas', () => {
    const lines = busyBlockLines(analyse(MEASURED_IDLE, MEASURED_WORK, 12).suggestion);

    expect(lines[0]).toBe('  "busy": {');
    expect(lines.at(-1)).toBe('  }');
    expect(lines.at(-2)?.endsWith(',')).toBe(false);
    expect(() => {
      JSON.parse('{' + lines.join('\n') + '}');
    }).not.toThrow();
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
