import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  RECORDING_VERSION,
  analyse,
  formatReport,
  recordingFilename,
  runCalibration,
  writeRecording,
} from '../src/calibrate.js';
import { scriptedSampler } from './helpers/samplers.js';
import {
  MEASURED_IDLE,
  MEASURED_WORK,
  RECONSTRUCTION,
  loadMeasurement,
  parseRecording,
} from '../src/measurement.js';

/**
 * The point of all of this: a measurement has to survive being written down.
 *
 * The streaming measurement was recorded as min/median/p90/max and the readings were
 * thrown away. When the threshold rule later moved to p95 and p5, those two numbers
 * could not be recovered, and four generated documents have been carrying a
 * reconstruction with a caveat ever since. `--calibrate` now keeps every reading, and
 * `src/measurement.ts` can take that file as its input.
 */

const RUN_STARTED_AT = new Date('2026-09-07T09:00:00.000Z');

async function run(script: readonly number[], idleMs = 4000, busyMs = 6000) {
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

const temporaries: string[] = [];
function scratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cdp-measure-'));
  temporaries.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

describe('runCalibration records every reading', () => {
  it('keeps one sample per reading, tagged with its phase', async () => {
    const { result, recording } = await run([0, 0.3, 0.4, 0.5, 0.6, 0, 4, 5, 6, 7, 8, 9]);

    expect(recording.samples.filter((sample) => sample.phase === 1)).toHaveLength(
      result.idle.samples
    );
    expect(recording.samples.filter((sample) => sample.phase === 2)).toHaveLength(
      result.busy.samples
    );
    expect(recording.samples.map((sample) => sample.cpuPercent)).toEqual([
      0.3, 0.4, 0.5, 0.6, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it('timestamps each sample as a real date, not the virtual clock', async () => {
    const { recording } = await run([0, 0.3, 0.4, 0, 4, 5]);

    expect(recording.recordedAt).toBe(RUN_STARTED_AT.toISOString());
    for (const sample of recording.samples) {
      expect(Number.isNaN(Date.parse(sample.at))).toBe(false);
      expect(Date.parse(sample.at)).toBeGreaterThanOrEqual(RUN_STARTED_AT.getTime());
    }

    // Monotonic: the readings are in the order they were taken.
    const times = recording.samples.map((sample) => Date.parse(sample.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('records the run parameters, so the file can be read on its own', async () => {
    const { recording } = await run([0, 0.3, 0.4, 0, 4, 5], 3000, 5000);

    expect(recording.version).toBe(RECORDING_VERSION);
    expect(recording.unit).toBe('percent-of-one-core');
    expect(recording.cores).toBe(12);
    expect(recording.intervalMs).toBe(1000);
    expect(recording.idleDurationMs).toBe(3000);
    expect(recording.busyDurationMs).toBe(5000);
  });

  it('does not record samples taken while Claude was not running', async () => {
    // Those readings are skipped for the analysis, so recording them would make the
    // file disagree with the report generated from the same run.
    const { result, recording } = await run([0, 1, 2], 4000, 4000);

    expect(result.busy.samples).toBe(0);
    expect(recording.samples.every((sample) => sample.phase === 1)).toBe(true);
  });
});

describe('a recording round-trips back into the same analysis', () => {
  it('parseRecording recovers exactly the values analyse was given', async () => {
    const { result, recording } = await run([0, 0.3, 0.4, 0.5, 0.6, 0, 4, 5, 6, 7, 8, 9]);

    const measurement = parseRecording(recording, 'round-trip');
    const reanalysed = analyse(measurement.idle, measurement.work, measurement.cores);

    expect(reanalysed).toEqual(result);
    expect(formatReport(reanalysed)).toBe(formatReport(result));
  });

  it('survives the trip through JSON on disk', async () => {
    const { result, recording } = await run([0, 0.3, 0.4, 0.5, 0.6, 0, 4, 5, 6, 7, 8, 9]);
    const directory = scratchDir();

    const written = writeRecording(recording, directory);
    const reloaded: unknown = JSON.parse(readFileSync(written, 'utf8'));
    const measurement = parseRecording(reloaded, path.basename(written));

    expect(analyse(measurement.idle, measurement.work, measurement.cores)).toEqual(result);
    expect(measurement.provenance).toBe('recording');
    expect(measurement.caveat).toBeNull();
    expect(measurement.recordedOn).toBe('2026-09-07');
  });

  it('names the file after the moment it was recorded', () => {
    expect(recordingFilename(new Date('2026-09-07T09:08:07.123Z'))).toBe(
      'calibration-2026-09-07T09-08-07Z.json'
    );
  });

  it('creates the directory if it is not there', async () => {
    const { recording } = await run([0, 0.3, 0.4, 0, 4, 5]);
    const nested = path.join(scratchDir(), 'does', 'not', 'exist');

    const written = writeRecording(recording, nested);
    expect(readFileSync(written, 'utf8')).toContain('"unit": "percent-of-one-core"');
  });
});

describe('parseRecording refuses what it cannot trust', () => {
  const good = {
    version: RECORDING_VERSION,
    recordedAt: '2026-09-07T09:00:00.000Z',
    cores: 12,
    unit: 'percent-of-one-core',
    intervalMs: 2000,
    idleDurationMs: 30_000,
    busyDurationMs: 60_000,
    samples: [
      { phase: 1, at: '2026-09-07T09:00:02.000Z', cpuPercent: 1 },
      { phase: 2, at: '2026-09-07T09:00:40.000Z', cpuPercent: 9 },
    ],
  };

  it('accepts a well-formed file', () => {
    const measurement = parseRecording(good, 'good.json');

    expect(measurement.idle).toEqual([1]);
    expect(measurement.work).toEqual([9]);
    expect(measurement.cores).toBe(12);
  });

  it.each([
    ['not an object', 'nope', /not a JSON object/],
    ['a future version', { ...good, version: 2 }, /only reads version/],
    ['a different unit', { ...good, unit: 'percent-of-machine' }, /percent of\s+ONE core/],
    ['no cores', { ...good, cores: 0 }, /core count/],
    ['no recordedAt', { ...good, recordedAt: 'never' }, /recordedAt/],
    ['no samples array', { ...good, samples: {} }, /no samples array/],
    [
      'a NaN reading',
      { ...good, samples: [{ ...good.samples[0], cpuPercent: null }] },
      /cpuPercent/,
    ],
    ['a bad timestamp', { ...good, samples: [{ ...good.samples[0], at: 'soon' }] }, /timestamp/],
    ['an unknown phase', { ...good, samples: [{ ...good.samples[0], phase: 3 }] }, /not 1 or 2/],
  ])('rejects %s', (_label, input, pattern) => {
    expect(() => parseRecording(input, 'bad.json')).toThrow(pattern);
  });

  it('rejects a file with an empty phase rather than generating docs from nothing', () => {
    // The dangerous case: structurally valid, and it would produce a table saying
    // "0 samples" and a threshold computed from an empty distribution.
    const idleOnly = { ...good, samples: good.samples.filter((s) => s.phase === 1) };
    const workOnly = { ...good, samples: good.samples.filter((s) => s.phase === 2) };

    expect(() => parseRecording(idleOnly, 'x.json')).toThrow(/no phase 2 samples/);
    expect(() => parseRecording(workOnly, 'x.json')).toThrow(/no phase 1 samples/);
  });

  it('names the file in every complaint, so the reader knows which one to look at', () => {
    expect(() => parseRecording({ version: 9 }, 'measurements/whatever.json')).toThrow(
      /^measurements\/whatever\.json:/
    );
  });
});

describe('loadMeasurement', () => {
  const recordingFor = (recordedAt: string, idle: number[], work: number[]): unknown => ({
    version: RECORDING_VERSION,
    recordedAt,
    cores: 8,
    unit: 'percent-of-one-core',
    intervalMs: 2000,
    idleDurationMs: 30_000,
    busyDurationMs: 60_000,
    samples: [
      ...idle.map((cpuPercent) => ({ phase: 1, at: recordedAt, cpuPercent })),
      ...work.map((cpuPercent) => ({ phase: 2, at: recordedAt, cpuPercent })),
    ],
  });

  it('falls back to the reconstruction when there is no recording', () => {
    const measurement = loadMeasurement([]);

    expect(measurement).toEqual(RECONSTRUCTION);
    expect(measurement.provenance).toBe('reconstruction');
    expect(measurement.caveat).not.toBeNull();
    expect(measurement.idle).toEqual([...MEASURED_IDLE]);
    expect(measurement.work).toEqual([...MEASURED_WORK]);
  });

  it('prefers a recording over the reconstruction', () => {
    const measurement = loadMeasurement([
      { source: 'measurements/a.json', contents: recordingFor('2026-09-10T00:00:00Z', [1], [9]) },
    ]);

    expect(measurement.provenance).toBe('recording');
    expect(measurement.source).toBe('measurements/a.json');
    expect(measurement.caveat).toBeNull();
    expect(measurement.cores).toBe(8);
  });

  it('takes the newest when there are several', () => {
    const measurement = loadMeasurement([
      { source: 'measurements/old.json', contents: recordingFor('2026-09-01T00:00:00Z', [1], [9]) },
      { source: 'measurements/new.json', contents: recordingFor('2026-09-20T00:00:00Z', [2], [8]) },
      { source: 'measurements/mid.json', contents: recordingFor('2026-09-10T00:00:00Z', [3], [7]) },
    ]);

    expect(measurement.source).toBe('measurements/new.json');
    expect(measurement.idle).toEqual([2]);
  });

  it('throws rather than silently ignoring a broken file', () => {
    // Skipping it would regenerate the documents from the previous measurement while
    // the author believed the new one had been picked up.
    expect(() =>
      loadMeasurement([{ source: 'measurements/broken.json', contents: { version: 1 } }])
    ).toThrow(/measurements\/broken\.json/);
  });
});
