/**
 * Načtení a validace config.json.
 *
 * Config leží vedle spustitelného souboru: u zabaleného .exe je to adresář exe,
 * ve vývoji cwd. Když neexistuje, vytvoří se z config.example.json a daemon skončí
 * s výzvou, ať uživatel doplní clientId.
 *
 * Modul je rozdělený na čistou část (parseConfig / loadConfig, nic nezabíjí proces)
 * a tenkou obálku loadConfigOrExit, která teprve tiskne a volá process.exit(1).
 * Kvůli testovatelnosti — exit se v testech špatně chytá.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Přepínače viditelnosti jednotlivých údajů v presence (SPEC §5 — soukromí). */
export interface ShowFlags {
  planUsage: boolean;
  appVersion: boolean;
  mcpServerCount: boolean;
  toolNames: boolean;
  elapsedTime: boolean;
}

export interface Config {
  /** Discord Application ID, 17–20 číslic. Veřejná hodnota, není to tajemství. */
  clientId: string;
  /** Perioda hlavní smyčky. Min. 500 ms. */
  pollIntervalMs: number;
  /** Minimální rozestup mezi setActivity. Discord throttluje — pod 15 s nepovolit. */
  presenceMinIntervalMs: number;
  /** Práh CPU (%) pro přechod do BUSY. Závisí na stroji, proto v configu. */
  busyCpuThresholdPercent: number;
  show: ShowFlags;
  /** Ruční přepis adresáře s logy Claude Desktopu; null = autodetekce. */
  logDirOverride: string | null;
  debug: boolean;
}

export const CONFIG_FILENAME = 'config.json';
export const EXAMPLE_FILENAME = 'config.example.json';

/** Discord throttluje presence; pod tuhle hodnotu se nesmí jít ani configem. */
export const PRESENCE_MIN_INTERVAL_FLOOR_MS = 15_000;

/**
 * Záloha pro případ, že vedle exe chybí config.example.json (u zabaleného buildu
 * se to stane snadno). Musí být bajt po bajtu shodná s config.example.json v repu —
 * hlídá to test.
 */
export const EXAMPLE_CONFIG_JSON = [
  '{',
  '  "clientId": "SEM_APPLICATION_ID",',
  '  "pollIntervalMs": 2000,',
  '  "presenceMinIntervalMs": 15000,',
  '  "busyCpuThresholdPercent": 12,',
  '  "show": {',
  '    "planUsage": true,',
  '    "appVersion": true,',
  '    "mcpServerCount": true,',
  '    "toolNames": true,',
  '    "elapsedTime": true',
  '  },',
  '  "logDirOverride": null,',
  '  "debug": false',
  '}',
  '',
].join('\n');

/** Aby uživatel nedostal půlku hlášek anglicky ze zodu. */
const bool = () => z.boolean({ error: 'musí být true nebo false' });
const int = () => z.number({ error: 'musí být celé číslo' }).int('musí být celé číslo');

const showSchema = z.object({
  planUsage: bool().default(true),
  appVersion: bool().default(true),
  mcpServerCount: bool().default(true),
  toolNames: bool().default(true),
  elapsedTime: bool().default(true),
});

export const configSchema = z.object({
  clientId: z
    .string({ error: 'chybí — doplň Application ID z Discord Developer Portal' })
    .regex(/^\d{17,20}$/, 'musí být 17–20 číslic (Discord Application ID)'),
  pollIntervalMs: int().min(500, 'minimum je 500 ms').default(2000),
  presenceMinIntervalMs: int()
    .min(
      PRESENCE_MIN_INTERVAL_FLOOR_MS,
      'minimum je 15000 ms — Discord presence throttluje a kratší interval updaty zahodí'
    )
    .default(PRESENCE_MIN_INTERVAL_FLOOR_MS),
  busyCpuThresholdPercent: z
    .number({ error: 'musí být číslo' })
    .min(1, 'rozsah je 1-100')
    .max(100, 'rozsah je 1-100')
    .default(12),
  // prefault, ne default: prázdný objekt se protáhne schématem, takže se uplatní
  // defaulty jednotlivých přepínačů (všechny true) a nemusí se tu opisovat.
  show: showSchema.prefault({}),
  logDirOverride: z
    .string({ error: 'musí být cesta k adresáři, nebo null' })
    .nullable()
    .default(null),
  debug: bool().default(false),
});

// Compile-time kontrola, že zod schéma odpovídá ručně psanému typu Config.
const _schemaMatchesConfig: (parsed: z.infer<typeof configSchema>) => Config = (parsed) => parsed;
void _schemaMatchesConfig;

