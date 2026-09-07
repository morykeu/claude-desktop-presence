#!/usr/bin/env node
/**
 * Build guards on the CJS bundle: no dynamic `import()`, and no documentation fixture.
 *
 * pkg cannot execute one. A packaged .exe hits
 * "A dynamic import callback was not specified" and the feature behind it is simply
 * dead — which is how both koffi (focus detection) and @xhayper/discord-rpc (the entire
 * Discord connection) shipped broken. Neither showed up in the build, in the tests, or
 * in a --no-discord dry run; only the distributed artifact was affected.
 *
 * tsup treats package.json dependencies as external, so any `await import('some-dep')`
 * survives into dist/index.cjs verbatim. That makes its presence a build error, not a
 * runtime surprise, so this fails `npm run package` rather than the user's install.
 *
 * The second guard is smaller. `src/measurement.ts` holds the calibration measurement the
 * documentation is generated from. It is data for the docs and the tests, and the daemon
 * has no use for it — if it turns up in the bundle, something imported it by accident and
 * every user is now carrying a fixture in their .exe.
 *
 * Usage: node scripts/check-bundle.mjs [path-to-bundle]
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

const DEFAULT_BUNDLE = 'dist/index.cjs';

/**
 * Blanks out comments and string literals, keeping the offsets intact.
 *
 * A plain grep would trip over its own documentation — this file, and the comments
 * explaining the fix in client.ts and focus.ts, all contain the text "import()". Only
 * real code counts.
 */
export function stripCommentsAndStrings(source) {
  const out = source.split('');
  let i = 0;

  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < source.length) {
    const two = source.slice(i, i + 2);

    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === quote) break;
        j += 1;
      }
      blank(i, Math.min(j + 1, source.length));
      i = j + 1;
      continue;
    }

    i += 1;
  }

  return out.join('');
}

/** Every dynamic import left in the code, with line numbers. */
export function findDynamicImports(source) {
  const code = stripCommentsAndStrings(source);
  // `import` as its own token followed by "(" — not `.import(`, not `myimport(`.
  const pattern = /(^|[^\w.$])import\s*\(/g;
  const found = [];

  let match;
  while ((match = pattern.exec(code)) !== null) {
    const at = match.index + match[1].length;
    const line = source.slice(0, at).split('\n').length;
    found.push({ line, snippet: source.split('\n')[line - 1]?.trim() ?? '' });
  }
  return found;
}

const MEASUREMENT_SOURCE = 'src/measurement.ts';

/**
 * The fixture's extreme values, read out of the source rather than restated here, so
 * changing the measurement cannot quietly turn this check into a no-op.
 */
export function measurementFingerprint(source) {
  const numbers = [...source.matchAll(/(?<![\w.])\d+\.\d+(?![\w.])/g)].map((match) => match[0]);
  if (numbers.length < 4) return [];
  // First and last of each array: distinctive enough, and stable across reorderings
  // that do not change the data.
  return [...new Set([numbers[0], numbers.at(-1)])].filter((value) => value !== undefined);
}

const bundlePath = process.argv[2] ?? DEFAULT_BUNDLE;

let source;
try {
  source = readFileSync(bundlePath, 'utf8');
} catch (error) {
  console.error(`check-bundle: cannot read ${bundlePath} — build it first.`);
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}

const offenders = findDynamicImports(source);

if (offenders.length > 0) {
  console.error('');
  console.error(`check-bundle: ${bundlePath} contains ${offenders.length} dynamic import(s).`);
  console.error('pkg cannot execute those; the packaged .exe would fail at runtime with');
  console.error('"A dynamic import callback was not specified".');
  console.error('');
  for (const { line, snippet } of offenders) {
    console.error(`  ${bundlePath}:${line}  ${snippet}`);
  }
  console.error('');
  console.error('Fix: load the module with createRequire(import.meta.url) instead, or add');
  console.error('it to noExternal in tsup.config.ts so esbuild inlines it.');
  console.error('');
  process.exit(1);
}

console.log(`check-bundle: ${bundlePath} is free of dynamic imports.`);

let measurementSource;
try {
  measurementSource = readFileSync(MEASUREMENT_SOURCE, 'utf8');
} catch {
  console.error(`check-bundle: cannot read ${MEASUREMENT_SOURCE}.`);
  process.exit(1);
}

const fingerprint = measurementFingerprint(measurementSource);
const leaked = fingerprint.filter((value) => source.includes(value));

if (fingerprint.length === 0) {
  console.error(`check-bundle: found no numbers in ${MEASUREMENT_SOURCE} to fingerprint.`);
  console.error('The guard would pass vacuously, which is worse than failing.');
  process.exit(1);
}

if (leaked.length === fingerprint.length) {
  console.error('');
  console.error(`check-bundle: ${bundlePath} appears to contain the calibration fixture.`);
  console.error(`Values from ${MEASUREMENT_SOURCE} found in the bundle: ${leaked.join(', ')}`);
  console.error('');
  console.error('That module is documentation and test data. Something in the daemon');
  console.error('imported it; move whatever is needed into src/calibrate.ts instead.');
  console.error('');
  process.exit(1);
}

console.log(`check-bundle: ${bundlePath} does not carry the ${MEASUREMENT_SOURCE} fixture.`);
