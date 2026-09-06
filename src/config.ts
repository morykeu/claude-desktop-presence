/**
 * Loading and validation of config.json.
 *
 * Where the config lives, highest priority first:
 *   1. --config <path> on the command line
 *   2. next to the .exe when packaged with pkg (process.pkg is set)
 *   3. next to the entry module
 *
 * cwd is deliberately NOT used: in P7 the daemon runs as a Scheduled Task, whose
 * working directory is typically C:\Windows\System32. It would look for the config
 * there and — worse — write the template there.
 *
 * The module is split into a pure part (parseConfig / loadConfig, nothing kills the
 * process) and a thin loadConfigOrExit wrapper that prints and calls process.exit(1).
 * Purely for testability — exit is awkward to capture in tests.
 *
 * User-facing diagnostics are English (this repo is going public). Text that ends up
 * in the Discord presence is NOT hardcoded — it lives in the `text` section of the
 * config so it can be translated; config.example.json ships Czech defaults.
 */

import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { BusyCalibration } from './state.js';
import type { Logger } from './log.js';

/** Visibility switches for the individual values in the presence (SPEC §5 — privacy). */
export interface ShowFlags {
  planUsage: boolean;
  appVersion: boolean;
  mcpServerCount: boolean;
  toolNames: boolean;
  elapsedTime: boolean;
}

/**
 * Presence strings. Placeholders in braces are substituted at render time;
 * an unknown placeholder is left as-is rather than throwing.
 */
export interface TextTemplates {
  /** Real application name. The Discord header shows the app (C.L.A.U.D.E), so it has to appear here. */
  appName: string;
  /** First presence line. Placeholders: {app}, {status} */
  detailsFormat: string;
  statusBusy: string;
  /** Placeholder: {tool} */
  statusTool: string;
  statusActive: string;
  statusIdle: string;
  /** Second line, rotating. Placeholder: {percent} */
  planUsageFiveHour: string;
  /** Placeholder: {percent} */
  planUsageWeek: string;
  /** Placeholder: {version} */
  appVersion: string;
  /** Placeholder: {count} */
  mcpServerCount: string;
  /** Tooltip of the large icon. Placeholders: {app}, {version} */
  largeImageText: string;
}

export interface Config {
  /** Discord Application ID, 17-20 digits. A public value, not a secret. */
  clientId: string;
  /** Lower bound for the polling interval. See SAMPLE_INTERVAL_MS — not a fixed period. */
  pollIntervalMs: number;
  /** Minimum gap between setActivity calls. Discord throttles — never below 15 s. */
  presenceMinIntervalMs: number;
  /** Self-calibrating BUSY detection. Replaced the old fixed busyCpuThresholdPercent. */
  busy: BusyCalibration;
  show: ShowFlags;
  text: TextTemplates;
  /** Manual override of the Claude Desktop log directory; null = autodetect. */
  logDirOverride: string | null;
  debug: boolean;
}

export const CONFIG_FILENAME = 'config.json';
export const EXAMPLE_FILENAME = 'config.example.json';

/** Discord throttles presence updates; the config must not go below this. */
export const PRESENCE_MIN_INTERVAL_FLOOR_MS = 15_000;

/**
 * Fallback for when config.example.json is missing next to the .exe (easy to happen
 * with a packaged build). Must match config.example.json in the repo byte for byte —
 * a test enforces that.
 */
