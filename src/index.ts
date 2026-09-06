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

import { calibrateCommand } from './calibrate.js';
import { loadConfigOrExit } from './config.js';
import { createPresenceClient, createConsoleTransport } from './discord/client.js';
import { buildActivity } from './discord/presence.js';
import type { ActivityPayload } from './discord/presence.js';
import type { Logger, LogLevel } from './log.js';
import { createStateMachine } from './state.js';
import type { StateResult } from './state.js';
import { createFocusDetector } from './sources/focus.js';
import { createLogWatcher } from './sources/logs.js';
import { createPlanUsageReader } from './sources/planUsage.js';
import { createProcessSampler, sampleIntervalFor } from './sources/process.js';

/** Placeholder until P7 replaces it with the rotating file logger. */
function createConsoleLogger(debug: boolean, scope = ''): Logger {
  const prefix = scope === '' ? '' : `[${scope}] `;
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (level === 'debug' && !debug) return;
    const extra = fields === undefined ? '' : ' ' + JSON.stringify(fields);
    const line = `${prefix}${message}${extra}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (childScope) =>
      createConsoleLogger(debug, scope === '' ? childScope : `${scope}:${childScope}`),
  };
}

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

  return `${result.state.padEnd(7)} ${numbers} ${shown}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runDaemon(argv: readonly string[]): Promise<number> {
  const debug = argv.includes('--debug');
  const noDiscord = argv.includes('--no-discord');

  const logger = createConsoleLogger(debug);
  const config = loadConfigOrExit({ argv, logger });
  const debugEnabled = debug || config.debug;

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

  logger.info('daemon started', { noDiscord, debug: debugEnabled });

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

      client.update(payload);
      if (debugEnabled) console.log(formatDebugLine(result, process_.cpuPercent, payload));

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
