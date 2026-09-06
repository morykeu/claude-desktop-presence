import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONFIG_FILENAME,
  EXAMPLE_CONFIG_JSON,
  EXAMPLE_FILENAME,
  PRESENCE_MIN_INTERVAL_FLOOR_MS,
  formatLoadFailure,
  levenshtein,
  loadConfig,
  loadConfigOrExit,
  parseCliConfigPath,
  parseConfig,
  resolveConfigPath,
  suggestKey,
} from '../src/config.js';
import type { Logger } from '../src/log.js';

/** A valid Discord Application ID — 19 digits. */
const VALID_CLIENT_ID = '1234567890123456789';

function minimalConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { clientId: VALID_CLIENT_ID, ...overrides };
}

function expectFail(result: ReturnType<typeof parseConfig>): string[] {
  if (result.ok) throw new Error('expected validation to fail, but it passed');
  return result.problems;
}

function expectOk(result: ReturnType<typeof parseConfig>) {
  if (!result.ok) throw new Error('expected success, got: ' + result.problems.join('; '));
  return result;
}

describe('parseConfig — defaults', () => {
  it('fills in every default when only clientId is given', () => {
    const { config } = expectOk(parseConfig(minimalConfig()));

    expect(config.clientId).toBe(VALID_CLIENT_ID);
    expect(config.pollIntervalMs).toBe(2000);
    expect(config.presenceMinIntervalMs).toBe(15000);
    expect(config.busy).toEqual({
      baselineWindowSec: 300,
      baselinePercentile: 10,
      thresholdMultiplier: 3,
      thresholdDeltaPercent: 1.5,
      exitFactor: 0.6,
    });
    expect(config.logDirOverride).toBe(null);
    expect(config.debug).toBe(false);
    expect(config.show).toEqual({
      planUsage: true,
      appVersion: true,
      mcpServerCount: true,
      toolNames: true,
      elapsedTime: true,
    });
  });

  it('ships Czech presence text as the default', () => {
    const { config } = expectOk(parseConfig(minimalConfig()));

    expect(config.text.appName).toBe('Claude Desktop');
    expect(config.text.statusBusy).toBe('Pracuje…');
    expect(config.text.statusActive).toBe('Aktivní chat');
    expect(config.text.statusIdle).toBe('Nečinný');
    expect(config.text.statusTool).toContain('{tool}');
    expect(config.text.detailsFormat).toContain('{app}');
    expect(config.text.detailsFormat).toContain('{status}');
  });

  it('lets presence text be overridden one key at a time', () => {
    const { config } = expectOk(
      parseConfig(minimalConfig({ text: { statusIdle: 'Idle', statusBusy: 'Working…' } }))
    );

    expect(config.text.statusIdle).toBe('Idle');
    expect(config.text.statusBusy).toBe('Working…');
    // Untouched keys keep the Czech default.
    expect(config.text.statusActive).toBe('Aktivní chat');
  });

  it('fills in missing show switches and keeps the given ones', () => {
    const { config } = expectOk(parseConfig(minimalConfig({ show: { planUsage: false } })));

    expect(config.show).toEqual({
      planUsage: false,
      appVersion: true,
      mcpServerCount: true,
      toolNames: true,
      elapsedTime: true,
    });
  });

  it('respects user-supplied values', () => {
    const { config } = expectOk(
      parseConfig(
        minimalConfig({
          pollIntervalMs: 5000,
          presenceMinIntervalMs: 30000,
          busy: { thresholdMultiplier: 5 },
          logDirOverride: 'C:\\tmp\\logs',
          debug: true,
        })
      )
    );

    expect(config.pollIntervalMs).toBe(5000);
    expect(config.presenceMinIntervalMs).toBe(30000);
    expect(config.busy.thresholdMultiplier).toBe(5);
    // Untouched calibration keys keep their defaults.
    expect(config.busy.exitFactor).toBe(0.6);
    expect(config.logDirOverride).toBe('C:\\tmp\\logs');
    expect(config.debug).toBe(true);
  });
});