export const EXAMPLE_CONFIG_JSON = [
  '{',
  '  "clientId": "SEM_APPLICATION_ID",',
  '  "pollIntervalMs": 2000,',
  '  "presenceMinIntervalMs": 15000,',
  '  "busy": {',
  '    "baselineWindowSec": 300,',
  '    "baselinePercentile": 10,',
  '    "thresholdMultiplier": 3,',
  '    "thresholdDeltaPercent": 1.5,',
  '    "exitFactor": 0.6',
  '  },',
  '  "show": {',
  '    "planUsage": true,',
  '    "appVersion": true,',
  '    "mcpServerCount": true,',
  '    "toolNames": true,',
  '    "elapsedTime": true',
  '  },',
  '  "text": {',
  '    "appName": "Claude Desktop",',
  '    "detailsFormat": "{app} — {status}",',
  '    "statusBusy": "Pracuje…",',
  '    "statusTool": "Nástroj: {tool}",',
  '    "statusActive": "Aktivní chat",',
  '    "statusIdle": "Nečinný",',
  '    "planUsageFiveHour": "Vytížení 5h: {percent} %",',
  '    "planUsageWeek": "Vytížení týden: {percent} %",',
  '    "appVersion": "Verze {version}",',
  '    "mcpServerCount": "MCP: {count} serverů",',
  '    "largeImageText": "{app} {version}"',
  '  },',
  '  "logDirOverride": null,',
  '  "debug": false',
  '}',
  '',
].join('\n');

/** Keeps zod from emitting half the diagnostics in its own wording. */
const bool = () => z.boolean({ error: 'must be true or false' });
const int = () => z.number({ error: 'must be a whole number' }).int('must be a whole number');
const text = (fallback: string) => z.string({ error: 'must be a string' }).default(fallback);

/**
 * Defaults come from the measurement on the target machine: idle floor around 0.3 %
 * of one core, real agentic work around 3.9 %. A 3x rise with an absolute floor of
 * 1.5 points sits comfortably between the two. `--calibrate` recomputes them for any
 * other machine.
 */
const busySchema = z.object({
  baselineWindowSec: int()
    .min(30, 'the minimum is 30 s')
    .max(3600, 'the maximum is 3600 s')
    .default(300),
  baselinePercentile: z
    .number({ error: 'must be a number' })
    .min(1, 'the range is 1-50')
    .max(50, 'the range is 1-50')
    .default(10),
  thresholdMultiplier: z
    .number({ error: 'must be a number' })
    .min(1, 'must be at least 1 (1 = no multiplier)')
    .max(100, 'the maximum is 100')
    .default(3),
  thresholdDeltaPercent: z
    .number({ error: 'must be a number' })
    .min(0.1, 'the minimum is 0.1 (percent of one core)')
    .max(400, 'the maximum is 400 (percent of one core)')
    .default(1.5),
  exitFactor: z
    .number({ error: 'must be a number' })
    .min(0.1, 'the range is 0.1-1')
    .max(1, 'the range is 0.1-1')
    .default(0.6),
});

const showSchema = z.object({
  planUsage: bool().default(true),
  appVersion: bool().default(true),
  mcpServerCount: bool().default(true),
  toolNames: bool().default(true),
  elapsedTime: bool().default(true),
});

const textSchema = z.object({
  appName: text('Claude Desktop'),
  detailsFormat: text('{app} — {status}'),
  statusBusy: text('Pracuje…'),
  statusTool: text('Nástroj: {tool}'),
  statusActive: text('Aktivní chat'),
  statusIdle: text('Nečinný'),
  planUsageFiveHour: text('Vytížení 5h: {percent} %'),
  planUsageWeek: text('Vytížení týden: {percent} %'),
  appVersion: text('Verze {version}'),
  mcpServerCount: text('MCP: {count} serverů'),
  largeImageText: text('{app} {version}'),
});

export const configSchema = z.object({
  clientId: z
    .string({ error: 'missing — fill in the Application ID from the Discord Developer Portal' })
    .regex(/^\d{17,20}$/, 'must be 17-20 digits (a Discord Application ID)'),
  pollIntervalMs: int().min(500, 'the minimum is 500 ms').default(2000),
  presenceMinIntervalMs: int()
    .min(
      PRESENCE_MIN_INTERVAL_FLOOR_MS,
      'the minimum is 15000 ms — Discord throttles presence updates and drops anything faster'
    )
    .default(PRESENCE_MIN_INTERVAL_FLOOR_MS),
  busy: busySchema.prefault({}),
  // prefault, not default: an empty object is run through the schema, so the
  // per-field defaults apply and do not have to be repeated here.
  show: showSchema.prefault({}),
  text: textSchema.prefault({}),
  logDirOverride: z.string({ error: 'must be a directory path, or null' }).nullable().default(null),
  debug: bool().default(false),
});

