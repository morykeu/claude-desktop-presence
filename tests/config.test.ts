import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIG_FILENAME,
  EXAMPLE_CONFIG_JSON,
  EXAMPLE_FILENAME,
  PRESENCE_MIN_INTERVAL_FLOOR_MS,
  formatLoadFailure,
  loadConfig,
  parseConfig,
} from '../src/config.js';

/** Platné Discord Application ID — 19 číslic. */
const VALID_CLIENT_ID = '1234567890123456789';

function minimalConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { clientId: VALID_CLIENT_ID, ...overrides };
}

function expectFail(result: ReturnType<typeof parseConfig>): string[] {
  if (result.ok) throw new Error('čekal jsem selhání validace, ale prošla');
  return result.problems;
}

function expectOk(result: ReturnType<typeof parseConfig>) {
  if (!result.ok) throw new Error('čekal jsem úspěch, ale selhalo: ' + result.problems.join('; '));
  return result;
}

describe('parseConfig — defaulty', () => {
  it('doplní všechny defaulty, když je zadaný jen clientId', () => {
    const { config } = expectOk(parseConfig(minimalConfig()));

    expect(config).toEqual({
      clientId: VALID_CLIENT_ID,
      pollIntervalMs: 2000,
      presenceMinIntervalMs: 15000,
      busyCpuThresholdPercent: 12,
      show: {
        planUsage: true,
        appVersion: true,
        mcpServerCount: true,
        toolNames: true,
        elapsedTime: true,
      },
      logDirOverride: null,
      debug: false,
    });
  });

  it('doplní chybějící přepínače v show a nechá zadané být', () => {
    const { config } = expectOk(parseConfig(minimalConfig({ show: { planUsage: false } })));

    expect(config.show).toEqual({
      planUsage: false,
      appVersion: true,
      mcpServerCount: true,
      toolNames: true,
      elapsedTime: true,
    });
  });

  it('respektuje hodnoty zadané uživatelem', () => {
    const { config } = expectOk(
      parseConfig(
        minimalConfig({
          pollIntervalMs: 5000,
          presenceMinIntervalMs: 30000,
          busyCpuThresholdPercent: 25,
          logDirOverride: 'C:\\tmp\\logs',
          debug: true,
        })
      )
    );

    expect(config.pollIntervalMs).toBe(5000);
    expect(config.presenceMinIntervalMs).toBe(30000);
    expect(config.busyCpuThresholdPercent).toBe(25);
    expect(config.logDirOverride).toBe('C:\\tmp\\logs');
    expect(config.debug).toBe(true);
  });
});

describe('parseConfig — clientId', () => {
  it.each(['12345678901234567', '12345678901234567890'])('přijme hraniční délku %s', (clientId) => {
    expect(expectOk(parseConfig({ clientId })).config.clientId).toBe(clientId);
  });

  it.each([
    ['16 číslic je málo', '1234567890123456'],
    ['21 číslic je moc', '123456789012345678901'],
    ['nesmí obsahovat písmena', '12345678901234567a'],
    ['nesmí být prázdný', ''],
    ['nesmí být placeholder z example configu', 'SEM_APPLICATION_ID'],
  ])('odmítne: %s', (_label, clientId) => {
    const problems = expectFail(parseConfig({ clientId }));
    expect(problems.join('\n')).toContain('clientId');
  });

  it('odmítne chybějící clientId', () => {
    const problems = expectFail(parseConfig({}));
    expect(problems.join('\n')).toContain('clientId');
  });

  it('odmítne clientId jako číslo (JSON by u 19 číslic ztratil přesnost)', () => {
    // Number(...) schválně: literál té délky by eslint zastavil na no-loss-of-precision,
    // což je přesně ten důvod, proč clientId musí zůstat string.
    const problems = expectFail(parseConfig({ clientId: Number(VALID_CLIENT_ID) }));
    expect(problems.join('\n')).toContain('clientId');
  });
});

