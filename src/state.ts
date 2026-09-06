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

/**
 * Escape hatch for the frozen baseline, as a multiple of baselineWindowSec.
 *
 * Freezing while BUSY has a failure mode of its own: on a machine whose genuine idle
 * floor sits above the starting threshold, the very first sample is classified BUSY,
 * learning never starts, and the daemon reports "working" forever. Elevated CPU that
 * never comes down is a floor, not work — so after this long with no learning at all,
 * samples are accepted again and the floor re-anchors.
 *
 * The bound protects work sessions shorter than baselineWindowSec * this (10 minutes
 * by default). Beyond that the old drift returns; there is no way to tell a very long
 * burst from a high idle floor without waiting for it to end.
 */
export const BASELINE_UNFREEZE_FACTOR = 2;

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
}

/**
 * Rolling idle floor: a percentile over the non-busy samples from the last N seconds.
 *
 * ONLY non-busy samples are fed in. Feeding everything in looks safe — a 10th
 * percentile is supposed to shrug bursts off — but it breaks on work that runs longer
 * than the window: after five minutes of continuous generation the whole window IS the
 * work, so the floor and the threshold climb together and the state drops back to IDLE
 * mid-answer. Same hole as the one guarded at startup, five minutes later.
 *
 * While BUSY nothing is pushed, which also means nothing is pruned — the window is
 * frozen rather than slowly starved. Once it does go stale the machine falls back to
 * the last floor it knew (see createStateMachine).
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
  // Survives a window that has gone stale during long work. Starts at 0 so a daemon
  // launched mid-burst still uses the absolute delta rather than that burst.
  let lastKnownBaseline = 0;
  // When the current uninterrupted BUSY run started; null when not busy.
  let busySince: number | null = null;
  const unfreezeAfterMs = calibration.baselineWindowSec * 1000 * BASELINE_UNFREEZE_FACTOR;

  function busyLabel(recentTool: string | null): { state: PresenceState; toolName: string | null } {
    return recentTool === null
      ? { state: 'BUSY', toolName: null }
      : { state: 'TOOL', toolName: recentTool };
  }

  return {
    get baseline() {
      return baseline.value ?? lastKnownBaseline;
    },

    update(inputs: StateInputs): StateResult {
      const at = now();

      if (!inputs.running) {
        busy = false;
        busySince = null;
        baseline.reset();
        lastKnownBaseline = 0;
        return {
          state: 'OFFLINE',
          toolName: null,
          cpuBaseline: 0,
          cpuThreshold: 0,
          reason: 'offline',
        };
      }

      // Classify against the floor learned SO FAR, then decide whether this sample is
      // allowed to become part of that floor. Pushing first would let the work being
      // measured raise the bar it is measured against.
      const observed = baseline.value;
      if (observed !== null) lastKnownBaseline = observed;
      const currentBaseline = observed ?? lastKnownBaseline;
      const threshold = busyThreshold(currentBaseline, calibration);

      // Hysteresis: entering needs the full threshold, staying only exitFactor of it.
      const bar = busy ? threshold * calibration.exitFactor : threshold;
      const cpuSaysBusy = inputs.cpuPercent > bar;

      // MCP activity outranks the CPU estimate and also keeps BUSY open on its own.
      busy = inputs.mcpActivity || cpuSaysBusy;
      if (busy) busySince ??= at;
      else busySince = null;

      // Learning is frozen while busy — including MCP-driven busy, because that sample
      // is work too. Not pushing also means not pruning, so the window holds rather
      // than starving. The unfreeze is the escape hatch described above.
      const frozenTooLong = busySince !== null && at - busySince > unfreezeAfterMs;
      if (!busy || frozenTooLong) baseline.push(inputs.cpuPercent, at);

      const common = { cpuBaseline: currentBaseline, cpuThreshold: threshold };

      if (inputs.mcpActivity) {
        return { ...busyLabel(inputs.recentTool), ...common, reason: 'mcp' };
      }
      if (cpuSaysBusy) {
        return { ...busyLabel(inputs.recentTool), ...common, reason: 'cpu' };
      }
      if (inputs.focused) {
        return { state: 'ACTIVE', toolName: null, ...common, reason: 'focus' };
      }
      return { state: 'IDLE', toolName: null, ...common, reason: 'idle' };
    },
  };
}