// Compile-time check that the zod schema still matches the hand-written Config type.
const _schemaMatchesConfig: (parsed: z.infer<typeof configSchema>) => Config = (parsed) => parsed;
void _schemaMatchesConfig;

const KNOWN_KEYS = Object.keys(configSchema.shape);
const KNOWN_SHOW_KEYS = Object.keys(showSchema.shape);
const KNOWN_TEXT_KEYS = Object.keys(textSchema.shape);
const KNOWN_BUSY_KEYS = Object.keys(busySchema.shape);

/** Levenshtein distance, iterative with a single row. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Closest known key, or null when nothing is close enough. The tolerance scales with
 * the key length so short keys do not match everything.
 *
 * The known key is also compared truncated to the length of the typo. Without that,
 * "presenceMinInterval" would never reach "presenceMinIntervalMs" — a short suffix is
 * enough to push a single-letter typo past any sane tolerance.
 */
export function suggestKey(unknownKey: string, knownKeys: readonly string[]): string | null {
  const needle = unknownKey.toLowerCase();
  const tolerance = Math.max(1, Math.min(3, Math.floor(needle.length / 3)));
  let best: { key: string; distance: number } | null = null;

  for (const known of knownKeys) {
    const haystack = known.toLowerCase();
    const distance = Math.min(
      levenshtein(needle, haystack),
      levenshtein(needle, haystack.slice(0, needle.length))
    );
    if (distance <= tolerance && (best === null || distance < best.distance)) {
      best = { key: known, distance };
    }
  }
  return best?.key ?? null;
}

export type ParseResult =
  { ok: true; config: Config; warnings: string[] } | { ok: false; problems: string[] };

function unknownKeyWarning(prefix: string, key: string, known: readonly string[]): string {
  const suggestion = suggestKey(key, known);
  const label = prefix + key;
  return suggestion === null
    ? `unknown key "${label}" — ignored`
    : `unknown key "${label}" — ignored; did you mean "${prefix}${suggestion}"?`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Unknown keys are not fatal (forward compatibility), but they are reported. */
function collectUnknownKeys(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];

  const warnings = Object.keys(raw)
    .filter((key) => !KNOWN_KEYS.includes(key))
    .map((key) => unknownKeyWarning('', key, KNOWN_KEYS));

  const nested: [string, readonly string[]][] = [
    ['busy', KNOWN_BUSY_KEYS],
    ['show', KNOWN_SHOW_KEYS],
    ['text', KNOWN_TEXT_KEYS],
  ];
  for (const [section, knownKeys] of nested) {
    const value: unknown = raw[section];
    if (!isPlainObject(value)) continue;
    for (const key of Object.keys(value)) {
      if (!knownKeys.includes(key)) {
        warnings.push(unknownKeyWarning(section + '.', key, knownKeys));
      }
    }
  }
  return warnings;
}

/** One zod issue, one readable line. No stack trace, no JSON dump. */
function formatIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.length > 0 ? issue.path.join('.') : '(config root)';
  return where + ': ' + issue.message;
}

/** Pure validation — no IO, no exit. */
export function parseConfig(raw: unknown): ParseResult {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, problems: result.error.issues.map(formatIssue) };
  }
  return { ok: true, config: result.data, warnings: collectUnknownKeys(raw) };
}

/** True when running from a binary produced by @yao-pkg/pkg. */
function isPackaged(): boolean {
  return typeof (process as { pkg?: unknown }).pkg !== 'undefined';
}

/**
 * Directory the config is looked up in when --config is not given.
 * Never cwd — see the module header.
 */
export function resolveBaseDir(): string {
  if (isPackaged()) return path.dirname(process.execPath);

  // process.argv[1] is the entry module and works the same in both the ESM and the
  // CJS build; import.meta.url would not survive the CJS output.
  const entry = process.argv[1];
  if (entry !== undefined && entry !== '') return path.dirname(path.resolve(entry));

  return process.cwd();
}