describe('parseConfig — clientId', () => {
  it.each(['12345678901234567', '12345678901234567890'])('accepts boundary length %s', (id) => {
    expect(expectOk(parseConfig({ clientId: id })).config.clientId).toBe(id);
  });

  it.each([
    ['16 digits is too few', '1234567890123456'],
    ['21 digits is too many', '123456789012345678901'],
    ['letters are not allowed', '12345678901234567a'],
    ['must not be empty', ''],
    ['must not be the example placeholder', 'SEM_APPLICATION_ID'],
  ])('rejects: %s', (_label, id) => {
    expect(expectFail(parseConfig({ clientId: id })).join('\n')).toContain('clientId');
  });

  it('rejects a missing clientId', () => {
    expect(expectFail(parseConfig({})).join('\n')).toContain('clientId');
  });

  it('rejects clientId as a number (19 digits would lose precision in JSON)', () => {
    // Number(...) on purpose: the literal would trip eslint's no-loss-of-precision,
    // which is exactly why clientId has to stay a string.
    expect(expectFail(parseConfig({ clientId: Number(VALID_CLIENT_ID) })).join('\n')).toContain(
      'clientId'
    );
  });
});

describe('parseConfig — numeric bounds', () => {
  it('rejects pollIntervalMs below 500', () => {
    const text = expectFail(parseConfig(minimalConfig({ pollIntervalMs: 499 }))).join('\n');
    expect(text).toContain('pollIntervalMs');
    expect(text).toContain('500');
  });

  it('accepts pollIntervalMs of exactly 500', () => {
    expect(
      expectOk(parseConfig(minimalConfig({ pollIntervalMs: 500 }))).config.pollIntervalMs
    ).toBe(500);
  });

  it('rejects presenceMinIntervalMs below 15000 — Discord throttles', () => {
    const text = expectFail(
      parseConfig(minimalConfig({ presenceMinIntervalMs: PRESENCE_MIN_INTERVAL_FLOOR_MS - 1 }))
    ).join('\n');

    expect(text).toContain('presenceMinIntervalMs');
    expect(text).toContain('throttles');
  });

  it('accepts presenceMinIntervalMs of exactly 15000', () => {
    const { config } = expectOk(parseConfig(minimalConfig({ presenceMinIntervalMs: 15000 })));
    expect(config.presenceMinIntervalMs).toBe(15000);
  });

  it.each([0, 0.5, 101])('rejects busy.thresholdMultiplier = %s', (value) => {
    expect(
      expectFail(parseConfig(minimalConfig({ busy: { thresholdMultiplier: value } }))).join('\n')
    ).toContain('busy.thresholdMultiplier');
  });

  it.each([0, 0.05, 500])('rejects busy.thresholdDeltaPercent = %s', (value) => {
    expect(
      expectFail(parseConfig(minimalConfig({ busy: { thresholdDeltaPercent: value } }))).join('\n')
    ).toContain('busy.thresholdDeltaPercent');
  });

  it.each([0, 1.5])('rejects busy.exitFactor = %s', (value) => {
    expect(
      expectFail(parseConfig(minimalConfig({ busy: { exitFactor: value } }))).join('\n')
    ).toContain('busy.exitFactor');
  });

  it('rejects a baseline window shorter than 30 s', () => {
    expect(
      expectFail(parseConfig(minimalConfig({ busy: { baselineWindowSec: 10 } }))).join('\n')
    ).toContain('busy.baselineWindowSec');
  });

  it('accepts a full custom calibration', () => {
    const { config } = expectOk(
      parseConfig(
        minimalConfig({
          busy: {
            baselineWindowSec: 600,
            baselinePercentile: 25,
            thresholdMultiplier: 2.5,
            thresholdDeltaPercent: 0.8,
            exitFactor: 0.5,
          },
        })
      )
    );
    expect(config.busy.baselineWindowSec).toBe(600);
    expect(config.busy.thresholdDeltaPercent).toBe(0.8);
  });

  it('rejects non-integer intervals', () => {
    expectFail(parseConfig(minimalConfig({ pollIntervalMs: 2000.5 })));
  });
});

