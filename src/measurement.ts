/**
 * The measurement everything about the BUSY detector rests on.
 *
 * This module is data, not runtime code. Nothing in `index.ts` imports it, so it never
 * reaches the bundle — `scripts/check-bundle.mjs` asserts that. It exists as a module,
 * rather than as a literal in a test, because three places used to hold these numbers
 * by hand: `tests/calibrate.test.ts`, and the two READMEs, which then drifted apart and
 * ended up documenting an older run than the one in the table above them.
 *
 * Now the tests and the documentation both read from here, and `npm run docs:sync`
 * writes the generated sections of the four documents.
 *
 * ## Two kinds of measurement
 *
 * `loadMeasurement` prefers a **recording** — a `calibration-*.json` file written by
 * `--calibrate`, holding every reading of both phases — and falls back to the
 * **reconstruction** below when there is none.
 *
 * The reconstruction exists because the original streaming measurement was written down
 * as a summary and the individual readings were thrown away. When the threshold rule
 * later changed to key off p95 of idle and p5 of work, there was nothing left to compute
 * those from. The arrays below reproduce the recorded summary exactly and invent the
 * tails between its anchors, so those two percentiles are a property of the
 * reconstruction, not of the machine — which is what RECONSTRUCTION_CAVEAT says, in
 * every document generated from it.
 *
 * ## Replacing it with real data
 *
 * 1. Run `claude-desktop-presence --calibrate`. It writes `calibration-<timestamp>.json`
 *    next to `config.json` and tells you the path.
 * 2. Copy that file into `measurements/`.
 * 3. `npm run docs:sync`.
 *
 * All four documents then come from the readings, and the caveat disappears on its own
 * because a recording carries none.
 *
 * ## What the reconstruction stands in for
 *
 * 2026-09-06, on the target machine (12 cores), Claude Desktop 1.46388.4.0. Two phases:
 * thirty seconds of leaving Claude alone, then a minute of it streaming a long answer.
 * The first measurement of generation rather than an agentic session. Percent of ONE
 * core, per the sampler's unit.
 *
 *   idle: min 0.98  median 1.75  p90 2.69  max 3.02  (14 samples)
 *   work: min 5.39  median 9.57  p90 12.25 max 13.96 (27 samples)
 */

import type { CalibrationRecording, CalibrationSample } from './calibrate.js';
import { RECORDING_VERSION } from './calibrate.js';

/** Where a recording is dropped for the documentation to pick up. */
export const MEASUREMENTS_DIR = 'measurements';

/** Cores on the machine that produced the readings. Context only; not in any formula. */
export const MEASURED_CORES = 12;

/** When the readings were taken, for the documents that cite them. */
export const MEASURED_ON = '2026-09-06';

/** Phase 1: thirty seconds with nothing typed at Claude. */
export const MEASURED_IDLE = [
  0.98, 1.12, 1.3, 1.45, 1.6, 1.7, 1.72, 1.78, 2.0, 2.2, 2.4, 2.65, 2.71, 3.02,
] as const;

/** Phase 2: a minute of Claude streaming a long answer. */
export const MEASURED_WORK = [
  5.39, 6.2, 6.8, 7.3, 7.8, 8.2, 8.6, 8.9, 9.1, 9.3, 9.45, 9.5, 9.55, 9.57, 9.6, 9.7, 9.9, 10.2,
  10.5, 10.9, 11.2, 11.5, 11.8, 12.15, 12.4, 13.1, 13.96,
] as const;

/**
 * The summary that was actually written down, as an assertion target.
 *
 * A test checks the arrays above reproduce every one of these exactly. Without it the
 * reconstruction can drift off the record it is supposed to stand in for — the previous
 * version did, quietly reporting a median of 1.78 where 1.75 was measured, which is how
 * a generated document would have started publishing the wrong table.
 */
export const MEASURED_SUMMARY = {
  idle: { samples: 14, min: 0.98, median: 1.75, p90: 2.69, max: 3.02, p5: 1.07 },
  work: { samples: 27, min: 5.39, median: 9.57, p90: 12.25, max: 13.96 },
} as const;

/**
 * Printed under the generated numbers, in both languages, for a reconstruction only.
 *
 * The separation percentiles are the two values a reader is most likely to take for
 * gospel, and they are the two the original summary never recorded. A recording carries
 * `caveat: null` instead, and the note disappears from all four documents.
 */
export const RECONSTRUCTION_CAVEAT = {
  en:
    'The summary above (min, median, p90, max, and the p5 floor) is what was measured. ' +
    'The individual readings were not kept, so the separation percentiles — p95 of idle ' +
    'and p5 of working — come from a reconstruction with the same shape and are ' +
    'indicative rather than measured.',
  cs:
    'Naměřený je ten souhrn (min, medián, p90, max a podlaha p5). Jednotlivé vzorky se ' +
    'neuchovaly, takže percentily separace — p95 klidu a p5 práce — pocházejí z ' +
    'rekonstrukce se stejným tvarem a jsou orientační, ne naměřené.',
} as const;