/** Reads `--config <path>` / `--config=<path>` out of the argument list. */
export function parseCliConfigPath(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--config') {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith('--') ? next : null;
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      return value === '' ? null : value;
    }
  }
  return null;
}

export interface LoadOptions {
  /** Explicit path to the config file. Wins over everything else. */
  configPath?: string;
  /** Directory to look in. Default: resolveBaseDir(). */
  baseDir?: string;
  /** Command line to read --config from. Default: process.argv.slice(2). */
  argv?: readonly string[];
}

/** Resolves the final config path from options, the command line and the base directory. */
export function resolveConfigPath(options: LoadOptions = {}): string {
  if (options.configPath !== undefined) return path.resolve(options.configPath);

  const fromCli = parseCliConfigPath(options.argv ?? process.argv.slice(2));
  if (fromCli !== null) {
    const resolved = path.resolve(fromCli);
    // A directory is accepted too, as a convenience.
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      return path.join(resolved, CONFIG_FILENAME);
    }
    return resolved;
  }

  return path.join(options.baseDir ?? resolveBaseDir(), CONFIG_FILENAME);
}

export type LoadResult =
  | { ok: true; config: Config; configPath: string; warnings: string[] }
  | { ok: false; configPath: string; problems: string[]; createdExample: boolean };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads and validates the config. When it is missing, creates it from
 * config.example.json (or from the embedded template) and returns ok:false with a
 * prompt to fill in clientId. Never calls process.exit — that is loadConfigOrExit.
 */
export function loadConfig(options: LoadOptions = {}): LoadResult {
  const configPath = resolveConfigPath(options);

  if (!existsSync(configPath)) {
    const examplePath = path.join(path.dirname(configPath), EXAMPLE_FILENAME);
    try {
      if (existsSync(examplePath)) {
        copyFileSync(examplePath, configPath);
      } else {
        writeFileSync(configPath, EXAMPLE_CONFIG_JSON, 'utf8');
      }
    } catch (error) {
      return {
        ok: false,
        configPath,
        createdExample: false,
        problems: [`could not create ${configPath}: ${describeError(error)}`],
      };
    }
    return {
      ok: false,
      configPath,
      createdExample: true,
      problems: [
        `created ${CONFIG_FILENAME} — open it and fill in "clientId" (the Application ID from https://discord.com/developers/applications)`,
      ],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    const message = describeError(error);
    const problem =
      error instanceof SyntaxError
        ? `not valid JSON — ${message}`
        : `could not be read: ${message}`;
    return { ok: false, configPath, createdExample: false, problems: [problem] };
  }

  const parsed = parseConfig(raw);
  if (!parsed.ok) {
    return { ok: false, configPath, createdExample: false, problems: parsed.problems };
  }
  return { ok: true, config: parsed.config, configPath, warnings: parsed.warnings };
}

/** The message the user sees — readable, free of zod internals. */
export function formatLoadFailure(result: Extract<LoadResult, { ok: false }>): string {
  const header = result.createdExample
    ? 'No configuration found.'
    : `Invalid configuration (${result.configPath}):`;
  return [header, ...result.problems.map((problem) => '  • ' + problem)].join('\n');
}

export interface LoadOrExitOptions extends LoadOptions {
  /**
   * Daemon logger. Warnings go here as well as to the console — in production
   * (Scheduled Task, no window) the console goes nowhere.
   *
   * The config has to be read before the logger can be built, so P7 will either pass
   * a bootstrap logger here or replay result.warnings once the real one exists.
   */
  logger?: Logger;
}

/**
 * Entrypoint wrapper: prints a readable message and exits with code 1 on failure.
 * Warnings (unknown keys) are reported but do not stop the daemon.
 */
export function loadConfigOrExit(options: LoadOrExitOptions = {}): Config {
  const result = loadConfig(options);
  if (!result.ok) {
    console.error(formatLoadFailure(result));
    process.exit(1);
  }
  for (const warning of result.warnings) {
    const message = `config warning (${result.configPath}): ${warning}`;
    options.logger?.warn(message);
    console.warn(message);
  }
  return result.config;
}
