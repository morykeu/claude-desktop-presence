/**
 * Is the Claude window in the foreground?
 *
 * Win32 GetForegroundWindow + GetWindowThreadProcessId, no native addon of our own —
 * node-gyp would break the pkg build (SPEC §7/3).
 *
 * Primary path is koffi: it ships prebuilt binaries, works with pkg, and the call is
 * in-process, which matters because focus is polled every ~2 s while active. Verified
 * working on the target machine.
 *
 * Fallback is a short PowerShell with Add-Type. It is much slower (a process spawn
 * plus a C# compile per call), so it is rate limited and its answer is cached in
 * between. It only exists in case koffi cannot be loaded from a packaged build.
 *
 * If neither works, focus reports false and a warning is logged once. Focus is
 * nice-to-have — the daemon has to work without it.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type koffiModule from 'koffi';

import type { Logger } from '../log.js';

/**
 * koffi is loaded through createRequire rather than `await import()`.
 *
 * Verified the hard way: inside the pkg-packaged .exe a dynamic import fails with
 * "A dynamic import callback was not specified", the fallback kicks in, and focus
 * quietly drops to the slow PowerShell path. createRequire resolves koffi's CJS entry
 * and works in the ESM build, the CJS build and the packaged binary alike.
 */
const requireModule = createRequire(import.meta.url);

export type FocusMethod = 'koffi' | 'powershell' | 'unavailable' | 'pending';

/** The PowerShell fallback is expensive; do not run it more often than this. */
export const FALLBACK_MIN_INTERVAL_MS = 5_000;

const FALLBACK_TIMEOUT_MS = 10_000;

/**
 * Add-Type is compiled fresh on every spawn, which is exactly why this is the
 * fallback and not the primary path.
 */
const FOREGROUND_PID_SCRIPT = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class CdpFg {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '}',
  '"@',
  '$pid_ = 0',
  '$h = [CdpFg]::GetForegroundWindow()',
  'if ($h -ne [IntPtr]::Zero) { [void][CdpFg]::GetWindowThreadProcessId($h, [ref]$pid_) }',
  '$pid_',
].join('\n');

export interface FocusDetector {
  /** True when the foreground window belongs to one of the given PIDs. */
  isClaudeFocused(claudePids: readonly number[]): Promise<boolean>;
  /** Which backend answered last. Diagnostics for --debug. */
  readonly method: FocusMethod;
}

export interface FocusDetectorOptions {
  logger?: Logger;
  /** Injection point for tests: returns the foreground PID, or null when unknown. */
  foregroundPid?: () => Promise<number | null>;
  now?: () => number;
}

type ForegroundReader = () => number | null;

/**
 * Binds GetForegroundWindow / GetWindowThreadProcessId through koffi.
 * Returns null when koffi is unavailable — a packaged build is the likely reason.
 */
function loadKoffiReader(logger?: Logger): ForegroundReader | null {
  try {
    const koffi = requireModule('koffi') as typeof koffiModule;
    const user32 = koffi.load('user32.dll');

    const getForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'void*', []);
    const getWindowThreadProcessId = user32.func(
      '__stdcall',
      'GetWindowThreadProcessId',
      'uint32',
      ['void*', koffi.out(koffi.pointer('uint32'))]
    );

    return () => {
      const handle: unknown = getForegroundWindow();
      if (handle === null || handle === undefined) return null;

      const out = [0];
      getWindowThreadProcessId(handle, out);
      const pid = out[0] ?? 0;
      return pid > 0 ? pid : null;
    };
  } catch (error) {
    logger?.warn('koffi unavailable, falling back to PowerShell for focus', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Foreground PID via PowerShell + Add-Type. Slow; returns null on any failure. */
async function readForegroundPidViaPowerShell(logger?: Logger): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', FOREGROUND_PID_SCRIPT],
      { windowsHide: true }
    );

    let stdout = '';
    let settled = false;

    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, FALLBACK_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', (error: Error) => {
      logger?.warn('focus fallback could not start PowerShell', { error: error.message });
      finish(null);
    });
    child.on('close', () => {
      const pid = Number.parseInt(stdout.trim(), 10);
      finish(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
  });
}

export function createFocusDetector(options: FocusDetectorOptions = {}): FocusDetector {
  const { logger } = options;
  const now = options.now ?? (() => Date.now());

  let method: FocusMethod = 'pending';
  let koffiReader: ForegroundReader | null = null;
  let koffiTried = false;
  let warnedUnavailable = false;

  // Fallback rate limiting: a PowerShell spawn per poll would cost more than the
  // signal is worth, so its answer is reused for FALLBACK_MIN_INTERVAL_MS.
  let fallbackAt = Number.NEGATIVE_INFINITY;
  let fallbackPid: number | null = null;
  let fallbackInFlight: Promise<number | null> | null = null;

  async function foregroundPid(): Promise<number | null> {
    if (options.foregroundPid) {
      method = 'koffi';
      return options.foregroundPid();
    }

    if (!koffiTried) {
      koffiTried = true;
      koffiReader = loadKoffiReader(logger);
    }

    if (koffiReader !== null) {
      try {
        method = 'koffi';
        return koffiReader();
      } catch (error) {
        logger?.warn('koffi foreground lookup failed, falling back', {
          error: error instanceof Error ? error.message : String(error),
        });
        koffiReader = null;
      }
    }

    const at = now();
    if (at - fallbackAt < FALLBACK_MIN_INTERVAL_MS) return fallbackPid;

    fallbackInFlight ??= readForegroundPidViaPowerShell(logger).finally(() => {
      fallbackInFlight = null;
    });
    const pid = await fallbackInFlight;
    fallbackAt = now();
    fallbackPid = pid;

    if (pid === null) {
      method = 'unavailable';
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        logger?.warn('focus detection unavailable, reporting not-focused from now on');
      }
    } else {
      method = 'powershell';
    }
    return pid;
  }

  return {
    get method() {
      return method;
    },

    async isClaudeFocused(claudePids: readonly number[]): Promise<boolean> {
      if (claudePids.length === 0) return false;
      try {
        const pid = await foregroundPid();
        return pid !== null && claudePids.includes(pid);
      } catch (error) {
        // Focus is nice-to-have; never let it take the daemon down.
        logger?.warn('focus detection failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
  };
}

let shared: FocusDetector | null = null;

/** Convenience wrapper over a lazily created shared detector. */
export async function isClaudeFocused(claudePids: readonly number[]): Promise<boolean> {
  shared ??= createFocusDetector();
  return shared.isClaudeFocused(claudePids);
}