/** Kept under the old name so nothing that imports it breaks silently. */
export const MEASURED_TAIL_CAVEAT = RECONSTRUCTION_CAVEAT;

export interface Measurement {
  /** Whether the readings are real or stand in for a summary. Drives the caveat. */
  provenance: 'recording' | 'reconstruction';
  /** Named in the generated provenance line so a reader can find the source. */
  source: string;
  /** Date only, as the documents cite it. */
  recordedOn: string;
  cores: number;
  idle: number[];
  work: number[];
  /** Null for a recording: there is nothing to qualify. */
  caveat: { en: string; cs: string } | null;
}

/** The stand-in, until a recording replaces it. */
export const RECONSTRUCTION: Measurement = {
  provenance: 'reconstruction',
  source: 'src/measurement.ts',
  recordedOn: MEASURED_ON,
  cores: MEASURED_CORES,
  idle: [...MEASURED_IDLE],
  work: [...MEASURED_WORK],
  caveat: RECONSTRUCTION_CAVEAT,
};

class RecordingError extends Error {}

function fail(source: string, problem: string): never {
  throw new RecordingError(`${source}: ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads one `calibration-*.json` into a Measurement.
 *
 * Strict on purpose. A file that is silently accepted with an empty phase would produce
 * documents claiming "0 samples" and a threshold computed from nothing, in four places
 * at once — the exact failure mode this whole mechanism exists to prevent. Every reject
 * says what is wrong with the file rather than what type check failed.
 */
export function parseRecording(raw: unknown, source: string): Measurement {
  if (!isRecord(raw)) fail(source, 'is not a JSON object.');

  if (raw['version'] !== RECORDING_VERSION) {
    fail(
      source,
      `is version ${JSON.stringify(raw['version'])}, and this build only reads ` +
        `version ${RECORDING_VERSION}.`
    );
  }

  const unit = raw['unit'];
  if (unit !== 'percent-of-one-core') {
    fail(
      source,
      `records its readings in ${JSON.stringify(unit)}. Everything here is percent of ` +
        'ONE core; mixing the two is how the threshold was 40x out to begin with.'
    );
  }

  const cores = raw['cores'];
  if (typeof cores !== 'number' || !Number.isFinite(cores) || cores <= 0) {
    fail(source, `has no usable core count (got ${JSON.stringify(cores)}).`);
  }

  const recordedAt = raw['recordedAt'];
  if (typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) {
    fail(source, `has no usable recordedAt (got ${JSON.stringify(recordedAt)}).`);
  }

  const samples = raw['samples'];
  if (!Array.isArray(samples)) fail(source, 'has no samples array.');

  const idle: number[] = [];
  const work: number[] = [];

  samples.forEach((sample, index) => {
    if (!isRecord(sample)) fail(source, `sample ${index} is not an object.`);

    const value = sample['cpuPercent'];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail(source, `sample ${index} has no usable cpuPercent (got ${JSON.stringify(value)}).`);
    }

    const at = sample['at'];
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
      fail(source, `sample ${index} has no usable timestamp (got ${JSON.stringify(at)}).`);
    }

    if (sample['phase'] === 1) idle.push(value);
    else if (sample['phase'] === 2) work.push(value);
    else
      fail(source, `sample ${index} is in phase ${JSON.stringify(sample['phase'])}, not 1 or 2.`);
  });

  if (idle.length === 0) fail(source, 'has no phase 1 samples — there is no idle floor in it.');
  if (work.length === 0) fail(source, 'has no phase 2 samples — there is nothing to compare to.');

  return {
    provenance: 'recording',
    source,
    recordedOn: recordedAt.slice(0, 10),
    cores,
    idle,
    work,
    caveat: null,
  };
}

/** A candidate file, already read off disk by whoever called us. */
export interface RecordingFile {
  /** Path as it should appear in the documents, e.g. `measurements/calibration-….json`. */
  source: string;
  /** Parsed JSON. */
  contents: unknown;
}

/**
 * Picks the measurement the documentation is generated from.
 *
 * Newest recording wins; the reconstruction is the fallback, not a peer. Deliberately
 * pure — the caller does the file system, so this can be tested without one and so
 * nothing in `src/` reads the disk at import time.
 */
export function loadMeasurement(files: readonly RecordingFile[] = []): Measurement {
  const parsed = files.map((file) => parseRecording(file.contents, file.source));
  if (parsed.length === 0) return RECONSTRUCTION;

  return parsed.reduce((newest, candidate) =>
    candidate.recordedOn >= newest.recordedOn ? candidate : newest
  );
}

export type { CalibrationRecording, CalibrationSample };
