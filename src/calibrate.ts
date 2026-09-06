/**
 * `--calibrate` — measure this machine before trusting the BUSY detector.
 *
 * There is no CPU number that works everywhere. On the target machine real agentic
 * work sits at 3.9 % of one core; the old hardcoded threshold of 12 would never have
 * fired. This mode samples for a minute and prints the distribution plus a config
 * snippet, so the numbers come from the machine rather than from a guess.
 */

import { createProcessSampler, percentile, sampleIntervalFor } from './sources/process.js';
import type { ProcessSampler } from './sources/process.js';

export const CALIBRATION_DURATION_MS = 60_000;
export const CALIBRATION_INTERVAL_MS = sampleIntervalFor('BUSY', 0);

export interface CalibrationStats {
  samples: number;
  cores: number;
  min: number;
  median: number;
  p90: number;
  max: number;
  /** The idle floor the daemon would settle on. */
  baseline: number;
}

export interface CalibrationSuggestion {
  baselinePercentile: number;
  thresholdMultiplier: number;
  thresholdDeltaPercent: number;
  /** The absolute level BUSY would trigger at, in percent of one core. */
  effectiveThreshold: number;
  /** True when the spread is too small to tell idle from busy. */
  lowContrast: boolean;
}

const BASELINE_PERCENTILE = 10;

/** Where between the idle floor and the busy band the threshold should sit. */
const THRESHOLD_POSITION = 0.4;

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function summarise(values: readonly number[], cores: number): CalibrationStats {
  return {
    samples: values.length,
    cores,
    min: round(percentile(values, 0)),
    median: round(percentile(values, 50)),
    p90: round(percentile(values, 90)),
    max: round(percentile(values, 100)),
    baseline: round(percentile(values, BASELINE_PERCENTILE)),
  };
}

/**
 * Turns the distribution into config values.
 *
 * The threshold is placed a fraction of the way from the idle floor (p10) up to the
 * busy band (p90). The multiplier is then whatever gets there from the baseline; the
 * delta carries the same level as an absolute floor, so a near-zero baseline cannot
 * make the multiplier trivially satisfied.
 */
export function suggest(stats: CalibrationStats): CalibrationSuggestion {
  const spread = Math.max(0, stats.p90 - stats.baseline);
  const target = stats.baseline + spread * THRESHOLD_POSITION;

  // Never recommend a threshold that idle noise alone would reach.
  const effectiveThreshold = Math.max(target, stats.baseline + 0.5, 0.5);
  const delta = round(effectiveThreshold - stats.baseline, 1);
  const multiplier =
    stats.baseline > 0.05
      ? Math.min(100, Math.max(1.5, round(effectiveThreshold / stats.baseline, 1)))
      : 3;

  return {
    baselinePercentile: BASELINE_PERCENTILE,
    thresholdMultiplier: multiplier,
    thresholdDeltaPercent: Math.max(0.1, delta),
    effectiveThreshold: round(effectiveThreshold, 2),
    // Under a 1-point spread there is nothing to separate; the user almost certainly
    // calibrated while Claude was idle.
    lowContrast: spread < 1,
  };
}

export function formatReport(stats: CalibrationStats, suggestion: CalibrationSuggestion): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Calibration result');
  lines.push('==================');

  if (stats.samples === 0) {
    lines.push('');
    lines.push('No samples collected — Claude Desktop does not appear to be running.');
    lines.push('Start it, begin a conversation, and run --calibrate again.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`Samples: ${stats.samples} over ${CALIBRATION_DURATION_MS / 1000} s`);
  lines.push(`Machine: ${stats.cores} cores (reported for context; not used in the formula)`);
  lines.push('');
  lines.push('CPU used by claude.exe, in percent of ONE core:');
  lines.push(`  min          ${stats.min.toFixed(2)} %`);
  lines.push(`  median       ${stats.median.toFixed(2)} %`);
  lines.push(`  p90          ${stats.p90.toFixed(2)} %`);
  lines.push(`  max          ${stats.max.toFixed(2)} %`);
  lines.push(`  idle floor   ${stats.baseline.toFixed(2)} %  (p${BASELINE_PERCENTILE})`);
  lines.push('');

  if (suggestion.lowContrast) {
    lines.push('WARNING: idle and busy are barely distinguishable in this sample.');
    lines.push('Re-run --calibrate while Claude is actually working (ask it something');
    lines.push('long-running) — otherwise the suggested threshold is guesswork.');
    lines.push('');
  }

  lines.push(`BUSY would trigger above ${suggestion.effectiveThreshold.toFixed(2)} % of one core.`);
  lines.push('');
  lines.push('Paste into config.json:');
  lines.push('');
  lines.push('  "busy": {');
  lines.push('    "baselineWindowSec": 300,');
  lines.push(`    "baselinePercentile": ${suggestion.baselinePercentile},`);
  lines.push(`    "thresholdMultiplier": ${suggestion.thresholdMultiplier},`);
  lines.push(`    "thresholdDeltaPercent": ${suggestion.thresholdDeltaPercent},`);
  lines.push('    "exitFactor": 0.6');
  lines.push('  }');

  return lines.join('\n');
}

export interface CalibrateOptions {
  durationMs?: number;
  intervalMs?: number;
  sampler?: ProcessSampler;
  /** Progress output; silenced in tests. */
  onProgress?: (elapsedMs: number, cpuPercent: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Samples for durationMs and returns the distribution. */
export async function runCalibration(
  options: CalibrateOptions = {}
): Promise<{ stats: CalibrationStats; suggestion: CalibrationSuggestion }> {
  const durationMs = options.durationMs ?? CALIBRATION_DURATION_MS;
  const intervalMs = options.intervalMs ?? CALIBRATION_INTERVAL_MS;
  const sampler = options.sampler ?? createProcessSampler();
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  const cores = await sampler.cores();
  const values: number[] = [];
  const startedAt = now();

  // The first sample only establishes the CpuMs reference point; it carries no delta.
  await sampler.sample();

  while (now() - startedAt < durationMs) {
    await sleep(intervalMs);
    const info = await sampler.sample();
    if (!info.running) continue;
    values.push(info.cpuPercent);
    options.onProgress?.(now() - startedAt, info.cpuPercent);
  }

  const stats = summarise(values, cores);
  return { stats, suggestion: suggest(stats) };
}

/** Entrypoint for `--calibrate`. Prints the report and returns the exit code. */
export async function calibrateCommand(): Promise<number> {
  const seconds = CALIBRATION_DURATION_MS / 1000;
  console.log(`Sampling claude.exe for ${seconds} s.`);
  console.log('Use Claude normally while this runs — ideally ask it something that takes a while.');

  let lastPrint = 0;
  const { stats, suggestion } = await runCalibration({
    onProgress: (elapsedMs, cpuPercent) => {
      if (elapsedMs - lastPrint < 10_000) return;
      lastPrint = elapsedMs;
      console.log(`  ${Math.round(elapsedMs / 1000)} s ... ${cpuPercent.toFixed(2)} % of one core`);
    },
  });

  console.log(formatReport(stats, suggestion));
  return stats.samples === 0 ? 1 : 0;
}
