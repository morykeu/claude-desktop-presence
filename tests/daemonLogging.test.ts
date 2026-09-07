import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXAMPLE_CONFIG_JSON } from '../src/config.js';
import { LOG_DIR_NAME, LOG_FILE_NAME } from '../src/log.js';

/**
 * End-to-end: the daemon has to write to its log file WITHOUT --debug.
 *
 * A background service has no console, so daemon.log is the only diagnostic its user
 * has. If production mode were silent it would be useless exactly when it is needed.
 * The unit tests around createLogger cannot catch a regression here, because the thing
 * that would break is how index.ts configures it — the level and the sinks.
 *
 * Runs the built bundle rather than importing anything: importing index.js would start
 * a daemon inside the test process, and the wiring under test only exists there.
 */

const ENTRY = path.resolve('dist/index.js');
const START_TIMEOUT_MS = 25_000;

function waitForLine(logPath: string, matches: (text: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      if (matches(text)) {
        clearInterval(tick);
        resolve(text);
        return;
      }
      if (Date.now() - startedAt > START_TIMEOUT_MS) {
        clearInterval(tick);
        reject(new Error(`nothing matching turned up in ${logPath} within the timeout:\n${text}`));
      }
    }, 250);
  });
}

describe('the daemon logs to its file without --debug', () => {
  let home: string;
  let configPath: string;
  let logPath: string;

  beforeAll(() => {
    home = mkdtempSync(path.join(tmpdir(), 'cdp-daemon-'));
    configPath = path.join(home, 'config.json');
    // LOCALAPPDATA is redirected so the test writes into its own directory rather than
    // the developer's real daemon.log.
    logPath = path.join(home, LOG_DIR_NAME, LOG_FILE_NAME);

    const config = JSON.parse(EXAMPLE_CONFIG_JSON) as Record<string, unknown>;
    config['clientId'] = '1234567890123456789';
    config['debug'] = false;
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('writes the startup line at INFO with no --debug and no console', async () => {
    if (!existsSync(ENTRY)) {
      throw new Error('dist/index.js is missing — run `npm run build` before this test.');
    }

    const child = spawn(process.execPath, [ENTRY, '--config', configPath], {
      env: { ...process.env, LOCALAPPDATA: home },
      // No stdio at all: the daemon has to reach the file sink on its own, exactly as
      // it does when Task Scheduler starts it with no console attached.
      stdio: 'ignore',
    });

    try {
      const text = await waitForLine(logPath, (contents) => contents.includes('daemon started'));

      expect(text).toContain('INFO');
      expect(text).toContain('daemon started');
      // The flag is off, so a DEBUG line would mean the level was wrong.
      expect(text).not.toContain('DEBUG');
    } finally {
      child.kill();
    }
  }, 40_000);

  it('keeps writing INFO lines as it runs, not just the first one', async () => {
    const child = spawn(process.execPath, [ENTRY, '--config', configPath], {
      env: { ...process.env, LOCALAPPDATA: home },
      stdio: 'ignore',
    });

    try {
      // The log directory is picked and the state machine reports its first transition
      // a moment after startup; both are INFO and both arrive without --debug.
      const text = await waitForLine(
        logPath,
        (contents) => contents.split('\n').filter((line) => line.includes('INFO')).length >= 2
      );

      expect(text.split('\n').filter((line) => line.trim() !== '').length).toBeGreaterThan(1);
    } finally {
      child.kill();
    }
  }, 40_000);

  it('writes each line as it happens, not on exit', async () => {
    // Buffered writes would leave nothing behind for a daemon that is killed, which is
    // precisely the case the log exists for.
    const child = spawn(process.execPath, [ENTRY, '--config', configPath], {
      env: { ...process.env, LOCALAPPDATA: home },
      stdio: 'ignore',
    });

    try {
      await waitForLine(logPath, (contents) => contents.includes('daemon started'));
      // Read while the process is still alive; nothing has flushed on exit yet.
      expect(readFileSync(logPath, 'utf8')).toContain('daemon started');
      expect(child.killed).toBe(false);
    } finally {
      child.kill();
    }
  }, 40_000);
});

/**
 * The daemon has to say why it refused to start, not just refuse.
 *
 * A bad or missing clientId is the first thing nearly every new user hits, and it was
 * the one failure that left no trace at all: the process exited 1, Task Scheduler
 * recorded LastTaskResult 1, and daemon.log did not gain a line. The message went to
 * the console, and the windowless build has no console.
 *
 * These run the built bundle without --debug, exactly as the Scheduled Task does.
 */
describe('the daemon records why it refused to start', () => {
  let home: string;
  let logPath: string;

  beforeAll(() => {
    home = mkdtempSync(path.join(tmpdir(), 'cdp-startup-'));
    logPath = path.join(home, LOG_DIR_NAME, LOG_FILE_NAME);
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** Runs to completion with the given config file and returns the log contents. */
  async function runUntilExit(configPath: string): Promise<{ code: number | null; log: string }> {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [ENTRY, '--config', configPath], {
        env: { ...process.env, LOCALAPPDATA: home },
        // No console at all, which is the whole point of the test.
        stdio: 'ignore',
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('the daemon did not exit; it was expected to refuse to start'));
      }, START_TIMEOUT_MS);
      child.on('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
      child.on('error', reject);
    });

    return { code, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '' };
  }

  /**
   * The path as it appears in the log: fields are JSON, so a Windows path is written
   * with escaped separators. Comparing against the raw path would fail on the
   * backslashes while the daemon was behaving perfectly.
   */
  function asLogged(value: string): string {
    return JSON.stringify(value).slice(1, -1);
  }

  function writeConfig(name: string, contents: string): string {
    const configPath = path.join(home, name);
    writeFileSync(configPath, contents, 'utf8');
    return configPath;
  }

  it('writes the reason and the config path for an invalid clientId', async () => {
    const config = JSON.parse(EXAMPLE_CONFIG_JSON) as Record<string, unknown>;
    config['clientId'] = 'not-a-snowflake';
    const configPath = writeConfig('invalid-client-id.json', JSON.stringify(config, null, 2));

    const { code, log } = await runUntilExit(configPath);

    expect(code).toBe(1);
    expect(log).toContain('ERROR');
    expect(log).toContain('daemon not started');
    // The whole point: which file, and what was wrong with it.
    expect(log).toContain(asLogged(configPath));
    expect(log).toContain('clientId');
  }, 40_000);

  it('writes the reason for a config that is not valid JSON', async () => {
    const configPath = writeConfig('broken.json', '{ "clientId": ');

    const { code, log } = await runUntilExit(configPath);

    expect(code).toBe(1);
    expect(log).toContain('daemon not started');
    expect(log).toContain(asLogged(configPath));
    expect(log).toContain('not valid JSON');
  }, 40_000);

  it('starts on a config saved with a UTF-8 BOM instead of refusing', async () => {
    // The other half of the same story: a config Notepad saved as "UTF-8 with BOM"
    // used to die on JSON.parse, and — before the startup logging above — did it
    // silently. It has to load, not merely fail legibly.
    const config = JSON.parse(EXAMPLE_CONFIG_JSON) as Record<string, unknown>;
    config['clientId'] = '1234567890123456789';
    const configPath = writeConfig('bom.json', '﻿' + JSON.stringify(config, null, 2));

    const child = spawn(process.execPath, [ENTRY, '--config', configPath], {
      env: { ...process.env, LOCALAPPDATA: home },
      stdio: 'ignore',
    });

    try {
      const log = await waitForLine(logPath, (text) => text.includes('daemon started'));

      // The earlier cases in this describe share the log file, so look only at lines
      // about THIS config — otherwise their failures would count as this one's.
      const aboutThisConfig = log.split('\n').filter((line) => line.includes(asLogged(configPath)));
      expect(aboutThisConfig).toEqual([]);
    } finally {
      child.kill();
    }
  }, 40_000);

  it('writes the reason on a first run, where the config had to be created', async () => {
    // Exit code 1 with "fill in clientId" is the very first thing a new user sees, and
    // under a Scheduled Task they see none of it.
    const configPath = path.join(mkdtempSync(path.join(tmpdir(), 'cdp-first-')), 'config.json');

    const { code, log } = await runUntilExit(configPath);

    expect(code).toBe(1);
    expect(log).toContain('daemon not started');
    expect(log).toContain('clientId');
    rmSync(path.dirname(configPath), { recursive: true, force: true });
  }, 40_000);
});
