/**
 * State machine.
 *
 * Transition order, first match wins:
 *   not running          -> OFFLINE
 *   mcpActivity          -> BUSY  (TOOL when a fresh recentTool is known)
 *   cpu above threshold  -> BUSY  (TOOL when a fresh recentTool is known)
 *   window focused       -> ACTIVE
 *   otherwise            -> IDLE
 *
 * mcpActivity deliberately outranks CPU. During agentic work, movement in
 * mcp-server-*.log is direct evidence that something is happening; the CPU number is
 * an estimate. It also holds BUSY open while the CPU reading is below the exit
 * threshold, so a long tool call does not flicker back to IDLE.
 *
 * THE CPU THRESHOLD IS NOT A FIXED NUMBER. Measured on the target machine during real
 * work: 3.9 % of one core. Any hand-picked constant is therefore either far too high
 * (the old default of 12 would never have fired) or machine-specific. Instead the
 * daemon tracks its own idle floor and reacts to the rise above it. See SPEC §3.
 */

import { percentile } from './sources/process.js';

export type PresenceState = 'OFFLINE' | 'IDLE' | 'ACTIVE' | 'BUSY' | 'TOOL';

/** Hysteresis factor: BUSY is left only below threshold * BUSY_EXIT_FACTOR. */
export const BUSY_EXIT_FACTOR = 0.6;

/**
 * How many samples the rolling baseline needs before it is trusted. Below this the
 * baseline counts as zero, so the threshold is the configured absolute delta —
 * otherwise a daemon started mid-burst would calibrate its floor to that burst and
 * never report BUSY again.
 */
export const MIN_BASELINE_SAMPLES = 10;

/** Self-calibration parameters. Replaces the old fixed busyCpuThresholdPercent. */
export interface BusyCalibration {
  /** Length of the rolling window the baseline is taken from, in seconds. */
  baselineWindowSec: number;
  /** Which percentile of that window counts as the idle floor. */
  baselinePercentile: number;
  /** BUSY needs at least baseline * this. */
  thresholdMultiplier: number;
  /** ...and at least baseline + this, in percent of one core. */
  thresholdDeltaPercent: number;
  /** Hysteresis: BUSY is left below threshold * this. */
  exitFactor: number;
}

/** One tick of the main loop. */
export interface StateInputs {
  running: boolean;
  /** Summed across all claude.exe processes, in PERCENT OF ONE CORE. Can exceed 100. */
  cpuPercent: number;
  /** Is the Claude window in the foreground? Nice-to-have; false when unknown. */
  focused: boolean;
  /** Has any mcp-server-*.log been touched in the last 10 s? */
  mcpActivity: boolean;
  /** Tool name from the permission dialog, valid for 30 s; null otherwise. */
  recentTool: string | null;
}

export interface StateResult {
  state: PresenceState;
  /** Only set for state === 'TOOL'. */
  toolName: string | null;
  /** Diagnostics for --debug; never sent to Discord. */
  cpuBaseline: number;
  cpuThreshold: number;
  /** What tipped the state over, for --debug. */
  reason: 'offline' | 'mcp' | 'cpu' | 'focus' | 'idle';
  /** The floor is not established yet, so CPU alone cannot be trusted. */
  warmingUp: boolean;
  /**
   * False means: show nothing at all, do not update the presence.
   *
   * Only ever false for a BUSY that rests on the CPU estimate during warmup. Until
   * the floor exists the threshold is the bare configured delta, and on a machine
   * whose idle CPU happens to sit above it — 1.75 % of one core was measured on the
   * development machine — the daemon would announce "working" for the first twenty
   * seconds of every start, while Claude sat there doing nothing. Publishing nothing
   * is honest; publishing IDLE would be a different guess, and publishing BUSY is the
   * wrong one. Everything that does not depend on the floor (OFFLINE, MCP activity,
   * window focus) is published normally throughout.
   */
  publish: boolean;
}

/**
 * Rolling idle floor: a low percentile over EVERY sample from the last N minutes,
 * regardless of the state it was classified as.
 *
 * The length of the window is what makes this work, not any filtering:
 *
 *  - a long burst does not take the window over. At the default 30 minutes, ten
 *    minutes of continuous generation still leaves twenty minutes of quiet samples
 *    behind it, and a 5th percentile lands in the quiet ones.
 *  - a machine whose genuine idle CPU is high settles on that real floor, because
 *    those samples are counted like any others.
 *
 * Gating on BUSY instead — only learning from non-busy samples — deadlocks on exactly
 * that second machine: the first sample is classified BUSY, learning never starts, and
 * the daemon reports "working" forever. A timed escape hatch only postpones it. The
 * long window handles both cases with no extra mechanism.
 *
 * p5 rather than the minimum, so a single anomalous sample cannot drag the floor down
 * and make everything above it look like work.
 */
