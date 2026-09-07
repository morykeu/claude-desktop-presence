import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { RECORDING_VERSION, analyse, formatReport } from '../src/calibrate.js';
import {
  MEASUREMENTS_DIR,
  MEASURED_IDLE,
  MEASURED_SUMMARY,
  MEASURED_WORK,
  RECONSTRUCTION,
  loadMeasurement,
  parseRecording,
} from '../src/measurement.js';
import { percentile } from '../src/sources/process.js';
import {
  DOC_TARGETS,
  REPO_ROOT,
  applyRegions,
  closeMarker,
  openMarker,
  readRecordings,
  syncDocs,
} from '../scripts/sync-docs.js';

/**
 * The documentation is generated; this is the check that it stays generated.
 *
 * README.md, README.cs.md, SPEC.md and SPEC.cs.md all quoted the same measurement, by
 * hand, in two languages. They drifted — at one point the README's `--calibrate` example
 * showed a run from a different session two paragraphs under the table it illustrated,
 * and the Czech version was missing the config block entirely. Nothing about that was
 * detectable by any test, because no test read the documents.
 */

describe('the generated documentation is current', () => {
  it.each(DOC_TARGETS.map((target) => target.file))(
    '%s matches what npm run docs:sync would write',
    async (file) => {
      const outcomes = await syncDocs({ write: false });
      const outcome = outcomes.find((candidate) => candidate.file === file);

      if (outcome === undefined) throw new Error(`${file} is not in DOC_TARGETS`);
      if (outcome.changed) {
        const current = await readFile(path.join(REPO_ROOT, file), 'utf8');
        // Name the measurement it was compared against: since recordings exist, that
        // is no longer always src/measurement.ts, and knowing which one is half the
        // diagnosis when this fails.
        const measurement = loadMeasurement(await readRecordings());
        throw new Error(
          `${file} is out of date with ${measurement.source}. Run \`npm run docs:sync\`.\n\n` +
            `--- on disk ---\n${firstDifference(current, outcome.expected)}`
        );
      }

      expect(outcome.changed).toBe(false);
    }
  );
});

/** The contents of every fenced block in a document that holds a calibration report. */
function reportBlocks(document: string): string[] {
  return [...document.matchAll(/```\r?\n(Calibration result\r?\n[\s\S]*?)```/g)].map(
    (match) => match[1] ?? ''
  );
}

/**
 * Independent of the marker mechanism above, and deliberately so.
 *
 * If a future edit removes a marker, the check above starts passing vacuously — there is
 * nothing left to regenerate. This one asserts the property that actually matters: the
 * block a reader copies out of the README is text the program really printed.
 *
 * "Independent" means independent of the RENDERING — it calls analyse and formatReport,
 * never renderReport or applyRegions. It is not independent of which measurement the
 * documents describe, and must not be: it used to build its expectation from the
 * reconstruction fixture by name, which agreed with the documents only for as long as
 * the fixture was also what the documents came from. The first real recording to land in
 * measurements/ moved the documents and left this check comparing against data nothing
 * was generated from. It now reads the measurement the same way the generator does.
 */
describe('the --calibrate example in the READMEs is real program output', () => {
  const readmes = DOC_TARGETS.filter((target) => target.file.startsWith('README'));

  it.each(readmes.map((target) => target.file))(
    '%s quotes formatReport verbatim, not a retyped approximation',
    async (file) => {
      const document = await readFile(path.join(REPO_ROOT, file), 'utf8');
      const measurement = loadMeasurement(await readRecordings());
      const expected = formatReport(
        analyse(measurement.idle, measurement.work, measurement.cores)
      ).trim();

      const blocks = reportBlocks(document);

      // Exactly one: a second copy means somebody pasted a report by hand next to the
      // generated one, which is how the document held two contradicting runs before.
      expect(blocks).toHaveLength(1);
      // Compared against the extracted block rather than the whole file, so a failure
      // prints the report and not the entire README.
      expect(blocks[0]).toContain(expected);
      // The specific line most likely to be "fixed up" by hand.
      expect(blocks[0]).toContain('Paste into config.json:');
    }
  );

  it('would notice a report from a different measurement', () => {
    // The guard on the guard. If this ever stopped discriminating, the check above
    // would pass on any document containing any calibration report at all.
    const mine = formatReport(analyse([1, 2, 3], [8, 9, 10], 12)).trim();
    const other = formatReport(analyse([4, 5, 6], [20, 21, 22], 12)).trim();

    expect(mine).not.toBe(other);
    expect(reportBlocks(['```', mine, '```'].join('\n'))[0]).not.toContain(other);
  });
});