describe('parseConfig — types and unknown keys', () => {
  it('rejects a wrong type on a show switch', () => {
    expect(
      expectFail(parseConfig(minimalConfig({ show: { planUsage: 'yes' } }))).join('\n')
    ).toContain('show.planUsage');
  });

  it('rejects a wrong type on a text template', () => {
    expect(
      expectFail(parseConfig(minimalConfig({ text: { statusIdle: 5 } }))).join('\n')
    ).toContain('text.statusIdle');
  });

  it('rejects logDirOverride as a number', () => {
    expectFail(parseConfig(minimalConfig({ logDirOverride: 42 })));
  });

  it('accepts logDirOverride = null', () => {
    expect(
      expectOk(parseConfig(minimalConfig({ logDirOverride: null }))).config.logDirOverride
    ).toBe(null);
  });

  it('treats an unknown key as a warning, not an error', () => {
    const result = expectOk(parseConfig(minimalConfig({ pollIntervalMilliseconds: 20 })));
    expect(result.warnings.join('\n')).toContain('pollIntervalMilliseconds');
  });

  it('suggests the intended key', () => {
    const result = expectOk(parseConfig(minimalConfig({ presenceMinInterval: 20000 })));
    expect(result.warnings.join('\n')).toContain('did you mean "presenceMinIntervalMs"');
  });

  it('suggests inside the busy section', () => {
    const result = expectOk(parseConfig(minimalConfig({ busy: { exitFacter: 0.5 } })));
    expect(result.warnings.join('\n')).toContain('did you mean "busy.exitFactor"');
  });

  it('suggests inside show and text as well', () => {
    const result = expectOk(
      parseConfig(minimalConfig({ show: { planUsge: true }, text: { statusIdel: 'x' } }))
    );
    const text = result.warnings.join('\n');

    expect(text).toContain('did you mean "show.planUsage"');
    expect(text).toContain('did you mean "text.statusIdle"');
  });

  it('omits the suggestion when nothing is close', () => {
    const result = expectOk(parseConfig(minimalConfig({ somethingCompletelyElse: 1 })));
    expect(result.warnings.join('\n')).toContain('unknown key "somethingCompletelyElse"');
    expect(result.warnings.join('\n')).not.toContain('did you mean');
  });

  it('emits no warnings for a clean config', () => {
    expect(expectOk(parseConfig(minimalConfig())).warnings).toEqual([]);
  });

  it('rejects a root that is not an object', () => {
    expectFail(parseConfig('nope'));
    expectFail(parseConfig(null));
    expectFail(parseConfig([]));
  });
});

describe('levenshtein / suggestKey', () => {
  it('computes the distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('is case-insensitive when suggesting', () => {
    expect(suggestKey('DEBUG', ['debug', 'show'])).toBe('debug');
  });

  it('returns null when nothing is within tolerance', () => {
    expect(suggestKey('zzzzzzzzzz', ['debug', 'show'])).toBe(null);
  });

  it('does not match everything for very short keys', () => {
    expect(suggestKey('xy', ['debug', 'show', 'text'])).toBe(null);
  });

  it('picks the closest of several candidates', () => {
    expect(suggestKey('statusIdel', ['statusIdle', 'statusBusy', 'statusActive'])).toBe(
      'statusIdle'
    );
  });
});

