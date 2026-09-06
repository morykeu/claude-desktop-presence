/**
 * Stavový automat.
 *
 * TODO (P6): přechody + hystereze.
 *   proces neběží           → OFFLINE
 *   cpuPercent > threshold  → BUSY (a pokud je čerstvý recentTool → TOOL)
 *   mcpActivity === true    → BUSY
 *   okno v popředí          → ACTIVE
 *   jinak                   → IDLE
 * Z BUSY zpět až když cpuPercent klesne pod threshold * 0.6.
 *
 * SPEC §0: BUSY je CPU heuristika, ne skutečný stav Clauda — logy tuhle informaci
 * v této verzi Claude Desktopu neobsahují.
 */

export type PresenceState = 'OFFLINE' | 'IDLE' | 'ACTIVE' | 'BUSY' | 'TOOL';

/** Faktor hystereze: z BUSY se vychází až pod threshold * BUSY_EXIT_FACTOR. */
export const BUSY_EXIT_FACTOR = 0.6;

/** Vstupy jednoho ticku hlavní smyčky. */
export interface StateInputs {
  running: boolean;
  /** Součet přes všechny claude.exe, normalizovaný na počet jader. */
  cpuPercent: number;
  /** Je okno Claude v popředí? Nice-to-have, při chybě false. */
  focused: boolean;
  /** Hýbe se mtime některého mcp-server-*.log za posledních 10 s? */
  mcpActivity: boolean;
  /** Jméno nástroje z permission dialogu, platné 30 s; jinak null. */
  recentTool: string | null;
}

export interface StateResult {
  state: PresenceState;
  /** Vyplněné jen pro state === 'TOOL'. */
  toolName: string | null;
}

export interface StateMachineOptions {
  busyCpuThresholdPercent: number;
}

// TODO (P6): export function createStateMachine(options: StateMachineOptions): {
//   update(inputs: StateInputs): StateResult;
// }