describe('parseConfig — číselné meze', () => {
  it('odmítne pollIntervalMs pod 500', () => {
    const problems = expectFail(parseConfig(minimalConfig({ pollIntervalMs: 499 })));
    expect(problems.join('\n')).toContain('pollIntervalMs');
    expect(problems.join('\n')).toContain('500');
  });

  it('přijme pollIntervalMs přesně 500', () => {
    expect(
      expectOk(parseConfig(minimalConfig({ pollIntervalMs: 500 }))).config.pollIntervalMs
    ).toBe(500);
  });

  it('odmítne presenceMinIntervalMs pod 15000 — Discord throttluje', () => {
    const problems = expectFail(
      parseConfig(minimalConfig({ presenceMinIntervalMs: PRESENCE_MIN_INTERVAL_FLOOR_MS - 1 }))
    );
    expect(problems.join('\n')).toContain('presenceMinIntervalMs');
    expect(problems.join('\n')).toContain('throttluje');
  });

  it('přijme presenceMinIntervalMs přesně 15000', () => {
    const { config } = expectOk(parseConfig(minimalConfig({ presenceMinIntervalMs: 15000 })));
    expect(config.presenceMinIntervalMs).toBe(15000);
  });

  it.each([0, 101, -5])('odmítne busyCpuThresholdPercent = %s', (value) => {
    const problems = expectFail(parseConfig(minimalConfig({ busyCpuThresholdPercent: value })));
    expect(problems.join('\n')).toContain('busyCpuThresholdPercent');
  });

  it.each([1, 12, 100])('přijme busyCpuThresholdPercent = %s', (value) => {
    const { config } = expectOk(parseConfig(minimalConfig({ busyCpuThresholdPercent: value })));
    expect(config.busyCpuThresholdPercent).toBe(value);
  });

  it('odmítne neceločíselné intervaly', () => {
    expectFail(parseConfig(minimalConfig({ pollIntervalMs: 2000.5 })));
  });
});

describe('parseConfig — typy a neznámé klíče', () => {
  it('odmítne špatný typ u show přepínače', () => {
    const problems = expectFail(parseConfig(minimalConfig({ show: { planUsage: 'ano' } })));
    expect(problems.join('\n')).toContain('show.planUsage');
  });

  it('odmítne logDirOverride jako číslo', () => {
    expectFail(parseConfig(minimalConfig({ logDirOverride: 42 })));
  });

  it('přijme logDirOverride = null', () => {
    expect(
      expectOk(parseConfig(minimalConfig({ logDirOverride: null }))).config.logDirOverride
    ).toBe(null);
  });

  it('neznámý klíč je jen varování, ne chyba', () => {
    const result = expectOk(parseConfig(minimalConfig({ busyCpuTreshold: 20 })));
    expect(result.warnings.join('\n')).toContain('busyCpuTreshold');
  });

  it('neznámý klíč uvnitř show je taky varování', () => {
    const result = expectOk(parseConfig(minimalConfig({ show: { planUsge: true } })));
    expect(result.warnings.join('\n')).toContain('show.planUsge');
  });

  it('bez překlepů nevydá žádné varování', () => {
    expect(expectOk(parseConfig(minimalConfig())).warnings).toEqual([]);
  });

  it('odmítne, když kořen není objekt', () => {
    expectFail(parseConfig('nope'));
    expectFail(parseConfig(null));
    expectFail(parseConfig([]));
  });
});