describe('parseConfig — readable errors', () => {
  it('messages carry no zod internals or stack traces', () => {
    const text = expectFail(
      parseConfig({ clientId: 'abc', pollIntervalMs: 10, busy: { exitFactor: 500 } })
    ).join('\n');

    expect(text).not.toContain('ZodError');
    expect(text).not.toContain('at Object.');
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('"code"');
  });

  it('type errors are worded by us, not by zod', () => {
    const text = expectFail(
      parseConfig({
        clientId: 42,
        pollIntervalMs: 'fast',
        show: { planUsage: 'yes' },
        logDirOverride: 7,
        debug: 'on',
      })
    ).join('\n');

    expect(text).not.toContain('Invalid input');
    expect(text).not.toContain('received');
  });

  it('every problem names the field it belongs to', () => {
    const problems = expectFail(parseConfig({ clientId: 'abc', pollIntervalMs: 10 }));

    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.startsWith('clientId:'))).toBe(true);
    expect(problems.some((p) => p.startsWith('pollIntervalMs:'))).toBe(true);
  });
});

describe('parseCliConfigPath', () => {
  it('reads --config <path>', () => {
    expect(parseCliConfigPath(['--debug', '--config', 'C:\\x\\my.json'])).toBe('C:\\x\\my.json');
  });

  it('reads --config=<path>', () => {
    expect(parseCliConfigPath(['--config=C:\\x\\my.json'])).toBe('C:\\x\\my.json');
  });

  it('returns null when the flag is absent', () => {
    expect(parseCliConfigPath(['--debug'])).toBe(null);
    expect(parseCliConfigPath([])).toBe(null);
  });

  it('returns null when the value is missing or is another flag', () => {
    expect(parseCliConfigPath(['--config'])).toBe(null);
    expect(parseCliConfigPath(['--config', '--debug'])).toBe(null);
    expect(parseCliConfigPath(['--config='])).toBe(null);
  });
});

describe('resolveConfigPath', () => {
  it('prefers an explicit configPath over everything', () => {
    const resolved = resolveConfigPath({
      configPath: 'C:\\explicit\\custom.json',
      argv: ['--config', 'C:\\cli\\cli.json'],
      baseDir: 'C:\\base',
    });
    expect(resolved).toBe(path.resolve('C:\\explicit\\custom.json'));
  });

  it('prefers --config over the base directory', () => {
    const resolved = resolveConfigPath({
      argv: ['--config', 'C:\\cli\\cli.json'],
      baseDir: 'C:\\base',
    });
    expect(resolved).toBe(path.resolve('C:\\cli\\cli.json'));
  });

  it('falls back to config.json in the base directory', () => {
    expect(resolveConfigPath({ argv: [], baseDir: 'C:\\base' })).toBe(
      path.join('C:\\base', CONFIG_FILENAME)
    );
  });

  it('accepts a directory passed to --config', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cdp-dir-'));
    try {
      expect(resolveConfigPath({ argv: ['--config', dir] })).toBe(path.join(dir, CONFIG_FILENAME));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cdp-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads a valid config.json', () => {
    writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify(minimalConfig()), 'utf8');

    const result = loadConfig({ baseDir: dir, argv: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.clientId).toBe(VALID_CLIENT_ID);
    expect(result.configPath).toBe(path.join(dir, CONFIG_FILENAME));
  });

  it('copies config.example.json when config.json is missing and asks for clientId', () => {
    writeFileSync(path.join(dir, EXAMPLE_FILENAME), EXAMPLE_CONFIG_JSON, 'utf8');

    const result = loadConfig({ baseDir: dir, argv: [] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.createdExample).toBe(true);
    expect(result.problems.join('\n')).toContain('clientId');
    expect(readFileSync(path.join(dir, CONFIG_FILENAME), 'utf8')).toBe(EXAMPLE_CONFIG_JSON);
  });

  it('writes the embedded template when config.example.json is missing too', () => {
    const result = loadConfig({ baseDir: dir, argv: [] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.createdExample).toBe(true);
    expect(readFileSync(path.join(dir, CONFIG_FILENAME), 'utf8')).toBe(EXAMPLE_CONFIG_JSON);
  });

  it('creates the file next to the path given by --config, not in the base directory', () => {
    const custom = path.join(dir, 'nested.json');

    const result = loadConfig({ argv: ['--config', custom], baseDir: 'C:\\should\\not\\be\\used' });

    expect(result.configPath).toBe(custom);
    expect(readFileSync(custom, 'utf8')).toBe(EXAMPLE_CONFIG_JSON);
  });

  it('on the second run fails on the placeholder, not on a missing file', () => {
    loadConfig({ baseDir: dir, argv: [] });
    const second = loadConfig({ baseDir: dir, argv: [] });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.createdExample).toBe(false);
    expect(second.problems.join('\n')).toContain('clientId');
  });

  it('reports broken JSON readably instead of throwing', () => {
    writeFileSync(path.join(dir, CONFIG_FILENAME), '{ "clientId": ', 'utf8');

    const result = loadConfig({ baseDir: dir, argv: [] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join('\n')).toContain('JSON');
    expect(result.problems.join('\n')).not.toContain('at Object.');
  });

  it('does not crash when config.json is unreadable (it is a directory)', () => {
    mkdirSync(path.join(dir, CONFIG_FILENAME));
    expect(loadConfig({ baseDir: dir, argv: [] }).ok).toBe(false);
  });

  it('propagates unknown-key warnings into the result', () => {
    writeFileSync(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify(minimalConfig({ nonsense: 1 })),
      'utf8'
    );

    const result = loadConfig({ baseDir: dir, argv: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join('\n')).toContain('nonsense');
  });
});

describe('loadConfigOrExit', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cdp-exit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sends warnings to the daemon log as well as the console', () => {
    writeFileSync(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify(minimalConfig({ presenceMinInterval: 20000 })),
      'utf8'
    );
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    loadConfigOrExit({ baseDir: dir, argv: [], logger });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('presenceMinInterval');
    expect(consoleWarn).toHaveBeenCalledTimes(1);
  });

  it('works without a logger', () => {
    writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify(minimalConfig()), 'utf8');

    const config = loadConfigOrExit({ baseDir: dir, argv: [] });
    expect(config.clientId).toBe(VALID_CLIENT_ID);
  });
});

