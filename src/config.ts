/**
 * Načtení a validace config.json.
 *
 * TODO (P1): zod schéma, defaulty, kopie config.example.json při prvním spuštění,
 * čitelná chybová hláška (ne zod stack trace) + exit(1) při nevalidním configu.
 */

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

// TODO (P1): export function loadConfig(baseDir?: string): Config
