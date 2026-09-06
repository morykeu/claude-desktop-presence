import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RECONNECT_BACKOFF_MS,
  backoffFor,
  createConsoleTransport,
  createPresenceClient,
} from '../src/discord/client.js';
import type { DiscordTransport } from '../src/discord/client.js';
import type { ActivityPayload } from '../src/discord/presence.js';
import type { Logger } from '../src/log.js';

const MIN_INTERVAL_MS = 15_000;

function payload(details: string, state?: string): ActivityPayload {
  return {
    details,
    state,
    startTimestamp: undefined,
    largeImageKey: 'claude_logo',
    largeImageText: 'Claude Desktop',
    smallImageKey: 'idle',
    smallImageText: 'Idle',
    buttons: undefined,
  };
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

interface Fake extends DiscordTransport {
  readonly sent: ActivityPayload[];
  readonly cleared: number;
  readonly connects: number;
  failNextConnects(count: number): void;
  dropConnection(): void;
}

function fakeTransport(): Fake {
  const sent: ActivityPayload[] = [];
  let cleared = 0;
  let connects = 0;
  let failures = 0;
  let onDisconnect: (() => void) | null = null;

  return {
    get sent() {
      return sent;
    },
    get cleared() {
      return cleared;
    },
    get connects() {
      return connects;
    },
    failNextConnects(count: number) {
      failures = count;
    },
    dropConnection() {
      onDisconnect?.();
    },
    connect: () => {
      connects += 1;
      if (failures > 0) {
        failures -= 1;
        // What both "Discord is not running" and "Discord is running but nobody is
        // logged in" look like from here.
        return Promise.reject(new Error('could not connect to Discord'));
      }
      return Promise.resolve();
    },
    setActivity: (activity) => {
      sent.push(activity);
      return Promise.resolve();
    },
    clearActivity: () => {
      cleared += 1;
      return Promise.resolve();
    },
    destroy: () => Promise.resolve(),
    onDisconnect: (handler) => {
      onDisconnect = handler;
    },
  };
}

/** Lets the queued promise callbacks inside the client run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('backoffFor', () => {
  it('follows 5 / 10 / 30 / 60 s and then stays at 60', () => {
    expect(RECONNECT_BACKOFF_MS).toEqual([5_000, 10_000, 30_000, 60_000]);
    expect(backoffFor(0)).toBe(5_000);
    expect(backoffFor(1)).toBe(10_000);
    expect(backoffFor(2)).toBe(30_000);
    expect(backoffFor(3)).toBe(60_000);
    expect(backoffFor(99)).toBe(60_000);
  });
});

describe('createPresenceClient', () => {
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function client(transport: DiscordTransport) {
    return createPresenceClient({
      clientId: '1234567890123456789',
      minIntervalMs: MIN_INTERVAL_MS,
      transport,
      logger: fakeLogger(),
      now: () => clock,
    });
  }

  describe('Discord unavailable', () => {
    it('does not throw when Discord is not running', async () => {
      const transport = fakeTransport();
      transport.failNextConnects(99);
      const c = client(transport);

      expect(() => {
        c.start();
      }).not.toThrow();
      await settle();

      expect(c.connected).toBe(false);
      expect(transport.sent).toHaveLength(0);
    });

    it('keeps accepting state updates while disconnected', async () => {
      const transport = fakeTransport();
      transport.failNextConnects(99);
      const c = client(transport);
      c.start();
      await settle();

      // The main loop keeps ticking; none of this may throw or be lost.
      c.update(payload('one'));
      c.update(payload('two'));
      await settle();

      expect(transport.sent).toHaveLength(0);
      expect(c.connected).toBe(false);
    });

    it('retries with the backoff and sends the latest state once it connects', async () => {
      const transport = fakeTransport();
      transport.failNextConnects(2);
      const c = client(transport);
      c.start();
      await settle();

      c.update(payload('latest'));
      await settle();
      expect(transport.sent).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();

      expect(transport.connects).toBe(3);
      expect(c.connected).toBe(true);
      expect(transport.sent.map((p) => p.details)).toEqual(['latest']);
    });

    it('behaves the same when Discord runs but nobody is logged in', async () => {
      // Same failure shape from the transport's point of view; the point is that the
      // daemon treats it as a normal state rather than a crash.
      const transport = fakeTransport();
      transport.failNextConnects(1);
      const c = client(transport);
      c.start();
      await settle();

      expect(c.connected).toBe(false);
      c.update(payload('waiting'));
      await settle();

      await vi.advanceTimersByTimeAsync(5_000);
      await settle();

      expect(c.connected).toBe(true);
      expect(transport.sent.map((p) => p.details)).toEqual(['waiting']);
    });

    it('reconnects after the connection drops', async () => {
      const transport = fakeTransport();
      const c = client(transport);
      c.start();
      await settle();
      expect(c.connected).toBe(true);

      transport.dropConnection();
      expect(c.connected).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      expect(c.connected).toBe(true);
    });
  });

  describe('rate-limit gate', () => {
    it('sends the first payload immediately', async () => {
      const transport = fakeTransport();
      const c = client(transport);
      c.start();
      await settle();

      c.update(payload('first'));
      await settle();

      expect(transport.sent.map((p) => p.details)).toEqual(['first']);
    });

    it('drops a payload identical to the last one sent', async () => {
      const transport = fakeTransport();
      const c = client(transport);
      c.start();
      await settle();

      c.update(payload('same'));
      await settle();

      clock += MIN_INTERVAL_MS * 10;
      c.update(payload('same'));
      await settle();

      expect(transport.sent).toHaveLength(1);
    });

    it('holds a changed payload until the minimum interval has passed', async () => {
      const transport = fakeTransport();
      const c = client(transport);
      c.start();
      await settle();

      c.update(payload('first'));
      await settle();

      clock += MIN_INTERVAL_MS - 1;
      c.update(payload('second'));
      await settle();
      expect(transport.sent).toHaveLength(1);

      clock += 1;
      await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
      await settle();

      expect(transport.sent.map((p) => p.details)).toEqual(['first', 'second']);
    });

    it('sends the newest state when several updates arrive while throttled', async () => {
      const transport = fakeTransport();
      const c = client(transport);
      c.start();
      await settle();

      c.update(payload('first'));
      await settle();

      c.update(payload('second'));
      c.update(payload('third'));
      c.update(payload('fourth'));
      await settle();
      expect(transport.sent).toHaveLength(1);

      clock += MIN_INTERVAL_MS;
      await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
      await settle();

      expect(transport.sent.map((p) => p.details)).toEqual(['first', 'fourth']);
    });

    it('applies independently of the 20 s rotation', async () => {
      // The rotation is slower than the gate, so they do not collide in practice —
      // but the gate must not rely on that.
      const transport = fakeTransport();
      const c = client(transport);
      c.start();
      await settle();

      c.update(payload('x', 'line A'));
      await settle();

      for (let i = 0; i < 20; i += 1) {
        clock += 1_000;
        c.update(payload('x', `line ${i}`));
        await settle();
      }

      // 20 s of ticking at 1 s each can allow at most two sends past the first.
      expect(transport.sent.length).toBeLessThanOrEqual(3);
    });

    it('clears the activity when the state goes OFFLINE', async () => {
      const transport = fakeTransport();
      const c = client(transport);
      c.start();
      await settle();

      c.update(payload('running'));
      await settle();

      clock += MIN_INTERVAL_MS;
      c.update(null);
      await settle();

      expect(transport.cleared).toBe(1);
    });

    it('re-sends after reconnecting, even if the payload is unchanged', async () => {
      // A fresh connection has no activity on it, so the "identical" rule must not
      // leave the presence blank.
      const transport = fakeTransport();
      const c = client(transport);
      c.start();
      await settle();

      c.update(payload('same'));
      await settle();
      expect(transport.sent).toHaveLength(1);

      transport.dropConnection();
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();

      c.update(payload('same'));
      await settle();

      expect(transport.sent).toHaveLength(2);
    });

    it('keeps the payload pending when a send fails', async () => {
      const transport = fakeTransport();
      const failing: DiscordTransport = {
        ...transport,
        setActivity: () => Promise.reject(new Error('pipe closed')),
      };
      const c = client(failing);
      c.start();
      await settle();

      c.update(payload('lost'));
      await settle();

      expect(c.connected).toBe(false);
      expect(c.lastSentAt).toBe(null);
    });
  });

  describe('shutdown', () => {
    it('clears the activity and disconnects', async () => {
      const transport = fakeTransport();
      const c = client(transport);
      c.start();
      await settle();
      c.update(payload('bye'));
      await settle();

      await c.destroy();

      expect(transport.cleared).toBe(1);
      expect(c.connected).toBe(false);
    });

    it('is safe when it never connected', async () => {
      const transport = fakeTransport();
      transport.failNextConnects(99);
      const c = client(transport);
      c.start();
      await settle();

      await expect(c.destroy()).resolves.toBeUndefined();
    });

    it('stops reconnecting after destroy', async () => {
      const transport = fakeTransport();
      transport.failNextConnects(99);
      const c = client(transport);
      c.start();
      await settle();

      const before = transport.connects;
      await c.destroy();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(transport.connects).toBe(before);
    });
  });
});

describe('createConsoleTransport (--no-discord)', () => {
  it('prints the payload instead of sending it', async () => {
    const lines: string[] = [];
    const transport = createConsoleTransport((line) => lines.push(line));

    await transport.connect();
    await transport.setActivity(payload('Claude Desktop — Working…', 'Version 1.46388.4.0'));
    await transport.clearActivity();

    expect(lines[0]).toContain('no-discord');
    expect(lines[1]).toContain('Working');
    expect(lines[1]).toContain('Version 1.46388.4.0');
    expect(lines[2]).toContain('clearActivity');
  });

  it('needs no Discord at all', async () => {
    const c = createPresenceClient({
      clientId: '1234567890123456789',
      minIntervalMs: MIN_INTERVAL_MS,
      transport: createConsoleTransport(() => undefined),
    });

    c.start();
    await settle();
    c.update(payload('x'));
    await settle();

    expect(c.connected).toBe(true);
    await c.destroy();
  });
});