describe('formatLoadFailure', () => {
  it('uses the missing-configuration header when the file was just created', () => {
    const text = formatLoadFailure({
      ok: false,
      configPath: 'C:\\x\\config.json',
      createdExample: true,
      problems: ['fill in clientId'],
    });

    expect(text).toContain('No configuration found.');
    expect(text).toContain('  • fill in clientId');
  });

  it('names the file for an invalid configuration', () => {
    const text = formatLoadFailure({
      ok: false,
      configPath: 'C:\\x\\config.json',
      createdExample: false,
      problems: ['clientId: must be 17-20 digits', 'pollIntervalMs: the minimum is 500 ms'],
    });

    expect(text).toContain('C:\\x\\config.json');
    expect(text.split('\n')).toHaveLength(3);
  });
});

describe('embedded template', () => {
  it('matches config.example.json in the repo', () => {
    // Line endings are normalised — .gitattributes enforces LF, but a checkout
    // elsewhere may differ; the test guards content, not EOL.
    const onDisk = readFileSync(path.join(process.cwd(), EXAMPLE_FILENAME), 'utf8');
    expect(onDisk.replace(/\r\n/g, '\n')).toBe(EXAMPLE_CONFIG_JSON.replace(/\r\n/g, '\n'));
  });

  it('is valid JSON and passes the schema apart from the clientId placeholder', () => {
    const parsed: unknown = JSON.parse(EXAMPLE_CONFIG_JSON);
    const problems = expectFail(parseConfig(parsed));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('clientId');
  });

  it('contains no unknown keys of its own', () => {
    const parsed: unknown = JSON.parse(EXAMPLE_CONFIG_JSON);
    const withValidId = { ...(parsed as object), clientId: VALID_CLIENT_ID };

    expect(expectOk(parseConfig(withValidId)).warnings).toEqual([]);
  });
});
