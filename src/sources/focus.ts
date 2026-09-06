/**
 * Je okno Claude v popředí?
 *
 * TODO (P3): Win32 GetForegroundWindow + GetWindowThreadProcessId.
 *  - BEZ nativních addonů — žádný node-gyp, rozbilo by to `pkg` build (SPEC §7/3).
 *    Buď `koffi` (FFI, funguje s pkg), nebo krátký PowerShell s Add-Type.
 *  - Když se to nepodaří zjistit: vrátit false a zalogovat warning.
 *    Focus je nice-to-have, daemon musí fungovat i bez něj.
 */

// TODO (P3): export async function isClaudeFocused(claudePids: number[]): Promise<boolean>
export {};
