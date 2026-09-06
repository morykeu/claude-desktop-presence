/**
 * Logování daemona.
 *
 * TODO (P7): rotující soubor v %LOCALAPPDATA%\claude-desktop-presence\daemon.log,
 * max 5 MB, 2 soubory. Do konzole se píše jen když je zapnutý debug.
 *
 * OCHRANA SOUKROMÍ (SPEC §5): do tohoto logu se NIKDY nesmí zapsat syrový řádek
 * z logů Claude Desktopu. Jen extrahované hodnoty (verze, počet MCP serverů,
 * jméno nástroje) a vlastní hlášky daemona.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Podřízený logger s prefixem, např. `log.child('discord')`. */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  /** Nejnižší úroveň, která se ještě zapisuje. */
  level: LogLevel;
  /** Zapisovat i do konzole (přepínač --debug / config.debug). */
  console: boolean;
  /** Cesta k souboru; null = jen konzole. */
  filePath: string | null;
  /** Rotace: maximální velikost jednoho souboru v bajtech. */
  maxFileBytes: number;
  /** Rotace: kolik souborů se drží celkem. */
  maxFiles: number;
}

// TODO (P7): export function createLogger(options: LoggerOptions): Logger
