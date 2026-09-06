/**
 * Claude Desktop process detection and CPU sampling.
 *
 * Verified facts (SPEC §0, measured 2026-09-06 on Claude Desktop 1.46388.4.0, MSIX):
 *  - the process is called `claude.exe` (Electron: main, gpu, renderer, utility, ...)
 *  - THE PROCESS COUNT IS NOT CONSTANT — 12, 16 and 17 all observed. Never hardcode it,
 *    always iterate over whatever the query returns.
 *  - the main window has MainWindowTitle === "Claude", the rest are empty
 *  - the install path is MSIX (C:\Program Files\WindowsApps\Claude_<version>_x64__<hash>\)
 *    and changes with every version, so it must not be relied on
 *
 * CPU is NOT taken from `pidusage`: on Windows it reaches for `wmic`, which Microsoft
 * removed from Windows 11 and which does not exist on the target machine. CpuMs comes
 * from the same PowerShell query as everything else, i.e. one spawn per sample.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

import type { Logger } from '../log.js';
import type { PresenceState } from '../state.js';

export const PROCESS_NAME = 'claude.exe';

/** The Claude Desktop main window has exactly this title. */
export const MAIN_WINDOW_TITLE = 'Claude';

/** How many samples feed the CPU moving average (at BUSY/ACTIVE, 5 x 2 s = 10 s). */
export const CPU_SAMPLE_WINDOW = 5;

/**
 * Adaptive sampling period per state. TOOL shares the BUSY interval.
 *
 * Spawning PowerShell every 2 s is ~1800 processes an hour and the daemon would burn
 * the very CPU it is supposed to measure. Discord will not accept presence updates
 * faster than 15 s anyway, so denser sampling while idle buys nothing.
 */
export const SAMPLE_INTERVAL_MS: Record<PresenceState, number> = {
  BUSY: 2_000,
  TOOL: 2_000,
  ACTIVE: 2_000,
  IDLE: 10_000,
  OFFLINE: 30_000,
};

/** config.pollIntervalMs is a lower bound, not a fixed period. */
export function sampleIntervalFor(state: PresenceState, pollIntervalMs: number): number {
  return Math.max(pollIntervalMs, SAMPLE_INTERVAL_MS[state]);
}

/**
 * The verified query. StartTime has to be formatted to ISO inside PowerShell —
 * ConvertTo-Json would otherwise emit it as /Date(1788649144131)/.
 */
export const POWERSHELL_QUERY = [
  'Get-Process claude -ErrorAction SilentlyContinue |',
  '  Select-Object Id, MainWindowTitle,',
  "    @{n='StartIso';e={$_.StartTime.ToUniversalTime().ToString('o')}},",
  "    @{n='CpuMs';e={$_.TotalProcessorTime.TotalMilliseconds}} |",
  '  ConvertTo-Json -Compress',
].join('\n');

/** Console output is forced to UTF-8 — paths contain diacritics and would come back as mojibake. */
const UTF8_PREAMBLE = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;';

const CORE_COUNT_QUERY = '[Environment]::ProcessorCount';

/** A PowerShell call that hangs must not stall the main loop. */
const QUERY_TIMEOUT_MS = 10_000;

/** One row from the PowerShell query, before normalisation. */
export interface RawProcessRow {
  Id: number;
  MainWindowTitle: string;
  /** ISO 8601 in UTC; null when StartTime could not be read. */
  StartIso: string | null;
  /** TotalProcessorTime.TotalMilliseconds — cumulative since process start. */
  CpuMs: number;
}

export type ClaudeProcessInfo = {
  running: boolean;
  /** The process with a non-empty window title. */
  mainPid: number | null;
  allPids: number[];
  /**
   * The OLDEST StartIso across all claude processes, frozen until the daemon goes
   * OFFLINE. Feeds the Discord startTimestamp — it must not jump, or the elapsed
   * counter resets. A renderer restart changes the main window PID but not the
   * oldest start, which is exactly why the main process start is not used.
   */
  startTime: Date | null;
  /**
   * Summed across all processes, in PERCENT OF ONE CORE — not divided by the core
   * count. Can exceed 100. See computeCpuPercent for why.
   */
  cpuPercent: number;
};

