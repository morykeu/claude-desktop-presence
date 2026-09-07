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
 * writes the generated sections of the four documents. Replacing the arrays below and
 * re-running that script is the whole update procedure.
 *
 * ## What was measured
 *
 * 2026-09-06, on the target machine (12 cores), Claude Desktop 1.46388.4.0. Two phases:
 * thirty seconds of leaving Claude alone, then a minute of it streaming a long answer.
 * The first measurement of generation rather than an agentic session. Percent of ONE
 * core, per the sampler's unit.
 *
 *   idle: min 0.98  median 1.75  p90 2.69  max 3.02  (14 samples)
 *   work: min 5.39  median 9.57  p90 12.25 max 13.96 (27 samples)
 *
 * ## What is real here and what is not
 *
 * Only that summary was written down at the time; the individual readings were not.
 * The arrays below are a reconstruction with the same shape, and the statistics the
 * summary records — min, median, p90, max, and the p5 the daemon's floor uses — land
 * where they were measured.
 *
 * The tails between those anchors are invented, and `analyse` now reads two of them:
 * p95 of the idle phase and p5 of the working phase. Those two values are therefore a
 * property of this reconstruction, not of the machine. They are stated in
 * MEASURED_TAIL_CAVEAT so no document can quietly present them as measured.
 */

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
 * Printed under the generated numbers in the documents, in both languages.
 *
 * The separation percentiles are the two values a reader is most likely to take for
 * gospel, and they are the two the original summary never recorded.
 */
export const MEASURED_TAIL_CAVEAT = {
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
