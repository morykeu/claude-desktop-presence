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
