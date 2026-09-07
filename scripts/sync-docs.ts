/**
 * Writes the measurement-derived sections of the four documents.
 *
 * Every number that comes out of `--calibrate` used to be typed into README.md,
 * README.cs.md, SPEC.md and SPEC.cs.md by hand. Four copies of one set of numbers, in
 * two languages, edited whenever whoever was looking happened to notice — so they
 * drifted, and the Czech README drifted furthest because it was read least. At one
 * point the README's example output showed a run from a completely different session,
 * two paragraphs below the table it was supposed to illustrate.
 *
 * So the documents no longer hold those numbers. They hold marked regions:
 *
 *     <!-- generated:calibration-report -->
 *     ...anything in here is overwritten...
 *     <!-- /generated:calibration-report -->
 *
 * and this script fills them in from `analyse(MEASURED_IDLE, MEASURED_WORK)` — the same
 * call the tests make, against the same fixture. Change the measurement, run
 * `npm run docs:sync`, and all four documents move together. `npm run docs:check` fails
 * if they have not. `tests/docs.test.ts` runs the check as part of `npm test`, so this
 * cannot rot unnoticed.
 *
 * The result is formatted with the repo's own prettier config before it is compared or
 * written. Otherwise `npm run format` would reflow a generated markdown table and the
 * check would report a difference that nobody introduced.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { format, resolveConfig } from 'prettier';

import {
  BASELINE_PERCENTILE,
  BUSY_EDGE_PERCENTILE,
  IDLE_EDGE_PERCENTILE,
  analyse,
  formatReport,
} from '../src/calibrate.js';
import type { CalibrationResult } from '../src/calibrate.js';
import { formatDebugLine } from '../src/debugLine.js';
import { parseJson } from '../src/json.js';
import { MEASUREMENTS_DIR, loadMeasurement } from '../src/measurement.js';
import type { Measurement, RecordingFile } from '../src/measurement.js';
import { busyThreshold } from '../src/state.js';
import type { PresenceState, StateResult } from '../src/state.js';

export const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

export type Locale = 'en' | 'cs';

/**
 * Every recording sitting in `measurements/`, ready for `loadMeasurement`.
 *
 * An unreadable or malformed file is an error, not something to skip: skipping it would
 * quietly regenerate the documents from the previous measurement while the author
 * believed the new one had been picked up.
 */
export async function readRecordings(root = REPO_ROOT): Promise<RecordingFile[]> {
  const directory = path.join(root, MEASUREMENTS_DIR);

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const files = entries.filter((name) => name.startsWith('calibration-') && name.endsWith('.json'));
  return Promise.all(
    files.sort().map(async (name) => ({
      source: `${MEASUREMENTS_DIR}/${name}`,
      contents: parseJson(await readFile(path.join(directory, name), 'utf8')),
    }))
  );
}

/** The single analysis every generated number descends from. */
export function measuredResult(measurement: Measurement): CalibrationResult {
  return analyse(measurement.idle, measurement.work, measurement.cores);
}

/** Czech writes decimals with a comma. Nothing else differs about the numbers. */
function num(value: number, locale: Locale, decimals = 2): string {
  const text = value.toFixed(decimals);
  return locale === 'cs' ? text.replace('.', ',') : text;
}

/**
 * A value as it has to be TYPED into config.json — always a dot, in both languages.
 * A Czech reader copying `3,5` out of the prose would write invalid JSON.
 */
function json(value: number, decimals = 1): string {
  return value.toFixed(decimals);
}

/**
 * The distribution table. Bold marks the four numbers the reasoning around it leans on:
 * the idle median and max, and the working min and median.
 */
export function renderTable(result: CalibrationResult, locale: Locale): string {
  const head =
    locale === 'cs'
      ? ['Fáze', 'vzorků', 'min', 'medián', 'p90', 'max']
      : ['Phase', 'samples', 'min', 'median', 'p90', 'max'];
  const names = locale === 'cs' ? ['klid', 'práce'] : ['idle', 'working'];

  const row = (name: string, s: CalibrationResult['idle'], bold: number[]): string => {
    const cells = [s.min, s.median, s.p90, s.max].map((value, index) =>
      bold.includes(index) ? `**${num(value, locale)}**` : num(value, locale)
    );
    return `| ${name} | ${s.samples} | ${cells.join(' | ')} |`;
  };

  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    row(names[0] ?? 'idle', result.idle, [1, 3]),
    row(names[1] ?? 'working', result.busy, [0, 1]),
  ].join('\n');
}

