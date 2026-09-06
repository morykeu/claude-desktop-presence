/**
 * Čtení logů Claude Desktopu — whitelist regexů, nic jiného (SPEC §5).
 *
 * Ověřená fakta (SPEC §0, 6. 9. 2026):
 *  - AKTIVNÍ adresář je %LOCALAPPDATA%\Claude\Logs (velké L)
 *  - %APPDATA%\Claude\logs je zastaralý pozůstatek po updatu z 21. 8. 2026;
 *    pořád existuje a obsahuje staré soubory → NESMÍ se použít
 *  - správný adresář = ten kandidát (+ logDirOverride), jehož main.log má nejnovější
 *    mtime; kontrolovat při startu a pak každých LOG_DIR_RECHECK_MS
 *  - tools/call se do mcp.log v této verzi NEZAPISUJE (jsou tam jen tools/list,
 *    prompts/list, resources/list) → neimplementovat
 *
 * TODO (P4): tail s perzistentním byte offsetem, UTF-8; zmenšení souboru = rotace,
 * offset zpět na 0.
 */

/** Jak často se přehodnocuje, který adresář s logy je ten živý. */
export const LOG_DIR_RECHECK_MS = 5 * 60_000;

/** Jak dlouho po zachycení platí jméno nástroje z permission dialogu. */
export const RECENT_TOOL_TTL_MS = 30_000;

/** Okno, ve kterém se změna mtime u mcp-server-*.log počítá jako aktivita. */
export const MCP_ACTIVITY_WINDOW_MS = 10_000;

/**
 * Whitelist regexů. Zpracovává se JEN to, co matchne — kvůli soukromí.
 * TODO (P4): doplnit implementaci extraktorů.
 */
export const PATTERNS = {
  /** main.log — první nález se cachuje. */
  appVersion: /Claude_(\d+\.\d+\.\d+\.\d+)_x64__/,
  /**
   * main.log — POZOR: vzniká JEN když uživatel odklikne dialog s povolením nástroje,
   * ne při každém volání. Není to spolehlivý zdroj.
   *
   * Oproti SPEC §P4 je pomlčka na konci třídy místo \- — sémanticky totožné, jen bez
   * zbytečného escapu (eslint no-useless-escape).
   */
  recentTool: /Received permission response for [\da-f-]+: \w+ \(tool: ([\w:.-]+)\)/,
  /** main.log */
  mcpServerCount: /mcpServerStatus returned (\d+) servers/,
} as const;

/** Výstup jednoho průchodu logy. Každá položka umí být null — daemon musí přežít i samá null. */
export interface LogExtracts {
  appVersion: string | null;
  recentTool: string | null;
  mcpServerCount: number | null;
  /** mtime některého mcp-server-*.log se pohnul za posledních MCP_ACTIVITY_WINDOW_MS. */
  mcpActivity: boolean;
}

export interface LogWatcherOptions {
  logDirOverride: string | null;
}

export interface LogWatcher {
  /** Aktuálně zvolený adresář s logy, nebo null když žádný kandidát neexistuje. */
  readonly logDir: string | null;
  poll(): Promise<LogExtracts>;
}

// TODO (P4): export function createLogWatcher(options: LogWatcherOptions): LogWatcher
