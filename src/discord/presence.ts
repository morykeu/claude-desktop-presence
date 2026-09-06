/**
 * Mapování stavu na Discord payload.
 *
 * TODO (P6):
 *   details: "Claude Desktop — Pracuje… / Nástroj: <name> / Aktivní chat / Nečinný"
 *            (prefix je schválně — hlavička presence ukazuje název aplikace `C.L.A.U.D.E`)
 *   state:   rotace po ROTATION_INTERVAL_MS mezi zapnutými položkami z config.show
 *   limity Discordu: details i state max 128 znaků, ořezávat
 */

import type { PresenceState } from '../state.js';

/** Jak dlouho se drží jedna položka v rotujícím druhém řádku. */
export const ROTATION_INTERVAL_MS = 20_000;

/** Discord ořezává details i state na 128 znaků. */
export const MAX_FIELD_LENGTH = 128;

export interface ActivityButton {
  label: string;
  url: string;
}

/** To, co se posílá do setActivity. */
export interface ActivityPayload {
  details: string;
  state: string | undefined;
  startTimestamp: Date | undefined;
  largeImageKey: string;
  largeImageText: string | undefined;
  smallImageKey: string;
  smallImageText: string | undefined;
  buttons: ActivityButton[] | undefined;
}

/** Vše, z čeho se payload skládá. Žádné citlivé údaje (SPEC §5). */
export interface PresenceInputs {
  state: PresenceState;
  toolName: string | null;
  appVersion: string | null;
  mcpServerCount: number | null;
  planUsage: { fh: number; sd: number } | null;
  startTime: Date | null;
}

// TODO (P6): export function buildActivity(inputs, show, now): ActivityPayload | null
