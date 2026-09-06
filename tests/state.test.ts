import { describe, expect, it } from 'vitest';

import {
  BUSY_EXIT_FACTOR,
  CpuBaseline,
  MIN_BASELINE_SAMPLES,
  busyThreshold,
  createStateMachine,
} from '../src/state.js';
import type { BusyCalibration, StateInputs } from '../src/state.js';

const CALIBRATION: BusyCalibration = {
  baselineWindowSec: 1800,
  baselinePercentile: 5,
  thresholdMultiplier: 3,
  thresholdDeltaPercent: 1.5,
  exitFactor: 0.6,
};

function inputs(overrides: Partial<StateInputs> = {}): StateInputs {
  return {
    running: true,
    cpuPercent: 0.3,
    focused: false,
    mcpActivity: false,
    recentTool: null,
    ...overrides,
  };
}

/** Drives a machine with a controllable clock. */
function machine(calibration: BusyCalibration = CALIBRATION) {
  let clock = 0;
  const sm = createStateMachine({ calibration, now: () => (clock += 2000) });
  return sm;
}

/** Feeds enough idle samples that the baseline is trusted. */
function warmUp(sm: ReturnType<typeof machine>, cpuPercent = 0.3): void {
  for (let i = 0; i < MIN_BASELINE_SAMPLES; i += 1) sm.update(inputs({ cpuPercent }));
}

describe('busyThreshold', () => {
  it('takes the larger of the multiplier and the absolute delta', () => {
    // baseline 0.3 -> 0.3*3 = 0.9, 0.3+1.5 = 1.8 -> 1.8 wins
    expect(busyThreshold(0.3, CALIBRATION)).toBeCloseTo(1.8, 5);
    // baseline 5 -> 5*3 = 15, 5+1.5 = 6.5 -> 15 wins
    expect(busyThreshold(5, CALIBRATION)).toBeCloseTo(15, 5);
  });

  it('the delta stops a near-zero baseline from making everything busy', () => {
    // Multiplier alone would put the bar at 0.003.
    expect(busyThreshold(0.001, CALIBRATION)).toBeCloseTo(1.501, 5);
  });
});

describe('CpuBaseline', () => {
  it('is null — not zero — until enough samples have accumulated', () => {
    // null means "no evidence yet", which the machine answers with its last known
    // floor. Zero would be an actual claim about the machine.
    const baseline = new CpuBaseline(1_800_000, 5);
    for (let i = 0; i < MIN_BASELINE_SAMPLES - 1; i += 1) baseline.push(50, i * 1000);
    expect(baseline.value).toBe(null);

    baseline.push(50, MIN_BASELINE_SAMPLES * 1000);
    expect(baseline.value).toBeCloseTo(50, 5);
  });

  it('tracks a low percentile, so bursts do not lift the floor', () => {
    const baseline = new CpuBaseline(1_800_000, 5);
    for (let i = 0; i < 18; i += 1) baseline.push(0.3, i * 1000);
    for (let i = 18; i < 20; i += 1) baseline.push(90, i * 1000);

    expect(baseline.value).toBeCloseTo(0.3, 5);
  });

  it('drops samples that fell out of the window', () => {
    const baseline = new CpuBaseline(10_000, 10);
    for (let i = 0; i < 20; i += 1) baseline.push(50, i * 1000);
    expect(baseline.size).toBeLessThanOrEqual(11);
  });

  it('resets to empty', () => {
    const baseline = new CpuBaseline(1_800_000, 5);
    for (let i = 0; i < 20; i += 1) baseline.push(5, i * 1000);
    baseline.reset();
    expect(baseline.size).toBe(0);
    expect(baseline.value).toBe(null);
  });
});

describe('createStateMachine — basic transitions', () => {
  it('reports OFFLINE when Claude is not running', () => {
    const sm = machine();
    const result = sm.update(inputs({ running: false, cpuPercent: 99, focused: true }));

    expect(result.state).toBe('OFFLINE');
    expect(result.reason).toBe('offline');
  });

  it('reports ACTIVE when the window is focused and nothing else is happening', () => {
    const sm = machine();
    warmUp(sm);
    expect(sm.update(inputs({ focused: true })).state).toBe('ACTIVE');
  });

  it('reports IDLE when running quietly in the background', () => {
    const sm = machine();
    warmUp(sm);
    expect(sm.update(inputs()).state).toBe('IDLE');
  });

  it('forgets the baseline across an OFFLINE gap', () => {
    const sm = machine();
    warmUp(sm, 0.5);
    expect(sm.baseline).toBeGreaterThan(0);

    sm.update(inputs({ running: false }));
    expect(sm.baseline).toBe(0);
  });
});