const EMPTY_INFO: ClaudeProcessInfo = {
  running: false,
  mainPid: null,
  allPids: [],
  startTime: null,
  cpuPercent: 0,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Normalises the query output into an array.
 *
 * ConvertTo-Json emits a bare object for a single process and an array for several,
 * so a lone claude.exe (during startup, or a leftover) would otherwise crash the parse.
 * Anything unparseable yields an empty array — the daemon degrades to "not running"
 * rather than dying.
 */
export function parseProcessRows(stdout: string): RawProcessRow[] {
  const trimmed = stdout.replace(/^\uFEFF/, '').trim();
  if (trimmed === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (parsed === null) return [];

  const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const rows: RawProcessRow[] = [];

  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) continue;

    const id = toFiniteNumber(candidate['Id']);
    if (id === null) continue;

    const startIso = candidate['StartIso'];
    const cpuMs = toFiniteNumber(candidate['CpuMs']);
    const title = candidate['MainWindowTitle'];

    rows.push({
      Id: id,
      MainWindowTitle: typeof title === 'string' ? title : '',
      StartIso: typeof startIso === 'string' && startIso !== '' ? startIso : null,
      // CpuMs can be null when the process denies access; treat it as zero so the
      // row still counts towards "running" without polluting the delta.
      CpuMs: cpuMs ?? 0,
    });
  }
  return rows;
}

/** The process with a window title; prefers the exact "Claude" match. */
export function pickMainPid(rows: readonly RawProcessRow[]): number | null {
  const titled = rows.filter((row) => row.MainWindowTitle.trim() !== '');
  if (titled.length === 0) return null;
  const exact = titled.find((row) => row.MainWindowTitle === MAIN_WINDOW_TITLE);
  return (exact ?? titled[0])?.Id ?? null;
}

/** The oldest valid StartIso, or null when none of the rows carry one. */
export function pickOldestStart(rows: readonly RawProcessRow[]): Date | null {
  let oldest: Date | null = null;
  for (const row of rows) {
    if (row.StartIso === null) continue;
    const parsed = new Date(row.StartIso);
    if (Number.isNaN(parsed.getTime())) continue;
    if (oldest === null || parsed.getTime() < oldest.getTime()) oldest = parsed;
  }
  return oldest;
}

export type CpuByPid = ReadonlyMap<number, number>;

export function cpuByPid(rows: readonly RawProcessRow[]): Map<number, number> {
  return new Map(rows.map((row) => [row.Id, row.CpuMs]));
}

/**
 * CPU usage between two samples, in PERCENT OF ONE CORE. The value can exceed 100
 * when several claude.exe processes are busy at once.
 *
 * The core count is deliberately NOT in the formula. Measured on the target machine
 * (12 cores) during real agentic work: 3.9 % of one core, which normalised across all
 * cores is 0.32 % — Electron is largely single-threaded, so dividing by the core count
 * dilutes the signal into noise. See SPEC §3.
 *
 * Only PIDs present in BOTH samples contribute. CpuMs is cumulative since process
 * start, so a renderer that disappeared (or one that is brand new) would otherwise
 * produce a bogus delta. Per-PID deltas are clamped at zero for the same reason —
 * a recycled PID can report less CPU than its predecessor.
 */
export function computeCpuPercent(
  previous: CpuByPid,
  current: CpuByPid,
  elapsedMs: number
): number {
  if (elapsedMs <= 0) return 0;

  let deltaMs = 0;
  for (const [pid, cpuMs] of current) {
    const before = previous.get(pid);
    if (before === undefined) continue;
    const delta = cpuMs - before;
    if (delta > 0) deltaMs += delta;
  }

  return Math.max(0, (deltaMs / elapsedMs) * 100);
}

/**
 * Linear-interpolated percentile over an unsorted sample list.
 * Used for the rolling BUSY baseline and for --calibrate.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? 0;

  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low] ?? 0;
  if (low === high) return lowValue;
  return lowValue + ((sorted[high] ?? 0) - lowValue) * (rank - low);
}

/** Moving average over the last CPU_SAMPLE_WINDOW values. */
export class MovingAverage {
  private readonly values: number[] = [];

  constructor(private readonly size: number = CPU_SAMPLE_WINDOW) {}

  push(value: number): number {
    this.values.push(value);
    if (this.values.length > this.size) this.values.shift();
    return this.value;
  }

  get value(): number {
    if (this.values.length === 0) return 0;
    const sum = this.values.reduce((total, value) => total + value, 0);
    return sum / this.values.length;
  }

