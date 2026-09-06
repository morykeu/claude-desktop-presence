/**
 * Daemon logging.
 *
 * TODO (P7): rotating file at %LOCALAPPDATA%\claude-desktop-presence\daemon.log,
 * 5 MB max, 2 files. The console is only written to when debug is on.
 *
 * PRIVACY (SPEC §5): a raw line from the Claude Desktop logs must NEVER be written
 * here. Only extracted values (version, MCP server count, tool name) and the daemon's
 * own messages.
 *
 * Bootstrap ordering: the config has to be read before a real logger can be built,
 * so config.loadConfigOrExit takes an optional Logger. P7 either passes a bootstrap
 * logger there or replays LoadResult.warnings once the real logger exists — in
 * production (Scheduled Task, no window) the console goes nowhere.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Scoped child logger, e.g. `log.child('discord')`. */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  /** Lowest level still written. */
  level: LogLevel;
  /** Also write to the console (--debug / config.debug). */
  console: boolean;
  /** File path; null = console only. */
  filePath: string | null;
  /** Rotation: maximum size of a single file in bytes. */
  maxFileBytes: number;
  /** Rotation: how many files are kept in total. */
  maxFiles: number;
}

// TODO (P7): export function createLogger(options: LoggerOptions): Logger