describe('the generated regions are well formed', () => {
  it.each(DOC_TARGETS.map((target) => [target.file, target.locale] as const))(
    '%s opens and closes every marker it uses',
    async (file, locale) => {
      const document = await readFile(path.join(REPO_ROOT, file), 'utf8');

      // applyRegions throws on an opened-but-unclosed marker rather than eating the
      // rest of the file, which is the failure mode that would be hardest to spot.
      expect(() => applyRegions(document, RECONSTRUCTION, locale, file)).not.toThrow();
    }
  );

  it('rejects a marker that is opened and never closed', () => {
    const broken = `intro\n${openMarker('calibration-table')}\nbody, no close\n`;

    expect(() => applyRegions(broken, RECONSTRUCTION, 'en', 'broken.md')).toThrow(/never closed/);
  });

  it('rejects a stray closing marker', () => {
    const broken = `intro\n${closeMarker('calibration-table')}\n`;

    expect(() => applyRegions(broken, RECONSTRUCTION, 'en', 'broken.md')).toThrow(/no matching/);
  });

  it('is idempotent — regenerating twice changes nothing the second time', () => {
    const source = [
      'before',
      openMarker('calibration-derived'),
      'stale text that should be replaced',
      closeMarker('calibration-derived'),
      'after',
    ].join('\n');

    const once = applyRegions(source, RECONSTRUCTION, 'en', 'x.md');
    const twice = applyRegions(once, RECONSTRUCTION, 'en', 'x.md');

    expect(twice).toBe(once);
    expect(once).not.toContain('stale text');
    expect(once).toContain('before');
    expect(once).toContain('after');
  });
});

/**
 * The handover: drop a `calibration-*.json` into measurements/ and the documents come
 * from real readings instead of the reconstruction — including losing the caveat that
 * says the separation percentiles are indicative.
 *
 * Tested against `applyRegions` directly with a synthetic recording, rather than by
 * writing into the repo, so the published documents are not touched and the assertions
 * do not have to move every time a new measurement arrives.
 */