/**
 * Everything `analyse` derives, as a list.
 *
 * This exists so the prose around it does not have to name a single number. Prose that
 * quotes a value is prose that goes stale the next time the formula changes, and the
 * formula has now changed twice.
 */
export function renderDerived(
  result: CalibrationResult,
  locale: Locale,
  measurement: Measurement
): string {
  const s = result.suggestion;
  const clean = !result.overlapping;

  // A recording carries no caveat, so the note disappears from all four documents the
  // moment real readings replace the reconstruction. Nothing to remember to delete.
  const caveat = measurement.caveat;
  const note = caveat === null ? [] : ['', `> ${caveat[locale]}`];

  if (locale === 'cs') {
    return [
      `- **podlaha ${num(result.floor, 'cs')} %** — p${BASELINE_PERCENTILE} fáze 1, na tuhle hodnotu se za běhu ustálí klouzavá základna`,
      `- **horní okraj klidu ${num(result.idleEdge, 'cs')} %** (p${IDLE_EDGE_PERCENTILE} fáze 1) · **dolní okraj práce ${num(result.busyEdge, 'cs')} %** (p${BUSY_EDGE_PERCENTILE} fáze 2) → odstup ${num(result.separation, 'cs')} bodu, ${clean ? 'rozdělení se nepřekrývají' : '**rozdělení se překrývají**'}`,
      `- **BUSY nad ${num(result.threshold, 'cs')} %** — přesně uprostřed mezi těmi dvěma okraji`,
      `- **zpátky do klidu na ${num(result.exitThreshold, 'cs')} %** — nad klidovým maximem ${num(result.idle.max, 'cs')} %, takže běžný výkyv daemona nenechá zaseknutého v BUSY`,
      `- do configu (přesně takhle, s tečkou): multiplier ${json(s.thresholdMultiplier)} · delta ${json(s.thresholdDeltaPercent)} · exitFactor ${json(s.exitFactor)}`,
      ...note,
    ].join('\n');
  }

  return [
    `- **floor ${num(result.floor, 'en')} %** — p${BASELINE_PERCENTILE} of phase 1, where the rolling baseline settles at runtime`,
    `- **idle edge ${num(result.idleEdge, 'en')} %** (p${IDLE_EDGE_PERCENTILE} of phase 1) · **work edge ${num(result.busyEdge, 'en')} %** (p${BUSY_EDGE_PERCENTILE} of phase 2) → ${num(result.separation, 'en')} points apart, ${clean ? 'the distributions do not overlap' : '**the distributions overlap**'}`,
    `- **BUSY above ${num(result.threshold, 'en')} %** — exactly midway between those two edges`,
    `- **back to idle at ${num(result.exitThreshold, 'en')} %** — above the idle maximum of ${num(result.idle.max, 'en')} %, so an ordinary fluctuation cannot keep the daemon latched in BUSY`,
    `- into the config: multiplier ${json(s.thresholdMultiplier)} · delta ${json(s.thresholdDeltaPercent)} · exitFactor ${json(s.exitFactor)}`,
    ...note,
  ].join('\n');
}

/**
 * Stand-in for the path the calibrator prints.
 *
 * The real one is absolute and depends on where the reader installed the thing, so the
 * example has to show something. An obviously generic install directory is the least
 * misleading option; the surrounding prose says the program prints the real path.
 */
export const EXAMPLE_INSTALL_DIR = 'C:\\Tools\\claude-desktop-presence';

/** The calibrator's own output, verbatim. English in both languages — the program is. */
export function renderReport(result: CalibrationResult, measurement: Measurement): string {
  const samplesPath = `${EXAMPLE_INSTALL_DIR}\\calibration-${measurement.recordedOn}T18-42-11Z.json`;
  return ['```', formatReport(result, samplesPath).trim(), '```'].join('\n');
}