export class CpuBaseline {
  private readonly samples: { at: number; value: number }[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly percentileRank: number
  ) {}

  push(value: number, at: number): void {
    this.samples.push({ at, value });
    const cutoff = at - this.windowMs;
    while (this.samples.length > 0 && (this.samples[0]?.at ?? 0) < cutoff) {
      this.samples.shift();
    }
  }

  /** null — meaning "not enough evidence yet" — until MIN_BASELINE_SAMPLES accumulate. */
  get value(): number | null {
    if (this.samples.length < MIN_BASELINE_SAMPLES) return null;
    return percentile(
      this.samples.map((sample) => sample.value),
      this.percentileRank
    );
  }

  get size(): number {
    return this.samples.length;
  }

  reset(): void {
    this.samples.length = 0;
  }
}

/** The level cpuPercent has to exceed to enter BUSY. */
export function busyThreshold(baseline: number, calibration: BusyCalibration): number {
  // max, not min: the delta is an absolute floor on the jump. With a near-zero
  // baseline the multiplier alone would make every twitch look like work.
  return Math.max(
    baseline * calibration.thresholdMultiplier,
    baseline + calibration.thresholdDeltaPercent
  );
}

export interface StateMachineOptions {
  calibration: BusyCalibration;
  /** Injection point for tests. */
  now?: () => number;
}

export interface StateMachine {
  update(inputs: StateInputs): StateResult;
  /** Current idle floor, for --debug and diagnostics. */
  readonly baseline: number;
}

export function createStateMachine(options: StateMachineOptions): StateMachine {
  const { calibration } = options;
  const now = options.now ?? (() => Date.now());
  const baseline = new CpuBaseline(
    calibration.baselineWindowSec * 1000,
    calibration.baselinePercentile
  );

  let busy = false;

  function busyLabel(recentTool: string | null): { state: PresenceState; toolName: string | null } {
    return recentTool === null
      ? { state: 'BUSY', toolName: null }
      : { state: 'TOOL', toolName: recentTool };
  }

  return {
    get baseline() {
      return baseline.value ?? 0;
    },

    update(inputs: StateInputs): StateResult {
      const at = now();

      if (!inputs.running) {
        busy = false;
        baseline.reset();
        return {
          state: 'OFFLINE',
          toolName: null,
          cpuBaseline: 0,
          cpuThreshold: 0,
          reason: 'offline',
          warmingUp: false,
          // "Claude is not running" needs no baseline to be certain of.
          publish: true,
        };
      }

      // Every sample counts, whatever it gets classified as — see CpuBaseline. It is
      // pushed before classification so the floor always reflects everything seen.
      baseline.push(inputs.cpuPercent, at);
      const observed = baseline.value;
      const warmingUp = observed === null;
      const currentBaseline = observed ?? 0;
      const threshold = busyThreshold(currentBaseline, calibration);

      // Hysteresis: entering needs the full threshold, staying only exitFactor of it.
      const bar = busy ? threshold * calibration.exitFactor : threshold;
      const cpuSaysBusy = inputs.cpuPercent > bar;

      // MCP activity outranks the CPU estimate and also keeps BUSY open on its own.
      busy = inputs.mcpActivity || cpuSaysBusy;

      const common = {
        cpuBaseline: currentBaseline,
        cpuThreshold: threshold,
        warmingUp,
        publish: true,
      };

      // Movement in mcp-server-*.log is evidence, not an estimate — it needs no floor.
      if (inputs.mcpActivity) {
        return { ...busyLabel(inputs.recentTool), ...common, reason: 'mcp' };
      }
      // The one case that has to stay quiet during warmup.
      if (cpuSaysBusy) {
        return {
          ...busyLabel(inputs.recentTool),
          ...common,
          reason: 'cpu',
          publish: !warmingUp,
        };
      }
      if (inputs.focused) {
        return { state: 'ACTIVE', toolName: null, ...common, reason: 'focus' };
      }
      return { state: 'IDLE', toolName: null, ...common, reason: 'idle' };
    },
  };
}