describe('parseConfig — čitelnost chyb', () => {
  it('hlášky neobsahují zod interní věci ani stack trace', () => {
    const problems = expectFail(
      parseConfig({ clientId: 'abc', pollIntervalMs: 10, busyCpuThresholdPercent: 500 })
    );
    const text = problems.join('\n');

    expect(text).not.toContain('ZodError');
    expect(text).not.toContain('at Object.');
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('"code"');
  });

  it('hlášky jsou česky, ne zodí angličtina', () => {
    const problems = expectFail(
      parseConfig({
        clientId: 42,
        pollIntervalMs: 'rychle',
        show: { planUsage: 'ano' },
        logDirOverride: 7,
        debug: 'zapnuto',
      })
    );
    const text = problems.join('\n');

    expect(text).not.toContain('Invalid input');
    expect(text).not.toContain('expected');
    expect(text).not.toContain('received');
  });

  it('každý problém uvádí, které pole se ho týká', () => {
    const problems = expectFail(parseConfig({ clientId: 'abc', pollIntervalMs: 10 }));
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.startsWith('clientId:'))).toBe(true);
    expect(problems.some((p) => p.startsWith('pollIntervalMs:'))).toBe(true);
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

  it('načte platný config.json', () => {
    writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify(minimalConfig()), 'utf8');

    const result = loadConfig({ baseDir: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.clientId).toBe(VALID_CLIENT_ID);
    expect(result.configPath).toBe(path.join(dir, CONFIG_FILENAME));
  });

  it('když config.json chybí, zkopíruje config.example.json a vyzve k doplnění clientId', () => {
    writeFileSync(path.join(dir, EXAMPLE_FILENAME), EXAMPLE_CONFIG_JSON, 'utf8');

    const result = loadConfig({ baseDir: dir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.createdExample).toBe(true);
    expect(result.problems.join('\n')).toContain('clientId');
    expect(readFileSync(path.join(dir, CONFIG_FILENAME), 'utf8')).toBe(EXAMPLE_CONFIG_JSON);
  });

  it('když chybí i config.example.json, vytvoří config.json ze zabudované šablony', () => {
    const result = loadConfig({ baseDir: dir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.createdExample).toBe(true);
    expect(readFileSync(path.join(dir, CONFIG_FILENAME), 'utf8')).toBe(EXAMPLE_CONFIG_JSON);
  });

  it('nově vytvořený config při druhém spuštění selže na placeholderu, ne na chybějícím souboru', () => {
    loadConfig({ baseDir: dir });
    const second = loadConfig({ baseDir: dir });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.createdExample).toBe(false);
    expect(second.problems.join('\n')).toContain('clientId');
  });

  it('rozbitý JSON vrátí čitelnou hlášku, ne výjimku', () => {
    writeFileSync(path.join(dir, CONFIG_FILENAME), '{ "clientId": ', 'utf8');

    const result = loadConfig({ baseDir: dir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join('\n')).toContain('JSON');
    expect(result.problems.join('\n')).not.toContain('at Object.');
  });

  it('nečitelný config.json (je to adresář) neshodí proces', () => {
    mkdirSync(path.join(dir, CONFIG_FILENAME));

    const result = loadConfig({ baseDir: dir });
    expect(result.ok).toBe(false);
  });

  it('varování z neznámých klíčů se propíšou do výsledku', () => {
    writeFileSync(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify(minimalConfig({ nesmysl: 1 })),
      'utf8'
    );

    const result = loadConfig({ baseDir: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join('\n')).toContain('nesmysl');
  });
});

describe('formatLoadFailure', () => {
  it('u chybějícího configu použije hlavičku o chybějící konfiguraci', () => {
    const text = formatLoadFailure({
      ok: false,
      configPath: 'C:\\x\\config.json',
      createdExample: true,
      problems: ['doplň clientId'],
    });

    expect(text).toContain('Chybí konfigurace.');
    expect(text).toContain('  • doplň clientId');
  });

  it('u nevalidního configu uvede cestu k souboru', () => {
    const text = formatLoadFailure({
      ok: false,
      configPath: 'C:\\x\\config.json',
      createdExample: false,
      problems: ['clientId: musí být 17–20 číslic', 'pollIntervalMs: minimum je 500 ms'],
    });

    expect(text).toContain('C:\\x\\config.json');
    expect(text.split('\n')).toHaveLength(3);
  });
});

describe('zabudovaná šablona', () => {
  it('je shodná s config.example.json v repu', () => {
    // Konce řádků normalizujeme — .gitattributes vynucuje LF, ale checkout na cizím
    // stroji to může mít jinak; test hlídá obsah, ne EOL.
    const onDisk = readFileSync(path.join(process.cwd(), EXAMPLE_FILENAME), 'utf8');
    expect(onDisk.replace(/\r\n/g, '\n')).toBe(EXAMPLE_CONFIG_JSON.replace(/\r\n/g, '\n'));
  });

  it('je platný JSON a projde schématem až na placeholder clientId', () => {
    const parsed: unknown = JSON.parse(EXAMPLE_CONFIG_JSON);
    const problems = expectFail(parseConfig(parsed));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('clientId');
  });
});