/**
 * The `--debug` tick lines, run through the real formatter with the real thresholds.
 *
 * The threshold a reader sees here is not a constant: during warmup the baseline counts
 * as zero, so it is the bare delta, and once the floor settles it is floor + delta. The
 * hand-written version of this example showed a single number that matched neither, and
 * matched no default either. Both halves are now computed with `busyThreshold`.
 */
export function renderDebug(result: CalibrationResult): string {
  const calibration = result.suggestion;
  const idleCpu = result.idle.median;
  const workCpu = result.busy.median;

  const line = (
    state: PresenceState,
    cpu: number,
    baseline: number,
    reason: StateResult['reason'],
    details: string,
    secondLine: string,
    warmingUp: boolean,
    publish: boolean
  ): string =>
    formatDebugLine(
      {
        state,
        toolName: null,
        cpuBaseline: baseline,
        cpuThreshold: busyThreshold(baseline, calibration),
        reason,
        warmingUp,
        publish,
      },
      cpu,
      {
        details,
        state: secondLine,
        startTimestamp: undefined,
        largeImageKey: 'claude_logo',
        largeImageText: undefined,
        smallImageKey: state === 'IDLE' ? 'idle' : 'busy',
        smallImageText: undefined,
        buttons: undefined,
      }
    );

  const idleText = 'Claude Desktop — Idle';
  const busyText = 'Claude Desktop — Working…';

  return [
    '```',
    line('IDLE', idleCpu, 0, 'idle', idleText, 'Version 1.46388.4.0', true, true),
    line('BUSY', workCpu, 0, 'cpu', busyText, 'MCP: 22 servers', true, false),
    `[no-discord] setActivity {"details":${JSON.stringify(idleText)},"smallImageKey":"idle",...}`,
    line('IDLE', idleCpu, result.floor, 'idle', idleText, 'Usage 5h: 29 %', false, true),
    line('BUSY', workCpu, result.floor, 'cpu', busyText, 'MCP: 22 servers', false, true),
    `[no-discord] setActivity {"details":${JSON.stringify(busyText)},"smallImageKey":"busy",...}`,
    '```',
  ].join('\n');
}

/**
 * One line naming the run, so a reader knows which measurement they are looking at.
 *
 * A recording says which file it came from; the reconstruction keeps the wording it had
 * before recordings existed, because the machine and the workload it stands in for are
 * things the file format does not carry.
 */
export function renderProvenance(locale: Locale, measurement: Measurement): string {
  const { recordedOn, cores, source } = measurement;

  if (measurement.provenance === 'recording') {
    return locale === 'cs'
      ? `_Naměřeno ${recordedOn} na cílovém stroji (${cores} jader), ze syrových vzorků v \`${source}\`. Vygenerováno přes \`npm run docs:sync\` — needituj ručně._`
      : `_Measured ${recordedOn} on the target machine (${cores} cores), from the raw samples in \`${source}\`. Generated by \`npm run docs:sync\` — do not edit by hand._`;
  }

  return locale === 'cs'
    ? `_Naměřeno ${recordedOn} na cílovém stroji (${cores} jader), Claude Desktop 1.46388.4.0, při streamování dlouhé odpovědi. Vygenerováno z \`${source}\` přes \`npm run docs:sync\` — needituj ručně._`
    : `_Measured ${recordedOn} on the target machine (${cores} cores), Claude Desktop 1.46388.4.0, while streaming a long answer. Generated from \`${source}\` by \`npm run docs:sync\` — do not edit by hand._`;
}

export interface DocTarget {
  file: string;
  locale: Locale;
}

export const DOC_TARGETS: readonly DocTarget[] = [
  { file: 'README.md', locale: 'en' },
  { file: 'README.cs.md', locale: 'cs' },
  { file: 'SPEC.md', locale: 'en' },
  { file: 'SPEC.cs.md', locale: 'cs' },
];

export type RegionId =
  | 'calibration-table'
  | 'calibration-derived'
  | 'calibration-report'
  | 'calibration-debug'
  | 'calibration-provenance';

