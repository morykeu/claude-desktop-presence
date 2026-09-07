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
import type { Config } from './config.js';
import { formatDebugLine } from './debugLine.js';
import { createPresenceClient, createConsoleTransport } from './discord/client.js';
import { buildActivity } from './discord/presence.js';
import { createLogger } from './log.js';
import type { Logger } from './log.js';
import { createStateMachine } from './state.js';
import type { PresenceState } from './state.js';
import { createFocusDetector } from './sources/focus.js';
import { createLogWatcher } from './sources/logs.js';
import { createPlanUsageReader } from './sources/planUsage.js';
import { createProcessSampler, sampleIntervalFor } from './sources/process.js';

const round2 = (value: number): number => Math.round(value * 100) / 100;

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

/** Everything the loop reads from, so failing to build any of it is one code path. */
interface Sources {
  sampler: ReturnType<typeof createProcessSampler>;
  focus: ReturnType<typeof createFocusDetector>;
  logs: ReturnType<typeof createLogWatcher>;
  planUsage: ReturnType<typeof createPlanUsageReader>;
  machine: ReturnType<typeof createStateMachine>;
  client: ReturnType<typeof createPresenceClient>;
}

function createSources(config: Config, logger: Logger, noDiscord: boolean): Sources {
  return {
    sampler: createProcessSampler({ logger: logger.child('process') }),
    focus: createFocusDetector({ logger: logger.child('focus') }),
    logs: createLogWatcher({
      logDirOverride: config.logDirOverride,
      logger: logger.child('logs'),
    }),
    planUsage: createPlanUsageReader({ logger: logger.child('plan') }),
    machine: createStateMachine({ calibration: config.busy }),
    client: createPresenceClient({
      clientId: config.clientId,
      minIntervalMs: config.presenceMinIntervalMs,
      logger: logger.child('discord'),
      ...(noDiscord ? { transport: createConsoleTransport() } : {}),
    }),
  };
}

/** One shape for "the daemon is ending and here is why", so no path can be silent. */
export function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  return {
    error: error.message,
    name: error.name,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}

export async function runDaemon(argv: readonly string[]): Promise<number> {
  const debug = argv.includes('--debug');
  const noDiscord = argv.includes('--no-discord');

  /*
   * Written straight to daemon.log, before anything is allowed to fail.
   *
   * The real logger's level and console echo come out of the config, so it cannot
   * exist until the config is read — but every reason the daemon refuses to start
   * happens inside that window, and under a Scheduled Task there is no console for
   * them to fall back to. An invalid clientId used to end the process with exit code
   * 1 and not one line anywhere, which is the first thing most new users hit.
   *
   * This replaced a buffering bootstrap logger. Buffering works for warnings, which
   * have a later; it cannot work for a failure that ends the process on the spot.
   */
  const startup = createLogger({ level: 'info', console: false });

  const config = loadConfigOrExit({ argv, logger: startup });
  const debugEnabled = debug || config.debug;

  const logger = createLogger({
    level: debugEnabled ? 'debug' : 'info',
    console: debugEnabled || noDiscord,
  });

  let sources: Sources;
  try {
    sources = createSources(config, logger, noDiscord);
  } catch (error) {
    // How @xhayper/discord-rpc failed inside the packaged .exe: a module that would
    // not load, thrown at construction, with nothing written down about it.
    logger.error('daemon not started: a component failed to initialise', describeError(error));
    return 1;
  }
  const { sampler, focus, logs, planUsage, machine, client } = sources;

  /*
   * The tick loop catches its own errors, but nothing else does. `client.start()`
   * kicks off a floating promise, and a rejection from that — or a throw inside any
   * timer callback — ends the process by default, mid-run, with daemon.log stopping
   * mid-sentence and no way to tell that from the machine being switched off.
   */
  const fatal = (kind: string) => (error: unknown) => {
    logger.error(`daemon stopping: ${kind}`, describeError(error));
    process.exitCode = 1;
  };
  process.on('uncaughtException', fatal('uncaught exception'));
  process.on('unhandledRejection', fatal('unhandled rejection'));

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
    // The last catch-all: anything that escaped runDaemon before it had a logger, or
    // out of --calibrate. Console for whoever has one, file for whoever does not —
    // this used to be console only, which under a Scheduled Task is nowhere.
    createLogger({ level: 'info', console: false }).error(
      'daemon not started: startup threw',
      describeError(error)
    );
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
);
