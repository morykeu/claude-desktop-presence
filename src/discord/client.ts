/**
 * Připojení k Discordu přes @xhayper/discord-rpc.
 *
 * TODO (P6):
 *  - Discord neběží → NEPADAT. Reconnect s exponenciálním backoffem 5s → 10s → 30s → max 60s.
 *  - Rate-limit gate: setActivity nejdřív po presenceMinIntervalMs; když je payload
 *    identický s posledním odeslaným, neposílat vůbec nic. (SPEC §3 a §7/5 —
 *    nejčastější chyba v podobných projektech.)
 *  - OFFLINE → clearActivity().
 *  - SIGINT/SIGTERM → clearActivity() + destroy() + čistý exit.
 */

import type { ActivityPayload } from './presence.js';
import type { Logger } from '../log.js';

/** Backoff sekvence v ms pro opětovné připojení k Discordu. */
export const RECONNECT_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000] as const;

export interface PresenceClientOptions {
  clientId: string;
  /** Tvrdé minimum 15 000 ms, viz config. */
  minIntervalMs: number;
  logger: Logger;
}

export interface PresenceClient {
  /** Spustí připojení; nikdy nevyhazuje kvůli neběžícímu Discordu. */
  start(): void;
  /** Zařadí payload k odeslání. null = clearActivity. Respektuje rate-limit gate. */
  update(payload: ActivityPayload | null): void;
  /** clearActivity + odpojení. */
  destroy(): Promise<void>;
  readonly connected: boolean;
}

// TODO (P6): export function createPresenceClient(options: PresenceClientOptions): PresenceClient