function renderRegion(
  id: RegionId,
  result: CalibrationResult,
  locale: Locale,
  measurement: Measurement
): string {
  switch (id) {
    case 'calibration-table':
      return renderTable(result, locale);
    case 'calibration-derived':
      return renderDerived(result, locale, measurement);
    case 'calibration-report':
      return renderReport(result, measurement);
    case 'calibration-debug':
      return renderDebug(result);
    case 'calibration-provenance':
      return renderProvenance(locale, measurement);
  }
}

const REGION_IDS: readonly RegionId[] = [
  'calibration-table',
  'calibration-derived',
  'calibration-report',
  'calibration-debug',
  'calibration-provenance',
];

export function openMarker(id: RegionId): string {
  return `<!-- generated:${id} -->`;
}

export function closeMarker(id: RegionId): string {
  return `<!-- /generated:${id} -->`;
}

/**
 * Replaces the body of every marked region in one document.
 *
 * A document does not have to carry every region — SPEC has no room for the full
 * calibrator dump — but a marker that is opened and never closed is an error rather
 * than something to paper over: it would silently swallow the rest of the file.
 */
export function applyRegions(
  source: string,
  measurement: Measurement,
  locale: Locale,
  file: string
): string {
  const result = measuredResult(measurement);
  let output = source;

  for (const id of REGION_IDS) {
    const open = openMarker(id);
    const close = closeMarker(id);
    const start = output.indexOf(open);

    if (start === -1) {
      if (output.includes(close)) {
        throw new Error(`${file}: ${close} has no matching ${open}`);
      }
      continue;
    }

    const end = output.indexOf(close, start);
    if (end === -1) throw new Error(`${file}: ${open} is never closed with ${close}`);

    const body = renderRegion(id, result, locale, measurement);
    output = output.slice(0, start) + `${open}\n\n${body}\n\n` + output.slice(end);
  }

  return output;
}

export interface SyncOutcome {
  file: string;
  changed: boolean;
  expected: string;
}

/**
 * Regenerates every document. Returns what each one should contain; writes only when
 * asked, so the same code path serves `docs:sync` and `docs:check`.
 */
export async function syncDocs(
  options: { write: boolean } = { write: false }
): Promise<SyncOutcome[]> {
  const measurement = loadMeasurement(await readRecordings());
  const outcomes: SyncOutcome[] = [];

  for (const target of DOC_TARGETS) {
    const filePath = path.join(REPO_ROOT, target.file);
    const current = await readFile(filePath, 'utf8');
    const replaced = applyRegions(current, measurement, target.locale, target.file);

    // Format with the repo's own config, so `npm run format` can never make a freshly
    // generated document look stale.
    const prettierOptions = await resolveConfig(filePath);
    const expected = await format(replaced, { ...prettierOptions, filepath: filePath });

    const changed = expected !== current;
    if (changed && options.write) await writeFile(filePath, expected, 'utf8');
    outcomes.push({ file: target.file, changed, expected });
  }

  return outcomes;
}

async function main(): Promise<number> {
  const check = process.argv.includes('--check');
  const measurement = loadMeasurement(await readRecordings());
  const outcomes = await syncDocs({ write: !check });
  const stale = outcomes.filter((outcome) => outcome.changed);

  if (!check) {
    console.log(
      measurement.provenance === 'recording'
        ? `Using the raw samples in ${measurement.source} (${measurement.idle.length} idle + ${measurement.work.length} working readings).`
        : `Using the reconstruction in ${measurement.source} — no recording in ${MEASUREMENTS_DIR}/ yet.`
    );
    for (const outcome of outcomes) {
      console.log(`${outcome.changed ? 'updated' : 'unchanged'}  ${outcome.file}`);
    }
    return 0;
  }

  if (stale.length === 0) {
    console.log(`Generated documentation is up to date (source: ${measurement.source}).`);
    return 0;
  }

  console.error(`These documents no longer match ${measurement.source}:`);
  for (const outcome of stale) console.error(`  ${outcome.file}`);
  console.error('\nRun `npm run docs:sync`.');
  return 1;
}

// Run as a CLI, not when tests import the renderers. pathToFileURL rather than string
// surgery: the repo path contains a drive letter and diacritics, and both need encoding.
const invokedAs = process.argv[1];
if (invokedAs !== undefined && import.meta.url === pathToFileURL(invokedAs).href) {
  process.exitCode = await main();
}
