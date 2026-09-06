/**
 * `--calibrate` — measure this machine before trusting the BUSY detector.
 *
 * There is no CPU number that works everywhere. On the development machine real
 * agentic work sits at 3.9 % of one core; the original hardcoded threshold of 12 would
 * never have fired.
 *
 * Two phases, because one undirected minute cannot tell idle from busy — on the first
 * single-phase run the "idle floor" came out at 1.69 % purely because Claude never
 * actually went quiet during it:
 *
 *   phase 1 (30 s), user told to leave Claude alone  -> the floor
 *   phase 2 (60 s), user told to make it generate    -> the ceiling
 *   threshold = floor + 0.4 * (median(phase 2) - floor)
 *
 * If phase 2 does not come out clearly above the floor, the result is reported as
 * invalid rather than dressed up as a recommendation.
 */

import { createProcessSampler, percentile, sampleIntervalFor } from './sources/process.js';
import type { ProcessSampler } from './sources/process.js';

export const IDLE_PHASE_MS = 30_000;
export const BUSY_PHASE_MS = 60_000;
export const CALIBRATION_INTERVAL_MS = sampleIntervalFor('BUSY', 0);

/** Grace period before a phase starts, when there is no TTY to press Enter on. */
export const PHASE_LEAD_IN_MS = 5_000;

/** The floor is read at the same percentile the daemon uses at runtime. */
export const BASELINE_PERCENTILE = 10;

/** Where between the floor and the busy median the threshold is placed. */
export const THRESHOLD_POSITION = 0.4;

/** Phase 2 has to reach at least this multiple of the floor to count as a real sample. */
export const MIN_BUSY_RATIO = 1.5;

/** Below this there is nothing to measure, whatever the ratio says. */
const MIN_MEANINGFUL_PERCENT = 0.1;

export interface PhaseStats {
  samples: number;
  min: number;
  median: number;
  p90: number;
  max: number;
}

