/**
 * The `--debug` tick line.
 *
 * Its own module rather than part of `index.ts`, because `index.ts` calls `main()` at
 * import time — importing it to borrow one pure formatter would start a daemon. The
 * README's `--debug` example is generated from this function (`npm run docs:sync`), and
 * the example is one of the things that went stale by being retyped, so it had to
 * become importable.
 */

import type { ActivityPayload } from './discord/presence.js';
import type { StateResult } from './state.js';

/** Deliberately one line, so a long run stays readable. */
export function formatDebugLine(
  result: StateResult,
  cpuPercent: number,
  payload: ActivityPayload | null
): string {
  const numbers = [
    `cpu=${cpuPercent.toFixed(2)}%`,
    `baseline=${result.cpuBaseline.toFixed(2)}%`,
    `threshold=${result.cpuThreshold.toFixed(2)}%`,
    `reason=${result.reason}`,
  ].join(' ');

  const shown =
    payload === null
      ? 'payload=<cleared>'
      : `details=${JSON.stringify(payload.details)} state=${JSON.stringify(payload.state ?? '')}`;

  // Both halves of the warmup are worth seeing: that the floor is still being learned,
  // and that a CPU-driven BUSY is being held back because of it.
  const marks = [
    result.warmingUp ? 'warmup' : '',
    result.publish ? '' : 'NOT PUBLISHED (warmup)',
  ].filter((mark) => mark !== '');
  const suffix = marks.length > 0 ? '  <- ' + marks.join(', ') : '';

  return `${result.state.padEnd(7)} ${numbers} ${shown}${suffix}`;
}