describe('createStateMachine — CPU detection', () => {
  it('does NOT need 12 % — the real signal is a few percent of one core', () => {
    const sm = machine();
    warmUp(sm, 0.32); // measured idle floor on the target machine

    // 3.9 % of one core was measured during real agentic work. The old fixed
    // threshold of 12 would never have fired on this.
    const result = sm.update(inputs({ cpuPercent: 3.9 }));
    expect(result.state).toBe('BUSY');
    expect(result.reason).toBe('cpu');
  });

  it('stays IDLE at the idle floor', () => {
    const sm = machine();
    warmUp(sm, 0.32);
    expect(sm.update(inputs({ cpuPercent: 0.4 })).state).toBe('IDLE');
  });

  it('applies hysteresis on the way out of BUSY', () => {
    const sm = machine();
    warmUp(sm, 0.3);

    const busy = sm.update(inputs({ cpuPercent: 10 }));
    expect(busy.state).toBe('BUSY');

    // threshold ~1.8, exit bar ~1.08. 1.5 is below the threshold but above the
    // exit bar, so BUSY holds instead of flapping.
    expect(sm.update(inputs({ cpuPercent: 1.5 })).state).toBe('BUSY');
    expect(sm.update(inputs({ cpuPercent: 0.5 })).state).toBe('IDLE');
  });

  it('exposes the baseline and threshold for --debug', () => {
    const sm = machine();
    warmUp(sm, 0.3);
    const result = sm.update(inputs({ cpuPercent: 0.3 }));

    expect(result.cpuBaseline).toBeCloseTo(0.3, 5);
    expect(result.cpuThreshold).toBeCloseTo(1.8, 5);
  });

  it('adapts to a noisier machine instead of using a fixed number', () => {
    const quiet = machine();
    warmUp(quiet, 0.3);

    const noisy = machine();
    for (let i = 0; i < 30; i += 1) noisy.update(inputs({ cpuPercent: 8 }));

    expect(noisy.baseline).toBeCloseTo(8, 1);
    // The same 10 % reading means "busy" on the quiet machine and "normal" on the
    // noisy one.
    expect(quiet.update(inputs({ cpuPercent: 10 })).state).toBe('BUSY');
    expect(noisy.update(inputs({ cpuPercent: 10 })).state).toBe('IDLE');
  });

  it('does not calibrate its floor to a burst it started inside of', () => {
    // Daemon started while Claude was already working. Until MIN_BASELINE_SAMPLES
    // the baseline counts as zero, so the absolute delta still catches the work.
    const sm = machine();
    expect(sm.update(inputs({ cpuPercent: 40 })).state).toBe('BUSY');
  });
});