export interface CalibrationResult {
  cores: number;
  idle: PhaseStats;
  busy: PhaseStats;
  /** p10 of phase 1 — what the daemon's rolling baseline will settle on. */
  floor: number;
  /** Absolute level BUSY would trigger at, in percent of one core. */
  threshold: number;
  valid: boolean;
  /** Why the result was rejected; null when valid. */
  invalidReason: string | null;
  suggestion: {
    baselinePercentile: number;
    thresholdMultiplier: number;
    thresholdDeltaPercent: number;
  };
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function summarisePhase(values: readonly number[]): PhaseStats {
  return {
    samples: values.length,
    min: round(percentile(values, 0)),
    median: round(percentile(values, 50)),
    p90: round(percentile(values, 90)),
    max: round(percentile(values, 100)),
  };
}

/**
 * Turns the two phases into config values.
 *
 * The multiplier and the delta both encode the same absolute threshold, because the
 * daemon takes whichever is higher: the delta protects a near-zero floor, the
 * multiplier scales with a noisy one.
 */
export function analyse(
  idleValues: readonly number[],
  busyValues: readonly number[],
  cores: number
): CalibrationResult {
  const idle = summarisePhase(idleValues);
  const busy = summarisePhase(busyValues);
  const floor = round(percentile(idleValues, BASELINE_PERCENTILE));

  const threshold = round(floor + (busy.median - floor) * THRESHOLD_POSITION, 2);
  const delta = Math.max(0.1, round(threshold - floor, 1));
  const multiplier = floor > 0.05 ? Math.min(100, Math.max(1.5, round(threshold / floor, 1))) : 3;

  let invalidReason: string | null = null;
  if (idleValues.length === 0 || busyValues.length === 0) {
    invalidReason = 'Claude Desktop was not running for the whole measurement.';
  } else if (busy.median < MIN_MEANINGFUL_PERCENT) {
    invalidReason = 'Phase 2 recorded almost no CPU at all — Claude never started working.';
  } else if (busy.median < floor * MIN_BUSY_RATIO) {
    invalidReason =
      `Phase 2 (median ${busy.median.toFixed(2)} %) did not rise clearly above the ` +
      `idle floor (${floor.toFixed(2)} %). Phase 2 most likely did not happen — ` +
      'the prompt has to be long enough that Claude is still generating when the phase ends.';
  }

  return {
    cores,
    idle,
    busy,
    floor,
    threshold,
    valid: invalidReason === null,
    invalidReason,
    suggestion: {
      baselinePercentile: BASELINE_PERCENTILE,
      thresholdMultiplier: multiplier,
      thresholdDeltaPercent: delta,
    },
  };
}

export function formatReport(result: CalibrationResult): string {
  const lines: string[] = [];
  const phase = (name: string, stats: PhaseStats): void => {
    lines.push(`${name} (${stats.samples} samples)`);
    lines.push(
      `  min ${stats.min.toFixed(2)} %   median ${stats.median.toFixed(2)} %   p90 ${stats.p90.toFixed(2)} %   max ${stats.max.toFixed(2)} %`
    );
  };

  lines.push('');
  lines.push('Calibration result');
  lines.push('==================');
  lines.push('');
  lines.push(`Machine: ${result.cores} cores (context only; not part of the formula)`);
  lines.push('CPU used by claude.exe, in percent of ONE core:');
  lines.push('');
  phase('Phase 1 — idle', result.idle);
  phase('Phase 2 — working', result.busy);
  lines.push('');
  lines.push(`  idle floor   ${result.floor.toFixed(2)} %  (p${BASELINE_PERCENTILE} of phase 1)`);

  if (!result.valid) {
    lines.push('');
    lines.push('RESULT NOT USABLE');
    lines.push(`  ${result.invalidReason ?? ''}`);
    lines.push('');
    lines.push('Run --calibrate again. In phase 2, send Claude something that keeps it');
    lines.push('generating for the full minute — a long piece of writing, or a task with');
    lines.push('several tool calls.');
    return lines.join('\n');
  }

  lines.push(`  BUSY above   ${result.threshold.toFixed(2)} %`);
  lines.push('');
  lines.push('Paste into config.json:');
  lines.push('');
  lines.push('  "busy": {');
  lines.push('    "baselineWindowSec": 300,');
  lines.push(`    "baselinePercentile": ${result.suggestion.baselinePercentile},`);
  lines.push(`    "thresholdMultiplier": ${result.suggestion.thresholdMultiplier},`);
  lines.push(`    "thresholdDeltaPercent": ${result.suggestion.thresholdDeltaPercent},`);
  lines.push('    "exitFactor": 0.6');
  lines.push('  }');

  return lines.join('\n');
}

export interface CalibrateOptions {
  idleDurationMs?: number;
  busyDurationMs?: number;
  intervalMs?: number;
  sampler?: ProcessSampler;
  /** Called before each phase; resolves when the user is ready. */
  announce?: (phase: 1 | 2, instruction: string) => Promise<void>;
  onProgress?: (phase: 1 | 2, elapsedMs: number, cpuPercent: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const PHASE_INSTRUCTIONS: Record<1 | 2, string> = {
  1: 'Phase 1 (30 s) — leave Claude alone. Do not type anything to it.',
  2: 'Phase 2 (60 s) — send Claude a long prompt and let it generate the whole answer.',
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Runs both phases and returns the analysis. */
export async function runCalibration(options: CalibrateOptions = {}): Promise<CalibrationResult> {
  const idleDurationMs = options.idleDurationMs ?? IDLE_PHASE_MS;
  const busyDurationMs = options.busyDurationMs ?? BUSY_PHASE_MS;
  const intervalMs = options.intervalMs ?? CALIBRATION_INTERVAL_MS;
  const sampler = options.sampler ?? createProcessSampler();
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  const cores = await sampler.cores();

  async function samplePhase(phase: 1 | 2, durationMs: number): Promise<number[]> {
    await options.announce?.(phase, PHASE_INSTRUCTIONS[phase]);

    // The first sample only establishes the CpuMs reference point; it carries no delta.
    await sampler.sample();

    const values: number[] = [];
    const startedAt = now();
    while (now() - startedAt < durationMs) {
      await sleep(intervalMs);
      const info = await sampler.sample();
      if (!info.running) continue;
      values.push(info.cpuPercent);
      options.onProgress?.(phase, now() - startedAt, info.cpuPercent);
    }
    return values;
  }

  const idleValues = await samplePhase(1, idleDurationMs);
  const busyValues = await samplePhase(2, busyDurationMs);

  return analyse(idleValues, busyValues, cores);
}

/** Waits for Enter on a TTY, or just pauses when there is nothing to press it on. */
async function waitForReady(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log(`  starting in ${PHASE_LEAD_IN_MS / 1000} s...`);
    await defaultSleep(PHASE_LEAD_IN_MS);
    return;
  }
  console.log('  press Enter to start this phase');
  await new Promise<void>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
    process.stdin.resume();
  });
}

/** Entrypoint for `--calibrate`. Prints the report and returns the exit code. */
export async function calibrateCommand(): Promise<number> {
  console.log('Calibrating the BUSY detector. Two phases, about 90 seconds in total.');

  let lastPrint = 0;
  const result = await runCalibration({
    announce: async (_phase, instruction) => {
      lastPrint = 0;
      console.log('');
      console.log(instruction);
      await waitForReady();
    },
    onProgress: (_phase, elapsedMs, cpuPercent) => {
      if (elapsedMs - lastPrint < 10_000) return;
      lastPrint = elapsedMs;
      console.log(`  ${Math.round(elapsedMs / 1000)} s ... ${cpuPercent.toFixed(2)} % of one core`);
    },
  });

  console.log(formatReport(result));
  return result.valid ? 0 : 1;
}
