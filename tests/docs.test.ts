import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyse, formatReport } from '../src/calibrate.js';
import { MEASURED_IDLE, MEASURED_SUMMARY, MEASURED_WORK } from '../src/measurement.js';
import { percentile } from '../src/sources/process.js';
import {
  DOC_TARGETS,
  REPO_ROOT,
  applyRegions,
  closeMarker,
  measuredResult,
  openMarker,
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
        throw new Error(
          `${file} is out of date with src/measurement.ts. Run \`npm run docs:sync\`.\n\n` +
            `--- on disk ---\n${firstDifference(current, outcome.expected)}`
        );
      }

      expect(outcome.changed).toBe(false);
    }
  );
});

/**
 * Independent of the marker mechanism above, and deliberately so.
 *
 * If a future edit removes a marker, the check above starts passing vacuously — there is
 * nothing left to regenerate. This one asserts the property that actually matters: the
 * block a reader copies out of the README is text the program really printed.
 */
describe('the --calibrate example in the READMEs is real program output', () => {
  const readmes = DOC_TARGETS.filter((target) => target.file.startsWith('README'));

  it.each(readmes.map((target) => target.file))(
    '%s quotes formatReport verbatim, not a retyped approximation',
    async (file) => {
      const document = await readFile(path.join(REPO_ROOT, file), 'utf8');
      const report = formatReport(analyse(MEASURED_IDLE, MEASURED_WORK, 12)).trim();

      expect(document).toContain(report);
      // And the specific line most likely to be "fixed up" by hand.
      expect(document).toContain('Paste into config.json:');
    }
  );
});

describe('the generated regions are well formed', () => {
  it.each(DOC_TARGETS.map((target) => [target.file, target.locale] as const))(
    '%s opens and closes every marker it uses',
    async (file, locale) => {
      const document = await readFile(path.join(REPO_ROOT, file), 'utf8');

      // applyRegions throws on an opened-but-unclosed marker rather than eating the
      // rest of the file, which is the failure mode that would be hardest to spot.
      expect(() => applyRegions(document, measuredResult(), locale, file)).not.toThrow();
    }
  );

  it('rejects a marker that is opened and never closed', () => {
    const broken = `intro\n${openMarker('calibration-table')}\nbody, no close\n`;

    expect(() => applyRegions(broken, measuredResult(), 'en', 'broken.md')).toThrow(/never closed/);
  });

  it('rejects a stray closing marker', () => {
    const broken = `intro\n${closeMarker('calibration-table')}\n`;

    expect(() => applyRegions(broken, measuredResult(), 'en', 'broken.md')).toThrow(/no matching/);
  });

  it('is idempotent — regenerating twice changes nothing the second time', () => {
    const source = [
      'before',
      openMarker('calibration-derived'),
      'stale text that should be replaced',
      closeMarker('calibration-derived'),
      'after',
    ].join('\n');

    const once = applyRegions(source, measuredResult(), 'en', 'x.md');
    const twice = applyRegions(once, measuredResult(), 'en', 'x.md');

    expect(twice).toBe(once);
    expect(once).not.toContain('stale text');
    expect(once).toContain('before');
    expect(once).toContain('after');
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
