/**
 * Daemon entrypoint and main loop.
 *
 * Flags:
 *   --calibrate     measure this machine, print config values, exit
 *   --config <path> where to look for config.json
 *   --debug         one line per tick: state, CPU, baseline, threshold, reason, payload
 *   --no-discord    run everything, print the payload, send nothing
 *
 * Still P7: the rotating daemon log file, the autostart script and packaging. The
 * console logger below is a stand-in so the loop has somewhere to talk.
 *
 * Degradation (SPEC §7/1): every source is allowed to fail. If all of them do, the
 * daemon still works on "running / not running" plus elapsed time.
 */

import path from 'node:path';

import { calibrateCommand } from './calibrate.js';
import { loadConfigOrExit } from './config.js';
import { createPresenceClient, createConsoleTransport } from './discord/client.js';
import { buildActivity } from './discord/presence.js';
import type { ActivityPayload } from './discord/presence.js';
import { createBootstrapLogger, createLogger } from './log.js';
import { createStateMachine } from './state.js';
import type { PresenceState, StateResult } from './state.js';
import { createFocusDetector } from './sources/focus.js';
import { createLogWatcher } from './sources/logs.js';
import { createPlanUsageReader } from './sources/planUsage.js';
import { createProcessSampler, sampleIntervalFor } from './sources/process.js';

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** The --debug tick line. Deliberately one line, so a long run stays readable. */
export function formatDebugLine(
  result: StateResult,
  cpuPercent: number,
  payload: ActivityPayload | null
): string {
  const numbers = [
    `cpu=${cpuPercent.toFixed(2)}%`,
    `baseline=${result.cpuBaseline.toFixed(2)}%`,
    `threshold=${result.cpuThreshold.toFixed(2)}%`,
    `reason=${result.reason}`,
  ].join(' ');

  const shown =
    payload === null
      ? 'payload=<cleared>'
      : `details=${JSON.stringify(payload.details)} state=${JSON.stringify(payload.state ?? '')}`;

  // Both halves of the warmup are worth seeing: that the floor is still being learned,
  // and that a CPU-driven BUSY is being held back because of it.
  const marks = [
    result.warmingUp ? 'warmup' : '',
    result.publish ? '' : 'NOT PUBLISHED (warmup)',
  ].filter((mark) => mark !== '');
  const suffix = marks.length > 0 ? '  <- ' + marks.join(', ') : '';

  return `${result.state.padEnd(7)} ${numbers} ${shown}${suffix}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How often a healthy daemon says so in the log.
 *
 * Without it the log records the first few seconds of a run and then goes quiet for
 * hours, because a connected, idle daemon has nothing to report — which makes a healthy
 * daemon and a hung one look exactly alike in the only diagnostic a background service
 * has. A line every quarter of an hour is ~100 a day; the log rotates at 5 MB.
 */
export const HEARTBEAT_INTERVAL_MS = 15 * 60_000;

export async function runDaemon(argv: readonly string[]): Promise<number> {
  const debug = argv.includes('--debug');
  const noDiscord = argv.includes('--no-discord');

  // The config has to be read before the real logger can be configured, so anything
  // it says is buffered and replayed once the logger exists.
  const bootstrap = createBootstrapLogger();
  const config = loadConfigOrExit({ argv, logger: bootstrap });
  const debugEnabled = debug || config.debug;

  const logger = createLogger({
    level: debugEnabled ? 'debug' : 'info',
    console: debugEnabled || noDiscord,
  });
  bootstrap.drainInto(logger);

  const sampler = createProcessSampler({ logger: logger.child('process') });
  const focus = createFocusDetector({ logger: logger.child('focus') });
  const logs = createLogWatcher({
    logDirOverride: config.logDirOverride,
    logger: logger.child('logs'),
  });
  const planUsage = createPlanUsageReader({ logger: logger.child('plan') });
  const machine = createStateMachine({ calibration: config.busy });

  const client = createPresenceClient({
    clientId: config.clientId,
    minIntervalMs: config.presenceMinIntervalMs,
    logger: logger.child('discord'),
    ...(noDiscord ? { transport: createConsoleTransport() } : {}),
  });
  client.start();

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info(`got ${signal}, shutting down`);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  logger.info('daemon started', {
    noDiscord,
    debug: debugEnabled,
    // Which binary this is, so a log from a user says whether they are on the
    // windowless build without having to ask.
    exe: path.basename(process.execPath),
    pid: process.pid,
  });

  let lastState: PresenceState | null = null;
  let lastHeartbeat = Date.now();

  while (!stopping) {
    let interval = config.pollIntervalMs;
    try {
      const process_ = await sampler.sample();
      const extracts = await logs.poll();
      const focused = process_.running ? await focus.isClaudeFocused(process_.allPids) : false;
      const usage = config.show.planUsage ? await planUsage.read() : null;

      const result = machine.update({
        running: process_.running,
        cpuPercent: process_.cpuPercent,
        focused,
        mcpActivity: extracts.mcpActivity,
        recentTool: extracts.recentTool,
      });

      const payload = buildActivity(
        {
          state: result.state,
          toolName: result.toolName,
          appVersion: extracts.appVersion,
          mcpServerCount: extracts.mcpServerCount,
          planUsage: usage,
          startTime: process_.startTime,
        },
        config,
        Date.now()
      );

      // A CPU-only BUSY during warmup is a guess, so nothing is published at all —
      // whatever was showing before stays, and at startup that is nothing.
      if (result.publish) client.update(payload);
      if (debugEnabled) console.log(formatDebugLine(result, process_.cpuPercent, payload));

      // One line per transition, not per tick: enough to reconstruct what the daemon
      // was doing before a crash without turning the log into a firehose.
      if (result.state !== lastState) {
        lastState = result.state;
        logger.info('state', {
          state: result.state,
          reason: result.reason,
          cpuPercent: round2(process_.cpuPercent),
          published: result.publish,
          ...(result.warmingUp ? { warmingUp: true } : {}),
        });
      }

      const at = Date.now();
      if (at - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeat = at;
        logger.info('heartbeat', {
          state: result.state,
          cpuPercent: round2(process_.cpuPercent),
          cpuBaseline: round2(result.cpuBaseline),
          discordConnected: client.connected,
          claudeRunning: process_.running,
        });
      }

      interval = sampleIntervalFor(result.state, config.pollIntervalMs);
    } catch (error) {
      // An uncaught exception must never take the daemon down (SPEC §P7/1).
      logger.error('tick failed, continuing', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await sleep(interval);
  }

  await client.destroy();
  logger.info('stopped');
  return 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--calibrate')) return calibrateCommand();
  return runDaemon(argv);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
);