describe('createStateMachine — a long window, not state filtering', () => {
  /** Ticks n samples at `cpuPercent` and returns the last state. */
  function run(sm: ReturnType<typeof machine>, n: number, cpuPercent: number, extra = {}) {
    let state = sm.update(inputs({ cpuPercent, ...extra })).state;
    for (let i = 1; i < n; i += 1) state = sm.update(inputs({ cpuPercent, ...extra })).state;
    return state;
  }

  it('stays BUSY through a ten-minute burst — the window still holds the quiet before it', () => {
    // 2 s per tick. Ten minutes of quiet, then ten minutes of work: the 30-minute
    // window keeps both, and p5 lands in the quiet half.
    const sm = machine();
    run(sm, 300, 0.3);

    expect(run(sm, 300, 20)).toBe('BUSY');
  });

  it('does not let a burst raise the bar it is measured against', () => {
    const sm = machine();
    run(sm, 300, 0.3);

    const first = sm.update(inputs({ cpuPercent: 20 }));
    let latest = first;
    for (let i = 0; i < 300; i += 1) latest = sm.update(inputs({ cpuPercent: 20 }));

    expect(latest.cpuThreshold).toBeCloseTo(first.cpuThreshold, 1);
  });

  it('settles on the real floor of a machine whose idle CPU is high', () => {
    // This is the case that a BUSY gate deadlocks on: every sample would be
    // classified BUSY, learning would never start, and the daemon would report
    // "working" forever. Counting every sample, p5 simply converges on 8.
    const sm = machine();
    let state = sm.update(inputs({ cpuPercent: 8 })).state;
    expect(state).toBe('BUSY'); // nothing learned yet, so the absolute delta applies

    state = run(sm, 30, 8);
    expect(sm.baseline).toBeCloseTo(8, 1);
    expect(state).toBe('IDLE');
  });

  it('p5, not the minimum — one anomalous sample must not drag the floor down', () => {
    const sm = machine();
    sm.update(inputs({ cpuPercent: 0 }));
    run(sm, 60, 5);

    // A single zero among sixty fives leaves p5 near 5, not near 0.
    expect(sm.baseline).toBeGreaterThan(3);
  });

  it('a burst longer than the whole window does eventually drift — documented, not fixed', () => {
    // 30 minutes of continuous work at 2 s a tick is 900 samples; at that point the
    // window contains nothing else. Telling that apart from a permanently high floor
    // would mean waiting for it to end.
    const sm = machine();
    run(sm, 300, 0.3);

    expect(run(sm, 1000, 20)).toBe('IDLE');
  });

  it('recovers the real floor once the work stops', () => {
    const sm = machine();
    run(sm, 300, 0.3);
    run(sm, 300, 20);
    run(sm, 300, 0.1);

    expect(sm.baseline).toBeLessThan(1);
  });
});

describe('createStateMachine — mcpActivity outranks CPU', () => {
  it('reports BUSY on MCP activity even with the CPU at the idle floor', () => {
    const sm = machine();
    warmUp(sm, 0.3);

    const result = sm.update(inputs({ cpuPercent: 0.1, mcpActivity: true }));
    expect(result.state).toBe('BUSY');
    expect(result.reason).toBe('mcp');
  });

  it('MCP activity wins over focus', () => {
    const sm = machine();
    warmUp(sm, 0.3);
    expect(sm.update(inputs({ focused: true, mcpActivity: true })).reason).toBe('mcp');
  });

  it('keeps BUSY alive through a long tool call with no CPU to show for it', () => {
    const sm = machine();
    warmUp(sm, 0.3);

    sm.update(inputs({ cpuPercent: 20 }));
    // Waiting on the network: CPU has collapsed, but the MCP log is still moving.
    for (let i = 0; i < 5; i += 1) {
      expect(sm.update(inputs({ cpuPercent: 0.05, mcpActivity: true })).state).toBe('BUSY');
    }
    // MCP goes quiet too -> back to IDLE.
    expect(sm.update(inputs({ cpuPercent: 0.05 })).state).toBe('IDLE');
  });

  it('reports the CPU as the reason when both fire', () => {
    const sm = machine();
    warmUp(sm, 0.3);
    // mcp is checked first on purpose — it is the more direct evidence.
    expect(sm.update(inputs({ cpuPercent: 50, mcpActivity: true })).reason).toBe('mcp');
  });
});

describe('createStateMachine — TOOL', () => {
  it('upgrades BUSY to TOOL when a fresh tool name is known', () => {
    const sm = machine();
    warmUp(sm, 0.3);

    const result = sm.update(inputs({ cpuPercent: 10, recentTool: 'Bash' }));
    expect(result.state).toBe('TOOL');
    expect(result.toolName).toBe('Bash');
  });

  it('upgrades an MCP-driven BUSY to TOOL as well', () => {
    const sm = machine();
    warmUp(sm, 0.3);

    const result = sm.update(inputs({ mcpActivity: true, recentTool: 'Read' }));
    expect(result.state).toBe('TOOL');
    expect(result.toolName).toBe('Read');
  });

  it('does not use a tool name while idle', () => {
    const sm = machine();
    warmUp(sm, 0.3);

    const result = sm.update(inputs({ cpuPercent: 0.1, recentTool: 'Bash' }));
    expect(result.state).toBe('IDLE');
    expect(result.toolName).toBe(null);
  });
});

describe('BUSY_EXIT_FACTOR', () => {
  it('still matches the documented default', () => {
    expect(BUSY_EXIT_FACTOR).toBe(0.6);
    expect(CALIBRATION.exitFactor).toBe(BUSY_EXIT_FACTOR);
  });
});
