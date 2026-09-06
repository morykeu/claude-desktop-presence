/**
 * Daemon entrypoint.
 *
 * Only --calibrate is wired up so far. The main loop is P7:
 *  - load the config, run the loop on the adaptive interval (sampleIntervalFor)
 *  - an uncaught exception must not take the daemon down -> log it and carry on
 *  - --debug: dump the state to the console every tick
 *  - graceful shutdown: SIGINT/SIGTERM -> clearActivity + destroy + clean exit
 *
 * Degradation (SPEC §7/1): if every log extractor fails, the daemon still has to work
 * on "running / not running" plus elapsed time.
 *
 * main() runs unconditionally at the bottom. There is no "am I the entry module"
 * guard on purpose: this file is the only bundle entry, and the usual checks
 * (import.meta.url vs process.argv[1]) behave differently across the ESM build, the
 * CJS build and a pkg binary. Tests import the modules they exercise directly.
 */

import { calibrateCommand } from './calibrate.js';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--calibrate')) {
    return calibrateCommand();
  }

  // TODO (P7): load the config and start the main loop.
  console.error('The daemon loop is not implemented yet (P7). Try --calibrate.');
  return 1;
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
