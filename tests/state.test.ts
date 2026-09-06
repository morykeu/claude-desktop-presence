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
  baselineWindowSec: 300,
  baselinePercentile: 10,
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
    const baseline = new CpuBaseline(300_000, 10);
    for (let i = 0; i < MIN_BASELINE_SAMPLES - 1; i += 1) baseline.push(50, i * 1000);
    expect(baseline.value).toBe(null);

    baseline.push(50, MIN_BASELINE_SAMPLES * 1000);
    expect(baseline.value).toBeCloseTo(50, 5);
  });

  it('tracks a low percentile, so bursts do not lift the floor', () => {
    const baseline = new CpuBaseline(300_000, 10);
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
    const baseline = new CpuBaseline(300_000, 10);
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

    // A machine whose genuine idle floor is 8 % starts out reporting BUSY, because
    // the daemon has no reason yet to think 8 % is normal here. Sustained elevated
    // CPU that never comes down is a floor, not work, so the unfreeze lets it learn.
    const noisy = machine();
    for (let i = 0; i < 400; i += 1) noisy.update(inputs({ cpuPercent: 8 }));

    expect(noisy.baseline).toBeCloseTo(8, 1);
    // The same 10 % reading now means "busy" on the quiet machine and "normal" on
    // the noisy one.
    expect(quiet.update(inputs({ cpuPercent: 10 })).state).toBe('BUSY');
    expect(noisy.update(inputs({ cpuPercent: 10 })).state).toBe('IDLE');
  });

  it('never gets stuck permanently BUSY on a high idle floor', () => {
    // Without the unfreeze this machine would report "working" forever: the first
    // sample is classified BUSY, learning is frozen, and nothing ever changes.
    const sm = machine();
    let state = sm.update(inputs({ cpuPercent: 8 })).state;
    expect(state).toBe('BUSY');

    for (let i = 0; i < 400; i += 1) state = sm.update(inputs({ cpuPercent: 8 })).state;
    expect(state).toBe('IDLE');
  });

  it('does not calibrate its floor to a burst it started inside of', () => {
    // Daemon started while Claude was already working. Until MIN_BASELINE_SAMPLES
    // the baseline counts as zero, so the absolute delta still catches the work.
    const sm = machine();
    expect(sm.update(inputs({ cpuPercent: 40 })).state).toBe('BUSY');
  });
});

describe('createStateMachine — the baseline only learns from non-busy samples', () => {
  it('stays BUSY through work that runs longer than the baseline window', () => {
    // The hole this guards: with every sample fed in, five minutes of continuous
    // generation becomes the whole window. The 10th percentile then IS the work, the
    // threshold climbs with it, and the state falls back to IDLE mid-answer.
    const sm = machine();
    warmUp(sm, 0.3);

    expect(sm.update(inputs({ cpuPercent: 20 })).state).toBe('BUSY');

    // 2 s per tick, so 200 ticks is well past the 300 s window.
    for (let i = 0; i < 200; i += 1) {
      expect(sm.update(inputs({ cpuPercent: 20 })).state).toBe('BUSY');
    }
  });

  it('does not let the work raise the bar it is measured against', () => {
    const sm = machine();
    warmUp(sm, 0.3);

    const first = sm.update(inputs({ cpuPercent: 20 }));
    let latest = first;
    for (let i = 0; i < 200; i += 1) latest = sm.update(inputs({ cpuPercent: 20 }));

    expect(latest.cpuBaseline).toBeCloseTo(first.cpuBaseline, 5);
    expect(latest.cpuThreshold).toBeCloseTo(first.cpuThreshold, 5);
  });

  it('holds the last known floor once the frozen window goes stale', () => {
    const sm = machine();
    warmUp(sm, 0.3);
    const floor = sm.baseline;

    for (let i = 0; i < 300; i += 1) sm.update(inputs({ cpuPercent: 20 }));
    expect(sm.baseline).toBeCloseTo(floor, 5);

    // Back to quiet: the floor is still the one that was learned while idle.
    expect(sm.update(inputs({ cpuPercent: 0.3 })).cpuBaseline).toBeCloseTo(floor, 5);
  });

  it('freezes learning for MCP-driven BUSY too — that sample is work as well', () => {
    const sm = machine();
    warmUp(sm, 0.3);
    const floor = sm.baseline;

    for (let i = 0; i < 200; i += 1) sm.update(inputs({ cpuPercent: 25, mcpActivity: true }));

    expect(sm.baseline).toBeCloseTo(floor, 5);
  });

  it('resumes learning once the work stops', () => {
    const sm = machine();
    warmUp(sm, 0.3);

    for (let i = 0; i < 50; i += 1) sm.update(inputs({ cpuPercent: 20 }));
    // A new, genuinely quieter idle level gets learned.
    for (let i = 0; i < 40; i += 1) sm.update(inputs({ cpuPercent: 0.1 }));

    expect(sm.baseline).toBeLessThan(0.3);
  });

  it('classifies against the floor learned so far, not including this sample', () => {
    // A single sample must never be able to justify itself.
    const sm = machine();
    warmUp(sm, 0.3);
    expect(sm.update(inputs({ cpuPercent: 3.9 })).cpuBaseline).toBeCloseTo(0.3, 5);
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
