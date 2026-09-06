/**
 * Connection to Discord via @xhayper/discord-rpc.
 *
 * Two things this has to survive without dying, because both are normal:
 *  - Discord is not running at all
 *  - Discord is running but nobody is logged in
 * Neither is an error the daemon can do anything about. It reconnects with a backoff
 * and keeps collecting state in the meantime.
 *
 * The rate-limit gate is the other half. Discord throttles presence updates, and the
 * usual bug in projects like this is updating too often: the updates get dropped and it
 * looks like the presence has frozen (SPEC §7/5). Two independent rules:
 *   1. never call setActivity more often than presenceMinIntervalMs (15 s floor)
 *   2. never send a payload identical to the last one that went out
 * The second line rotates every 20 s, so in practice they do not collide — but the gate
 * does not depend on that.
 */

import type { ActivityPayload } from './presence.js';
import { payloadFingerprint } from './presence.js';
import type { Logger } from '../log.js';

/** Backoff between reconnection attempts. The last value repeats. */
export const RECONNECT_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000] as const;

/**
 * The transport, so the gate and the reconnect logic can be tested without Discord.
 * `--no-discord` swaps in a console implementation.
 */
export interface DiscordTransport {
  connect(): Promise<void>;
  setActivity(payload: ActivityPayload): Promise<void>;
  clearActivity(): Promise<void>;
  destroy(): Promise<void>;
  /** Called when the connection drops after being established. */
  onDisconnect(handler: () => void): void;
}

export interface PresenceClientOptions {
  clientId: string;
  /** Hard floor of 15 000 ms, enforced by the config schema. */
  minIntervalMs: number;
  logger?: Logger;
  transport?: DiscordTransport;
  now?: () => number;
}

export interface PresenceClient {
  /** Starts connecting. Never throws, whatever Discord is doing. */
  start(): void;
  /** Queues a payload. null clears the activity. Subject to the gate. */
  update(payload: ActivityPayload | null): void;
  /** clearActivity + disconnect. Safe to call when never connected. */
  destroy(): Promise<void>;
  readonly connected: boolean;
  /** Diagnostics for --debug. */
  readonly lastSentAt: number | null;
}

export function backoffFor(attempt: number): number {
  const index = Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1);
  return RECONNECT_BACKOFF_MS[index] ?? 60_000;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The real transport. Imported lazily so a missing Discord cannot break startup. */
export function createDiscordTransport(clientId: string): DiscordTransport {
  type RpcClient = {
    login(): Promise<void>;
    destroy(): Promise<void>;
    on(event: string, handler: () => void): void;
    user?: {
      setActivity(activity: Record<string, unknown>): Promise<unknown>;
      clearActivity(): Promise<void>;
    };
  };

  let client: RpcClient | null = null;
  let disconnectHandler: (() => void) | null = null;

  return {
    async connect(): Promise<void> {
      const { Client } = await import('@xhayper/discord-rpc');
      const created = new Client({ clientId }) as unknown as RpcClient;
      created.on('disconnected', () => disconnectHandler?.());
      await created.login();
      client = created;
    },

    async setActivity(payload: ActivityPayload): Promise<void> {
      if (client?.user === undefined) throw new Error('not connected');
      await client.user.setActivity({
        details: payload.details,
        state: payload.state,
        startTimestamp: payload.startTimestamp,
        largeImageKey: payload.largeImageKey,
        largeImageText: payload.largeImageText,
        smallImageKey: payload.smallImageKey,
        smallImageText: payload.smallImageText,
        buttons: payload.buttons,
      });
    },

    async clearActivity(): Promise<void> {
      await client?.user?.clearActivity();
    },

    async destroy(): Promise<void> {
      await client?.destroy();
      client = null;
    },

    onDisconnect(handler: () => void): void {
      disconnectHandler = handler;
    },
  };
}

