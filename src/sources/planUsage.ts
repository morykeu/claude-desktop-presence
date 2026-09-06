/**
 * Vytížení plánu.
 *
 * Soubor: %APPDATA%\Claude\plan-usage-history.json — ZŮSTAL v Roaming, nepřestěhoval se
 * spolu s logy (SPEC §0).
 *
 * Ověřený formát:
 *   {"version":2,"samples":[{"t":1786058038582,"org":"<uuid>","u":{"fh":55,"sd":22}}]}
 *
 * TODO (P5):
 *  - brát jen POSLEDNÍ sample podle `t`
 *  - `org` UUID nikdy nikam neposílat — je to identifikátor organizace (SPEC §5)
 *  - soubor může být uprostřed zápisu → parse do try/catch, při chybě vrátit poslední
 *    známou hodnotu
 *  - soubor roste (u testovaného uživatele 52 KB) → necachovat celý obsah v paměti
 *
 * `fh` / `sd` jsou nedokumentované klíče; do UI se pojmenují neutrálně
 * "Vytížení 5h" a "Vytížení týden" a do README patří, že je to interpretace.
 */

export interface PlanUsage {
  /** Pravděpodobně pětihodinové okno, v procentech. */
  fh: number;
  /** Pravděpodobně delší (týdenní) okno, v procentech. */
  sd: number;
  /** Čas posledního sample. */
  at: Date;
}

// TODO (P5): export async function readPlanUsage(): Promise<PlanUsage | null>
