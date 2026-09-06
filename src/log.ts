/**
 * Daemon logging.
 *
 * PRIVACY (SPEC §5): a raw line from the Claude Desktop logs must NEVER reach this
 * file. Only extracted values (version, MCP server count, tool name), errno codes and
 * the daemon's own messages. That is enforced at the call sites — every reader passes
 * its own wording plus a code or a size, never a slice of what it read.
 *
 * Bootstrap ordering: the config has to be read before a real logger can exist (the
 * logger needs to know whether debug is on), but reading the config already produces
 * warnings. createBootstrapLogger buffers those, and drainInto replays them into the
 * real logger the moment it is built — in production there is no console for them to
 * fall back to.
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

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
  /** Rotation: how many files are kept in total, including the live one. */
  maxFiles: number;
}

export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 2;
export const LOG_DIR_NAME = 'claude-desktop-presence';
export const LOG_FILE_NAME = 'daemon.log';

/** %LOCALAPPDATA%\claude-desktop-presence\daemon.log */
export function defaultLogFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const local = env['LOCALAPPDATA'];
  if (local === undefined || local === '') return null;
  return path.join(local, LOG_DIR_NAME, LOG_FILE_NAME);
}

export function formatEntry(
  level: LogLevel,
  scope: string,
  message: string,
  fields: Record<string, unknown> | undefined,
  at: Date
): string {
  const where = scope === '' ? '' : ` [${scope}]`;
  let extra = '';
  if (fields !== undefined && Object.keys(fields).length > 0) {
    try {
      extra = ' ' + JSON.stringify(fields);
    } catch {
      extra = ' {"fields":"<unserialisable>"}';
    }
  }
  return `${at.toISOString()} ${level.toUpperCase().padEnd(5)}${where} ${message}${extra}`;
}

interface Sink {
  write(line: string, level: LogLevel): void;
}

/**
 * Rotation is checked before each write rather than on a timer, so a burst cannot
 * overshoot the limit between checks. Every failure is swallowed: a daemon that cannot
 * write its log still has a job to do.
 */
function createFileSink(filePath: string, maxFileBytes: number, maxFiles: number): Sink {
  let ensured = false;

  const ensureDir = (): void => {
    if (ensured) return;
    mkdirSync(path.dirname(filePath), { recursive: true });
    ensured = true;
  };

  const rotate = (): void => {
    // daemon.log -> daemon.log.1 -> ... dropping whatever falls past maxFiles.
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const from = index === 1 ? filePath : `${filePath}.${index - 1}`;
      const to = `${filePath}.${index}`;
      try {
        if (index === maxFiles - 1) rmSync(to, { force: true });
        renameSync(from, to);
      } catch {
        // Nothing to move, or the file is locked. Either way, carry on.
      }
    }
  };

  return {
    write(line: string): void {
      try {
        ensureDir();
        const payload = line + '\n';
        let size = 0;
        try {
          size = statSync(filePath).size;
        } catch {
          size = 0;
        }
        if (size > 0 && size + payload.length > maxFileBytes) rotate();
        appendFileSync(filePath, payload, 'utf8');
      } catch {
        // Never let logging take the daemon down.
      }
    },
  };
}

function createConsoleSink(): Sink {
  return {
    write(line: string, level: LogLevel): void {
      if (level === 'warn' || level === 'error') console.error(line);
      else console.log(line);
    },
  };
}

function build(options: LoggerOptions, sinks: Sink[], scope: string): Logger {
  const minimum = LEVEL_ORDER[options.level];

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < minimum) return;
    const line = formatEntry(level, scope, message, fields, new Date());
    for (const sink of sinks) sink.write(line, level);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (childScope) =>
      build(options, sinks, scope === '' ? childScope : `${scope}:${childScope}`),
  };
}

export function createLogger(options: Partial<LoggerOptions> = {}): Logger {
  const resolved: LoggerOptions = {
    level: options.level ?? 'info',
    console: options.console ?? false,
    filePath: options.filePath === undefined ? defaultLogFilePath() : options.filePath,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
  };

  const sinks: Sink[] = [];
  if (resolved.filePath !== null) {
    sinks.push(createFileSink(resolved.filePath, resolved.maxFileBytes, resolved.maxFiles));
  }
  if (resolved.console) sinks.push(createConsoleSink());

  return build(resolved, sinks, '');
}

export interface BootstrapLogger extends Logger {
  /** Replays everything buffered so far into the real logger, then keeps forwarding. */
  drainInto(target: Logger): void;
}

/**
 * Holds messages produced before the real logger exists — config loading, mostly.
 * Without this, anything the config reader had to say would be lost in production,
 * where there is no console attached.
 */
export function createBootstrapLogger(limit = 200): BootstrapLogger {
  interface Entry {
    level: LogLevel;
    scope: string;
    message: string;
    fields?: Record<string, unknown>;
  }

  const buffered: Entry[] = [];
  let target: Logger | null = null;

  const replay = (entry: Entry, into: Logger): void => {
    const scoped = entry.scope === '' ? into : into.child(entry.scope);
    scoped[entry.level](entry.message, entry.fields);
  };

  const make = (scope: string): BootstrapLogger => {
    const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
      const entry: Entry = { level, scope, message, ...(fields ? { fields } : {}) };
      if (target !== null) {
        replay(entry, target);
        return;
      }
      // A daemon that never gets a real logger must not grow this forever.
      if (buffered.length < limit) buffered.push(entry);
    };

    return {
      debug: (message, fields) => emit('debug', message, fields),
      info: (message, fields) => emit('info', message, fields),
      warn: (message, fields) => emit('warn', message, fields),
      error: (message, fields) => emit('error', message, fields),
      child: (childScope) => make(scope === '' ? childScope : `${scope}:${childScope}`),
      drainInto: (real: Logger) => {
        target = real;
        for (const entry of buffered.splice(0)) replay(entry, real);
      },
    };
  };

  return make('');
}