  reset(): void {
    this.values.length = 0;
  }
}

export interface ProcessSamplerOptions {
  logger?: Logger;
  /** Injection point for tests: returns the raw stdout of the query. */
  runQuery?: () => Promise<string>;
  /** Injection point for tests: current time in ms. */
  now?: () => number;
  /**
   * Core count. Queried from PowerShell once at startup when omitted. NOT part of the
   * cpuPercent formula — it is only reported by --calibrate so the numbers can be put
   * in context.
   */
  cores?: number;
}

export interface ProcessSampler {
  sample(): Promise<ClaudeProcessInfo>;
  /** Last known value, without touching PowerShell. */
  readonly last: ClaudeProcessInfo;
  /** Reported core count, for putting --calibrate numbers in context. */
  cores(): Promise<number>;
}

/** Runs a PowerShell snippet and returns stdout. Never throws — returns '' on failure. */
async function runPowerShell(script: string, logger?: Logger): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', UTF8_PREAMBLE + script],
      { windowsHide: true }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      logger?.warn('PowerShell query timed out', { timeoutMs: QUERY_TIMEOUT_MS });
      child.kill();
      finish('');
    }, QUERY_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error: Error) => {
      logger?.warn('PowerShell could not be started', { error: error.message });
      finish('');
    });

    child.on('close', (code) => {
      if (code !== 0 && stderr.trim() !== '') {
        logger?.warn('PowerShell query failed', { code, stderr: stderr.trim().slice(0, 200) });
      }
      finish(stdout);
    });
  });
}

/** Core count via [Environment]::ProcessorCount, with a Node fallback. */
export async function detectCoreCount(logger?: Logger): Promise<number> {
  const output = await runPowerShell(CORE_COUNT_QUERY, logger);
  const parsed = Number.parseInt(output.trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;

  const fallback = os.availableParallelism?.() ?? os.cpus().length;
  logger?.warn('could not read ProcessorCount, falling back to os', { cores: fallback });
  return Math.max(1, fallback);
}

export function createProcessSampler(options: ProcessSamplerOptions = {}): ProcessSampler {
  const now = options.now ?? (() => Date.now());
  const runQuery = options.runQuery ?? (() => runPowerShell(POWERSHELL_QUERY, options.logger));
  const average = new MovingAverage(CPU_SAMPLE_WINDOW);

  let cores = options.cores ?? 0;
  let previous: { at: number; cpu: CpuByPid } | null = null;
  let frozenStart: Date | null = null;
  let last: ClaudeProcessInfo = EMPTY_INFO;
  let inFlight: Promise<ClaudeProcessInfo> | null = null;

  /** Only for reporting (--calibrate); never enters the cpuPercent formula. */
  async function reportedCores(): Promise<number> {
    if (cores <= 0) cores = await detectCoreCount(options.logger);
    return cores;
  }

  /**
   * Freeze rules: hold the first observed oldest start for the whole session, drop it
   * on OFFLINE, and adopt a strictly newer one. Within one session the oldest process
   * (the Electron main process) outlives its children, so the oldest start can only
   * move forward if the app was actually restarted.
   */
  function updateStart(observed: Date | null): Date | null {
    if (observed === null) return frozenStart;
    if (frozenStart === null || observed.getTime() > frozenStart.getTime()) {
      frozenStart = observed;
    }
    return frozenStart;
  }

  async function takeSample(): Promise<ClaudeProcessInfo> {
    const stdout = await runQuery();
    const rows = parseProcessRows(stdout);
    const at = now();

    if (rows.length === 0) {
      previous = null;
      frozenStart = null;
      average.reset();
      last = EMPTY_INFO;
      return last;
    }

    const current = cpuByPid(rows);
    const cpuPercent =
      previous === null
        ? average.value
        : average.push(computeCpuPercent(previous.cpu, current, at - previous.at));
    previous = { at, cpu: current };

    last = {
      running: true,
      mainPid: pickMainPid(rows),
      allPids: rows.map((row) => row.Id),
      startTime: updateStart(pickOldestStart(rows)),
      cpuPercent,
    };
    return last;
  }

  return {
    get last() {
      return last;
    },
    cores: reportedCores,
    async sample(): Promise<ClaudeProcessInfo> {
      // A slow PowerShell must not pile up overlapping spawns; callers share the
      // in-flight query instead.
      inFlight ??= takeSample().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
