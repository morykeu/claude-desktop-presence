/**
 * Plan usage.
 *
 * File: %APPDATA%\Claude\plan-usage-history.json — it STAYED in Roaming; it did not
 * move to Local along with the logs (SPEC §0).
 *
 * Verified format:
 *   {"version":2,"samples":[{"t":1786058038582,"org":"<uuid>","u":{"fh":55,"sd":22}}]}
 *
 * `u.fh` and `u.sd` are two percentages over two different usage windows. WHICH
 * windows is an interpretation — Anthropic documents none of this — so nothing in this
 * module, in the presence text, or in the daemon log calls them "5 h" or "week". They
 * are the short window and the long window. See README.
 *
 * PRIVACY (SPEC §5): `org` is an organisation identifier. It is never returned, never
 * cached, and never written to the daemon log. Only `t` and the two percentages leave
 * this module.
 *
 * Three practical constraints:
 *
 * 1. Do not read it every tick. It is rewritten on the order of minutes, so one read
 *    a minute with a cached value in between is plenty.
 * 2. It grows — 52 kB when measured, plus a sample every few minutes. Past
 *    LARGE_FILE_BYTES only the tail is read and the last complete sample object is
 *    picked out of it, instead of parsing the whole file.
 * 3. The write is not necessarily atomic, so a read can land mid-write. A parse
 *    failure returns the LAST KNOWN value, not null. Only a genuinely missing file
 *    returns null.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { parseJson } from '../json.js';
import type { Logger } from '../log.js';

export const PLAN_USAGE_FILENAME = 'plan-usage-history.json';

/** How often the file is actually read. Cached in between. */
export const READ_INTERVAL_MS = 60_000;

/** Past this size the file is read from the tail instead of whole. */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;

/** How much of the tail is read in that case. One sample is well under 100 bytes. */
export const TAIL_READ_BYTES = 64 * 1024;

/** Bound on how many candidate objects the tail scan will try. */
const MAX_TAIL_CANDIDATES = 200;

const WARN_THROTTLE_MS = 5 * 60_000;

export interface PlanUsage {
  /**
   * Raw `u.fh`, in percent. The shorter of the two windows; the common reading is
   * five hours, but that is a guess checked against the UI by eye, not a spec.
   */
  shortWindowPercent: number;
  /** Raw `u.sd`, in percent. The longer window — likewise an interpretation. */
  longWindowPercent: number;
  /** Timestamp of the sample this came from. */
  at: Date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One raw sample -> PlanUsage. `org` is simply never read, which is the cheapest
 * possible guarantee that it cannot leak.
 */
export function toPlanUsage(sample: unknown): PlanUsage | null {
  if (!isPlainObject(sample)) return null;

  const at = toFinite(sample['t']);
  const usage = sample['u'];
  if (at === null || !isPlainObject(usage)) return null;

  const shortWindowPercent = toFinite(usage['fh']);
  const longWindowPercent = toFinite(usage['sd']);
  if (shortWindowPercent === null || longWindowPercent === null) return null;

  return { shortWindowPercent, longWindowPercent, at: new Date(at) };
}

/** Parses the whole file and returns the newest sample by `t`. */
export function parsePlanUsage(text: string): PlanUsage | null {
  let parsed: unknown;
  try {
    parsed = parseJson(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const samples = parsed['samples'];
  if (!Array.isArray(samples)) return null;

  let newest: PlanUsage | null = null;
  for (const sample of samples) {
    const usage = toPlanUsage(sample);
    if (usage === null) continue;
    if (newest === null || usage.at.getTime() > newest.at.getTime()) newest = usage;
  }
  return newest;
}

/** Index of the closing brace matching the one at `start`, or -1. String-aware. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Finds the last COMPLETE sample object in a tail chunk.
 *
 * Scanning backwards means a chunk that starts mid-object, or a file caught mid-write
 * with a truncated final sample, both fall back to the last object that actually
 * parses. The nested `{"fh":..,"sd":..}` is tried first and rejected, because it has
 * no `t`.
 */
export function parsePlanUsageTail(text: string): PlanUsage | null {
  let tried = 0;
  for (let start = text.lastIndexOf('{'); start !== -1; start = text.lastIndexOf('{', start - 1)) {
    if (tried++ >= MAX_TAIL_CANDIDATES) break;

    const end = matchBrace(text, start);
    if (end === -1) continue;

    try {
      const usage = toPlanUsage(JSON.parse(text.slice(start, end + 1)));
      if (usage !== null) return usage;
    } catch {
      // Not a complete object; keep walking backwards.
    }
  }
  return null;
}

/** %APPDATA%\Claude\plan-usage-history.json, or null when APPDATA is not set. */
export function resolvePlanUsagePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const roaming = env['APPDATA'];
  if (roaming === undefined || roaming === '') return null;
  return path.join(roaming, 'Claude', PLAN_USAGE_FILENAME);
}

export interface PlanUsageReaderOptions {
  /** Explicit path; defaults to resolvePlanUsagePath(). */
  filePath?: string | null;
  logger?: Logger;
  now?: () => number;
  /** Minimum gap between actual disk reads. */
  intervalMs?: number;
}

export interface PlanUsageReader {
  /** Cached between reads; hits the disk at most once per intervalMs. */
  read(): Promise<PlanUsage | null>;
  /** Last known value without touching the disk. */
  readonly last: PlanUsage | null;
}

export function createPlanUsageReader(options: PlanUsageReaderOptions = {}): PlanUsageReader {
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? READ_INTERVAL_MS;
  const filePath = options.filePath === undefined ? resolvePlanUsagePath() : options.filePath;

  let last: PlanUsage | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  let warnedAt = Number.NEGATIVE_INFINITY;

  function warnThrottled(message: string, fields?: Record<string, unknown>): void {
    const at = now();
    if (at - warnedAt < WARN_THROTTLE_MS) return;
    warnedAt = at;
    // Only ever our own wording plus sizes — never a slice of the file, which would
    // put the org UUID in the daemon log.
    options.logger?.warn(message, fields);
  }

  async function readFile(target: string): Promise<PlanUsage | null> {
    const stat = await fs.stat(target);

    if (stat.size <= LARGE_FILE_BYTES) {
      return parsePlanUsage(await fs.readFile(target, 'utf8'));
    }

    // Too big to parse whole: take the tail and find the last complete sample.
    const from = Math.max(0, stat.size - TAIL_READ_BYTES);
    const handle = await fs.open(target, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      return parsePlanUsageTail(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  return {
    get last() {
      return last;
    },

    async read(): Promise<PlanUsage | null> {
      if (filePath === null) return null;

      const at = now();
      if (at - readAt < intervalMs) return last;
      readAt = at;

      try {
        const parsed = await readFile(filePath);
        if (parsed !== null) {
          last = parsed;
        } else {
          // The file is there but did not parse — almost always a read that landed
          // mid-write. Keep the last good value rather than blanking the presence.
          warnThrottled('plan usage file did not parse, keeping the last known value');
        }
        return last;
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

        if (code === 'ENOENT') {
          // Genuinely absent is different from unreadable: there is nothing to show.
          last = null;
          return null;
        }
        warnThrottled('could not read the plan usage file, keeping the last known value', { code });
        return last;
      }
    },
  };
}

let shared: PlanUsageReader | null = null;

/** Convenience wrapper over a lazily created shared reader. */
export async function readPlanUsage(): Promise<PlanUsage | null> {
  shared ??= createPlanUsageReader();
  return shared.read();
}
