#!/usr/bin/env node
/**
 * The fallback version. About sixty lines: is claude.exe running?
 *
 *   yes -> presence with an elapsed timer
 *   no  -> clear it
 *
 * No logs, no CPU heuristics, no calibration, no config. Nothing here depends on an
 * undocumented path or log format, so a Claude Desktop update cannot break it — which
 * is the whole point. Use it if you do not want to calibrate, or when the real daemon
 * stops working after an update and you want something running while it gets fixed.
 *
 * Usage:  node scripts/minimal.mjs <discord-application-id>
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@xhayper/discord-rpc';

const run = promisify(execFile);

const clientId = process.argv[2];
if (!/^\d{17,20}$/.test(clientId ?? '')) {
  console.error('Usage: node scripts/minimal.mjs <discord-application-id>');
  process.exit(1);
}

const QUERY =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
  "Get-Process claude -ErrorAction SilentlyContinue |" +
  " Select-Object @{n='StartIso';e={$_.StartTime.ToUniversalTime().ToString('o')}} |" +
  ' ConvertTo-Json -Compress';

/** Oldest start time across all claude.exe processes, or null when none are running. */
async function claudeStartedAt() {
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', QUERY],
      { windowsHide: true }
    );
    const parsed = JSON.parse(stdout.trim() || 'null');
    if (!parsed) return null;
    const times = (Array.isArray(parsed) ? parsed : [parsed])
      .map((row) => new Date(row?.StartIso ?? '').getTime())
      .filter((time) => Number.isFinite(time));
    return times.length > 0 ? new Date(Math.min(...times)) : null;
  } catch {
    return null;
  }
}

const client = new Client({ clientId });
let connected = false;
let shown = null;

client.on('ready', () => {
  connected = true;
});
client.on('disconnected', () => {
  connected = false;
  shown = null;
});

const connect = () => client.login().catch(() => setTimeout(connect, 15_000));
void connect();

setInterval(() => {
  void (async () => {
    const startedAt = await claudeStartedAt();
    if (!connected) return;

    const key = startedAt?.getTime() ?? null;
    if (key === shown) return; // Discord throttles; only send real changes.
    shown = key;

    if (startedAt === null) await client.user?.clearActivity();
    else
      await client.user?.setActivity({
        details: 'Claude Desktop',
        startTimestamp: startedAt,
        largeImageKey: 'claude_logo',
        largeImageText: 'Claude Desktop',
      });
  })();
}, 15_000);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void client.user
      ?.clearActivity()
      .catch(() => undefined)
      .then(() => process.exit(0));
  });
}
