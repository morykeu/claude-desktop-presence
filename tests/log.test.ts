import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_FILE_BYTES,
  LOG_DIR_NAME,
  LOG_FILE_NAME,
  createLogger,
  defaultLogFilePath,
  formatEntry,
} from '../src/log.js';

describe('defaultLogFilePath', () => {
  it('points at %LOCALAPPDATA%', () => {
    expect(defaultLogFilePath({ LOCALAPPDATA: 'C:\\Local' })).toBe(
      path.join('C:\\Local', LOG_DIR_NAME, LOG_FILE_NAME)
    );
  });

  it('returns null when LOCALAPPDATA is not set', () => {
    expect(defaultLogFilePath({})).toBe(null);
  });
});

describe('formatEntry', () => {
  const at = new Date('2026-09-06T18:39:38.237Z');

  it('writes a timestamp, a padded level and the message', () => {
    expect(formatEntry('info', '', 'daemon started', undefined, at)).toBe(
      '2026-09-06T18:39:38.237Z INFO  daemon started'
    );
  });

  it('includes the scope and the fields', () => {
    expect(formatEntry('warn', 'logs', 'could not read', { code: 'EBUSY' }, at)).toBe(
      '2026-09-06T18:39:38.237Z WARN  [logs] could not read {"code":"EBUSY"}'
    );
  });

  it('survives fields that cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(formatEntry('error', '', 'boom', circular, at)).toContain('unserialisable');
  });

  it('omits an empty fields object', () => {
    expect(formatEntry('info', '', 'x', {}, at)).toBe('2026-09-06T18:39:38.237Z INFO  x');
  });
});

describe('createLogger', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cdp-log-'));
    filePath = path.join(dir, 'nested', LOG_FILE_NAME);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates the directory and writes a line', () => {
    const logger = createLogger({ filePath, console: false });
    logger.info('hello', { a: 1 });

    expect(readFileSync(filePath, 'utf8')).toContain('INFO  hello {"a":1}');
  });

  it('honours the level', () => {
    const logger = createLogger({ filePath, level: 'info' });
    logger.debug('not this');
    logger.warn('but this');

    const contents = readFileSync(filePath, 'utf8');
    expect(contents).not.toContain('not this');
    expect(contents).toContain('but this');
  });

  it('scopes child loggers', () => {
    const logger = createLogger({ filePath });
    logger.child('discord').child('gate').info('nested');

    expect(readFileSync(filePath, 'utf8')).toContain('[discord:gate] nested');
  });

  it('writes to the console only when asked', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    createLogger({ filePath, console: false }).info('quiet');
    expect(log).not.toHaveBeenCalled();

    createLogger({ filePath, console: true }).info('loud');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('sends warnings and errors to stderr', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const logger = createLogger({ filePath, console: true });
    logger.warn('careful');
    logger.error('broken');
    logger.info('fine');

    expect(error).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
  });

  describe('rotation', () => {
    it('rotates once the file would exceed the limit', () => {
      const logger = createLogger({ filePath, maxFileBytes: 500, maxFiles: 2 });

      for (let i = 0; i < 40; i += 1) logger.info('x'.repeat(50));

      expect(existsSync(filePath)).toBe(true);
      expect(existsSync(`${filePath}.1`)).toBe(true);
      expect(statSync(filePath).size).toBeLessThanOrEqual(500);
    });

    it('keeps only maxFiles files', () => {
      const logger = createLogger({ filePath, maxFileBytes: 200, maxFiles: 2 });

      for (let i = 0; i < 100; i += 1) logger.info('y'.repeat(50));

      expect(existsSync(`${filePath}.1`)).toBe(true);
      expect(existsSync(`${filePath}.2`)).toBe(false);
    });

    it('keeps the newest lines in the live file', () => {
      const logger = createLogger({ filePath, maxFileBytes: 300, maxFiles: 2 });

      logger.info('oldest');
      for (let i = 0; i < 20; i += 1) logger.info('z'.repeat(50));
      logger.info('newest');

      expect(readFileSync(filePath, 'utf8')).toContain('newest');
      expect(readFileSync(filePath, 'utf8')).not.toContain('oldest');
    });

    it('ships sane defaults', () => {
      expect(DEFAULT_MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
      expect(DEFAULT_MAX_FILES).toBe(2);
    });
  });

  it('never throws when the file cannot be written', () => {
    // The path is a directory, so every write fails. The daemon still has a job.
    const asDirectory = path.join(dir, 'blocked');
    mkdirSync(asDirectory, { recursive: true });
    const logger = createLogger({ filePath: asDirectory });

    expect(() => {
      logger.error('this cannot be written anywhere');
    }).not.toThrow();
  });

  it('works with no file at all', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const logger = createLogger({ filePath: null, console: true });

    expect(() => {
      logger.info('console only');
    }).not.toThrow();
    expect(log).toHaveBeenCalled();
  });
});

describe('privacy', () => {
  it('the log file only ever contains what a caller passed in', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cdp-priv-'));
    const filePath = path.join(dir, LOG_FILE_NAME);
    try {
      // A reader passes its own wording plus a code — never a slice of what it read.
      createLogger({ filePath }).warn('could not read a Claude log, will retry', {
        code: 'EBUSY',
      });

      const contents = readFileSync(filePath, 'utf8');
      expect(contents).toContain('EBUSY');
      expect(contents).not.toContain('Received permission response');
      expect(contents).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not read anything off disk by itself', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cdp-priv2-'));
    try {
      writeFileSync(path.join(dir, 'secret.txt'), 'hunter2', 'utf8');
      const filePath = path.join(dir, LOG_FILE_NAME);
      createLogger({ filePath }).info('nothing to see');

      expect(readFileSync(filePath, 'utf8')).not.toContain('hunter2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