describe('a recording takes over from the reconstruction', () => {
  const recorded = parseRecording(
    {
      version: RECORDING_VERSION,
      recordedAt: '2026-10-01T08:30:00.000Z',
      cores: 16,
      unit: 'percent-of-one-core',
      intervalMs: 2000,
      idleDurationMs: 30_000,
      busyDurationMs: 60_000,
      samples: [
        ...[1.0, 1.4, 1.9, 2.3, 2.8].map((cpuPercent) => ({
          phase: 1,
          at: '2026-10-01T08:30:10.000Z',
          cpuPercent,
        })),
        ...[6.0, 7.5, 9.0, 10.5, 12.0].map((cpuPercent) => ({
          phase: 2,
          at: '2026-10-01T08:31:10.000Z',
          cpuPercent,
        })),
      ],
    },
    'measurements/calibration-2026-10-01T08-30-00Z.json'
  );

  const region = (id: Parameters<typeof openMarker>[0], measurement: typeof recorded): string => {
    const source = [openMarker(id), 'placeholder', closeMarker(id)].join('\n');
    return applyRegions(source, measurement, 'en', 'x.md');
  };

  it('drops the caveat, because a recording has nothing to qualify', () => {
    expect(region('calibration-derived', RECONSTRUCTION)).toContain('indicative rather than');
    expect(region('calibration-derived', recorded)).not.toContain('indicative rather than');
  });

  it('names the recording as the source rather than the module', () => {
    const provenance = region('calibration-provenance', recorded);

    expect(provenance).toContain('measurements/calibration-2026-10-01T08-30-00Z.json');
    expect(provenance).toContain('2026-10-01');
    expect(provenance).toContain('16 cores');
    expect(region('calibration-provenance', RECONSTRUCTION)).toContain('src/measurement.ts');
  });

  it('generates the table from the recording, not from the fixture', () => {
    const table = region('calibration-table', recorded);

    expect(table).toContain('| idle | 5 |');
    expect(table).toContain('| working | 5 |');
    expect(table).not.toContain('13.96');
  });

  it('is what the published documents now come from', async () => {
    // The recording arrived on 2026-09-07 and replaced the reconstruction. This is the
    // other half of the test it succeeded: that one pinned "no recording yet, so the
    // numbers must not move", this one pins that the swap actually happened and the
    // documents no longer describe a reconstruction.
    const measurement = loadMeasurement(await readRecordings());

    expect(measurement.provenance).toBe('recording');
    expect(measurement.source).toContain(MEASUREMENTS_DIR);
    expect(measurement.caveat).toBeNull();
  });

  it('reads a recording that was saved with a UTF-8 BOM', async () => {
    // A recording travels from the machine that was measured to this repo, quite
    // possibly through a Windows editor or a PowerShell redirect on the way.
    const root = mkdtempSync(path.join(tmpdir(), 'cdp-recordings-'));
    const directory = path.join(root, 'measurements');
    mkdirSync(directory);
    writeFileSync(
      path.join(directory, 'calibration-2026-10-01T08-30-00Z.json'),
      '﻿{"version":1,"recordedAt":"2026-10-01T08:30:00.000Z","cores":8,' +
        '"unit":"percent-of-one-core","intervalMs":2000,"idleDurationMs":30000,' +
        '"busyDurationMs":60000,"samples":[' +
        '{"phase":1,"at":"2026-10-01T08:30:10.000Z","cpuPercent":1},' +
        '{"phase":2,"at":"2026-10-01T08:31:10.000Z","cpuPercent":9}]}',
      'utf8'
    );

    try {
      const recordings = await readRecordings(root);
      expect(recordings).toHaveLength(1);
      expect(parseRecording(recordings[0]?.contents, 'x.json').cores).toBe(8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The fixture stands in for a measurement whose individual readings were not kept. If it
 * stops reproducing the summary that WAS kept, every generated document starts
 * publishing numbers that were never measured — silently, and in four places at once.
 */
describe('the measured fixture reproduces the recorded summary', () => {
  const result = analyse(MEASURED_IDLE, MEASURED_WORK, 12);

  it('reproduces the idle phase exactly', () => {
    expect(result.idle.samples).toBe(MEASURED_SUMMARY.idle.samples);
    expect(result.idle.min).toBe(MEASURED_SUMMARY.idle.min);
    expect(result.idle.median).toBe(MEASURED_SUMMARY.idle.median);
    expect(result.idle.p90).toBe(MEASURED_SUMMARY.idle.p90);
    expect(result.idle.max).toBe(MEASURED_SUMMARY.idle.max);
    expect(result.floor).toBe(MEASURED_SUMMARY.idle.p5);
  });

  it('reproduces the working phase exactly', () => {
    expect(result.busy.samples).toBe(MEASURED_SUMMARY.work.samples);
    expect(result.busy.min).toBe(MEASURED_SUMMARY.work.min);
    expect(result.busy.median).toBe(MEASURED_SUMMARY.work.median);
    expect(result.busy.p90).toBe(MEASURED_SUMMARY.work.p90);
    expect(result.busy.max).toBe(MEASURED_SUMMARY.work.max);
  });

  it('keeps both phases sorted, so the percentiles mean what the summary says', () => {
    const sorted = (values: readonly number[]): boolean =>
      values.every((value, index) => index === 0 || value >= (values[index - 1] ?? 0));

    expect(sorted(MEASURED_IDLE)).toBe(true);
    expect(sorted(MEASURED_WORK)).toBe(true);
  });

  it('states the separation percentiles as reconstruction, not measurement', () => {
    // p95 of idle and p5 of work steer the threshold but were never recorded. The
    // caveat that says so has to survive; without it the documents present them as
    // measured, which is the whole reason it exists.
    expect(percentile(MEASURED_IDLE, 95)).toBeGreaterThan(MEASURED_SUMMARY.idle.p90);
    expect(percentile(MEASURED_WORK, 5)).toBeGreaterThan(MEASURED_SUMMARY.work.min);
  });
});

/** A readable pointer at where two versions of a document part company. */
function firstDifference(actual: string, expected: string): string {
  const a = actual.split('\n');
  const b = expected.split('\n');

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) {
      return [
        `line ${index + 1}:`,
        `  on disk:   ${JSON.stringify(a[index] ?? '<missing>')}`,
        `  generated: ${JSON.stringify(b[index] ?? '<missing>')}`,
      ].join('\n');
    }
  }
  return '<identical line by line>';
}
