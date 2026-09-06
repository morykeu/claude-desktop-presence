import { describe, expect, it, vi } from 'vitest';

import { FALLBACK_MIN_INTERVAL_MS, createFocusDetector } from '../src/sources/focus.js';
import type { Logger } from '../src/log.js';

function fakeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { logger: { warn } as unknown as Logger, warn };
}

describe('createFocusDetector', () => {
  it('is true when the foreground PID is one of the Claude processes', async () => {
    const detector = createFocusDetector({ foregroundPid: () => Promise.resolve(4242) });
    expect(await detector.isClaudeFocused([1, 4242, 9])).toBe(true);
  });

  it('is false when something else is in the foreground', async () => {
    const detector = createFocusDetector({ foregroundPid: () => Promise.resolve(777) });
    expect(await detector.isClaudeFocused([1, 4242, 9])).toBe(false);
  });

  it('is false when the foreground PID is unknown', async () => {
    const detector = createFocusDetector({ foregroundPid: () => Promise.resolve(null) });
    expect(await detector.isClaudeFocused([1, 2])).toBe(false);
  });

  it('short-circuits when there are no Claude processes', async () => {
    const foregroundPid = vi.fn(() => Promise.resolve(1));
    const detector = createFocusDetector({ foregroundPid });

    expect(await detector.isClaudeFocused([])).toBe(false);
    expect(foregroundPid).not.toHaveBeenCalled();
  });

  it('returns false and warns instead of throwing — focus is nice-to-have', async () => {
    const { logger, warn } = fakeLogger();
    const detector = createFocusDetector({
      logger,
      foregroundPid: () => Promise.reject(new Error('user32 exploded')),
    });

    expect(await detector.isClaudeFocused([1])).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('focus');
  });

  it('reports which backend answered', async () => {
    const detector = createFocusDetector({ foregroundPid: () => Promise.resolve(5) });
    expect(detector.method).toBe('pending');
    await detector.isClaudeFocused([5]);
    expect(detector.method).toBe('koffi');
  });
});

describe('focus detection against the real machine', () => {
  // This is the whole point of P3 — the koffi binding either works on Windows or it
  // does not, and a mock cannot tell us which.
  it('resolves a real foreground PID through koffi', async () => {
    const detector = createFocusDetector();

    // Our own process is not the foreground window, so this must be false...
    expect(await detector.isClaudeFocused([process.pid])).toBe(false);
    // ...but the backend still has to have answered, rather than silently failing.
    expect(detector.method).toBe('koffi');
  });

  it('says the window is not ours for an empty PID list', async () => {
    expect(await createFocusDetector().isClaudeFocused([])).toBe(false);
  });
});

describe('PowerShell fallback rate limiting', () => {
  it('keeps the fallback interval long enough that it cannot run away', () => {
    // The fallback spawns PowerShell AND compiles C# per call, so it must never be
    // allowed to run at the 2 s polling rate. There is no unit test for the spawn
    // itself — exercising it would mean starting real processes in a loop.
    expect(FALLBACK_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(5000);
  });
});
