/**
 * Detekce procesů Claude Desktopu a vzorkování CPU.
 *
 * Ověřená fakta (SPEC §0, měřeno 6. 9. 2026 na Claude Desktop 1.46388.4.0, MSIX):
 *  - proces se jmenuje `claude.exe` (Electron: main, gpu, renderer, utility…)
 *  - POČET PROCESŮ NENÍ KONSTANTNÍ — naměřeno 12 i 17. Nikde ho nehardcodovat,
 *    vždy iterovat přes to, co dotaz vrátí.
 *  - hlavní okno má MainWindowTitle === "Claude", ostatní mají prázdný
 *  - instalační cesta je MSIX (C:\Program Files\WindowsApps\Claude_<verze>_x64__<hash>\)
 *    a mění se s každou verzí → NESPOLÉHAT na ni
 *
 * CPU se NEBERE přes `pidusage` — ta na Windows sahá po `wmic`, který Microsoft
 * z Windows 11 odstranil a na cílovém stroji neexistuje. CpuMs se čte ze stejného
 * PowerShell dotazu jako zbytek údajů o procesech, tedy jeden spawn na tick.
 *
 * Ověřený tvar dotazu:
 *
 *   Get-Process claude -ErrorAction SilentlyContinue |
 *     Select-Object Id, MainWindowTitle,
 *       @{n='StartIso';e={$_.StartTime.ToUniversalTime().ToString('o')}},
 *       @{n='CpuMs';e={$_.TotalProcessorTime.TotalMilliseconds}} |
 *     ConvertTo-Json -Compress
 *
 * POZOR: StartTime se musí naformátovat na ISO přímo v PowerShellu — ConvertTo-Json
 * ho jinak vypíše jako /Date(1788649144131)/.
 *
 * ADAPTIVNÍ INTERVAL VZORKOVÁNÍ (P2). Nevzorkovat napevno každé 2 s:
 *   BUSY / ACTIVE → 2 s
 *   IDLE          → 10 s
 *   OFFLINE       → 30 s
 * Důvod: spawn PowerShellu každé 2 s je ~1800 procesů za hodinu a daemon by sám
 * žral CPU, které má měřit. Discord navíc nedovolí update presence častěji než
 * 15 s (presenceMinIntervalMs), takže hustší vzorkování v klidu stejně k ničemu není.
 * pollIntervalMs z configu je spodní hranice (interval při BUSY/ACTIVE), ne fixní perioda.
 *
 * STARTTIMESTAMP MUSÍ BÝT STABILNÍ (P2). Ber NEJSTARŠÍ StartIso ze všech claude
 * procesů — ne StartTime hlavního okna — a drž ho zamrzlý, dokud se nepřejde do
 * OFFLINE. Teprve tam se zahodí. Jinak restart rendereru změní PID hlavního okna,
 * startTimestamp poskočí a Discord resetuje odpočet elapsed času.
 *
 * TODO (P2):
 *  - PowerShell volat s -NoProfile -NonInteractive a vynuceným UTF-8 výstupem
 *    (cesty obsahují diakritiku — bez toho mojibake)
 *  - ConvertTo-Json vrátí u jednoho procesu objekt, u více pole → normalizovat
 *  - cpuPercent = (Δ CpuMs sečtené přes všechny PIDy) / (Δ wall-clock ms × počet jader) × 100
 *  - počet jader z [Environment]::ProcessorCount (na cílovém stroji 12); zjistit jednou
 *    při startu, ne každý tick
 *  - PIDy mezi tiky přibývají a mizí → Δ počítat jen z PIDů přítomných v obou vzorcích,
 *    jinak zmizelý renderer vyrobí zápornou deltu
 *  - klouzavý průměr přes posledních CPU_SAMPLE_WINDOW vzorků
 *  - vzorkování nesmí blokovat hlavní smyčku ani spawnovat PowerShell častěji než
 *    je aktuální adaptivní interval (viz výše)
 */

export const PROCESS_NAME = 'claude.exe';

/** Hlavní okno Claude Desktopu má přesně tenhle title. */
export const MAIN_WINDOW_TITLE = 'Claude';

/** Kolik vzorků vstupuje do klouzavého průměru CPU (při BUSY/ACTIVE 5 × 2 s = 10 s). */
export const CPU_SAMPLE_WINDOW = 5;

/**
 * Adaptivní perioda vzorkování podle stavu. Klíč je PresenceState; TOOL sdílí
 * interval s BUSY. Viz komentář výše — pravidelný spawn PowerShellu není zadarmo.
 */
export const SAMPLE_INTERVAL_MS = {
  BUSY: 2_000,
  TOOL: 2_000,
  ACTIVE: 2_000,
  IDLE: 10_000,
  OFFLINE: 30_000,
} as const;

/** Jeden řádek z PowerShell dotazu, před normalizací. */
export interface RawProcessRow {
  Id: number;
  MainWindowTitle: string;
  /** ISO 8601 v UTC; null, když se StartTime nepodařilo přečíst. */
  StartIso: string | null;
  /** TotalProcessorTime.TotalMilliseconds — kumulativní od startu procesu. */
  CpuMs: number;
}

export type ClaudeProcessInfo = {
  running: boolean;
  /** Proces s neprázdným window title. */
  mainPid: number | null;
  allPids: number[];
  /**
   * NEJSTARŠÍ StartIso ze všech claude procesů, zamrzlý až do přechodu do OFFLINE.
   * Pro Discord startTimestamp — nesmí poskakovat, jinak se resetuje elapsed čas.
   */
  startTime: Date | null;
  /** Součet přes všechny procesy, normalizovaný na počet jader. */
  cpuPercent: number;
};

// TODO (P2): export function createProcessSampler(options): { sample(): Promise<ClaudeProcessInfo> }