const KNOWN_KEYS = Object.keys(configSchema.shape);
const KNOWN_SHOW_KEYS = Object.keys(showSchema.shape);

export type ParseResult =
  { ok: true; config: Config; warnings: string[] } | { ok: false; problems: string[] };

/** Neznámé klíče nejsou fatální (kvůli dopředné kompatibilitě), ale ohlásí se. */
function collectUnknownKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  const warnings = Object.keys(record)
    .filter((key) => !KNOWN_KEYS.includes(key))
    .map((key) => 'neznámý klíč "' + key + '" — ignoruje se (překlep?)');

  const show: unknown = record['show'];
  if (typeof show === 'object' && show !== null && !Array.isArray(show)) {
    for (const key of Object.keys(show)) {
      if (!KNOWN_SHOW_KEYS.includes(key)) {
        warnings.push('neznámý klíč "show.' + key + '" — ignoruje se (překlep?)');
      }
    }
  }
  return warnings;
}

/** Zod issue → jeden čitelný řádek. Žádný stack trace, žádný JSON dump. */
function formatIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.length > 0 ? issue.path.join('.') : '(kořen configu)';
  return where + ': ' + issue.message;
}

/** Čistá validace — žádné IO, žádný exit. */
export function parseConfig(raw: unknown): ParseResult {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, problems: result.error.issues.map(formatIssue) };
  }
  return { ok: true, config: result.data, warnings: collectUnknownKeys(raw) };
}

/** Adresář, vedle kterého se hledá config.json. */
export function resolveBaseDir(): string {
  // @yao-pkg/pkg nastavuje process.pkg; tam je "vedle exe" jediné rozumné místo.
  const packaged = typeof (process as { pkg?: unknown }).pkg !== 'undefined';
  return packaged ? path.dirname(process.execPath) : process.cwd();
}

export type LoadResult =
  | { ok: true; config: Config; configPath: string; warnings: string[] }
  | { ok: false; configPath: string; problems: string[]; createdExample: boolean };

export interface LoadOptions {
  /** Kde hledat config.json. Default: resolveBaseDir(). */
  baseDir?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Načte a zvaliduje config.json. Když chybí, vytvoří ho z config.example.json
 * (nebo ze zabudované šablony) a vrátí ok:false s výzvou doplnit clientId.
 * Nikdy nevolá process.exit — to dělá až loadConfigOrExit.
 */
export function loadConfig(options: LoadOptions = {}): LoadResult {
  const baseDir = options.baseDir ?? resolveBaseDir();
  const configPath = path.join(baseDir, CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    const examplePath = path.join(baseDir, EXAMPLE_FILENAME);
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
        problems: ['nepodařilo se vytvořit ' + configPath + ': ' + describeError(error)],
      };
    }
    return {
      ok: false,
      configPath,
      createdExample: true,
      problems: [
        'vytvořil jsem ' +
          CONFIG_FILENAME +
          ' — otevři ho a doplň "clientId" (Application ID z https://discord.com/developers/applications)',
      ],
    };
  }

  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      configPath,
      createdExample: false,
      problems: ['soubor se nepodařilo přečíst: ' + describeError(error)],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      configPath,
      createdExample: false,
      problems: ['není to platný JSON — ' + describeError(error)],
    };
  }

  const parsed = parseConfig(raw);
  if (!parsed.ok) {
    return { ok: false, configPath, createdExample: false, problems: parsed.problems };
  }
  return { ok: true, config: parsed.config, configPath, warnings: parsed.warnings };
}

/** Chybová hláška pro uživatele — čitelná, bez zod interních věcí. */
export function formatLoadFailure(result: Extract<LoadResult, { ok: false }>): string {
  const header = result.createdExample
    ? 'Chybí konfigurace.'
    : 'Chyba v konfiguraci (' + result.configPath + '):';
  const lines = result.problems.map((problem) => '  • ' + problem);
  return [header, ...lines].join('\n');
}

/**
 * Obálka pro entrypoint: při chybě vypíše čitelnou hlášku a skončí s kódem 1.
 * Případná varování (neznámé klíče) jdou na stderr, ale běh nezastaví.
 */
export function loadConfigOrExit(options: LoadOptions = {}): Config {
  const result = loadConfig(options);
  if (!result.ok) {
    console.error(formatLoadFailure(result));
    process.exit(1);
  }
  for (const warning of result.warnings) {
    console.warn('Varování v ' + result.configPath + ': ' + warning);
  }
  return result.config;
}