/** `--no-discord`: everything runs, the payload is printed, nothing is sent. */
export function createConsoleTransport(
  write: (line: string) => void = (line) => console.log(line)
): DiscordTransport {
  return {
    connect: () => {
      write('[no-discord] connected (nothing is actually sent)');
      return Promise.resolve();
    },
    setActivity: (payload) => {
      write('[no-discord] setActivity ' + JSON.stringify(payload));
      return Promise.resolve();
    },
    clearActivity: () => {
      write('[no-discord] clearActivity');
      return Promise.resolve();
    },
    destroy: () => Promise.resolve(),
    onDisconnect: () => undefined,
  };
}

export function createPresenceClient(options: PresenceClientOptions): PresenceClient {
  const now = options.now ?? (() => Date.now());
  const { logger } = options;
  const transport = options.transport ?? createDiscordTransport(options.clientId);

  let connected = false;
  let connecting = false;
  let stopped = false;
  let attempt = 0;

  let pending: ActivityPayload | null = null;
  let hasPending = false;
  let lastFingerprint: string | null = null;
  let lastSentAt: number | null = null;

  let reconnectTimer: NodeJS.Timeout | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let sending = false;

  function clearTimers(): void {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    if (flushTimer !== null) clearTimeout(flushTimer);
    reconnectTimer = null;
    flushTimer = null;
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) return;
    const delay = backoffFor(attempt);
    attempt += 1;
    logger?.info('Discord unavailable, retrying', { inMs: delay });

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  async function connect(): Promise<void> {
    if (stopped || connected || connecting) return;
    connecting = true;
    try {
      await transport.connect();
      connected = true;
      attempt = 0;
      // A fresh connection has nothing on it yet, so the gate must not hold the
      // first payload back.
      lastFingerprint = null;
      lastSentAt = null;
      logger?.info('connected to Discord');
      flush();
    } catch (error) {
      // Discord not running, or running with nobody logged in. Same handling: this
      // is a normal state, not a crash.
      connected = false;
      logger?.debug('Discord connection attempt failed', { error: describeError(error) });
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  }

  function handleDisconnect(): void {
    if (!connected) return;
    connected = false;
    logger?.info('Discord connection dropped');
    scheduleReconnect();
  }

  /** Sends the pending payload if both gate rules allow it; otherwise schedules a retry. */
  function flush(): void {
    if (stopped || !connected || !hasPending || sending) return;

    const fingerprint = payloadFingerprint(pending);
    // Rule 2: nothing changed, so there is nothing to say.
    if (fingerprint === lastFingerprint) {
      hasPending = false;
      return;
    }

    // Rule 1: too soon. Come back exactly when it is allowed.
    const waitMs = lastSentAt === null ? 0 : options.minIntervalMs - (now() - lastSentAt);
    if (waitMs > 0) {
      if (flushTimer === null) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flush();
        }, waitMs);
        flushTimer.unref?.();
      }
      return;
    }

    const payload = pending;
    sending = true;
    hasPending = false;

    const send = payload === null ? transport.clearActivity() : transport.setActivity(payload);
    void send.then(
      () => {
        sending = false;
        lastFingerprint = fingerprint;
        lastSentAt = now();
      },
      (error: unknown) => {
        sending = false;
        // Put it back: a failed send must not be remembered as sent.
        hasPending = true;
        logger?.warn('could not send presence', { error: describeError(error) });
        handleDisconnect();
      }
    );
  }

  transport.onDisconnect(handleDisconnect);

  return {
    get connected() {
      return connected;
    },
    get lastSentAt() {
      return lastSentAt;
    },

    start(): void {
      stopped = false;
      void connect();
    },

    update(payload: ActivityPayload | null): void {
      pending = payload;
      hasPending = true;
      flush();
    },

    async destroy(): Promise<void> {
      stopped = true;
      clearTimers();
      try {
        if (connected) await transport.clearActivity();
        await transport.destroy();
      } catch (error) {
        logger?.debug('error while shutting down the Discord client', {
          error: describeError(error),
        });
      }
      connected = false;
    },
  };
}
