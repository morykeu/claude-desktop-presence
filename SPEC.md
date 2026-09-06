# claude-desktop-presence — spec + prompty pro Claude Code

Discord Rich Presence pro **Claude Desktop na Windows**. Standalone daemon, žádný zásah do Claude Desktopu, žádný developer mód.

---

## 0. Ověřená fakta (průzkum 6. 9. 2026, Claude Desktop `1.46388.4.0`, Windows MSIX)

Tohle není odhad — bylo změřeno na reálné instalaci. Zbytek specifikace na tom stojí.

| Signál | Stav | Detail |
|---|---|---|
| Proces aplikace | ✅ spolehlivé | `claude.exe` (Electron). **Počet instancí není konstantní — naměřeno 12, 16 i 17**, nikde ho nehardcodovat. Hlavní okno = ten proces, který má neprázdný `MainWindowTitle` (hodnota `"Claude"`). |
| `wmic` | ❌ **neexistuje** | Microsoft ho z Windows 11 odstranil. **Důsledek: `pidusage` na tomhle stroji nefunguje**, protože po něm na Windows sahá. CPU se čte z PowerShellu (viz §3). |
| Discord IPC | ✅ dostupné | Pipe `\\.\pipe\discord-ipc-0` existuje, když běží Discord. |
| **Aktivní log adresář** | ⚠️ **přesunut** | Živý: `%LOCALAPPDATA%\Claude\Logs`. Zastaralý: `%APPDATA%\Claude\logs` (poslední zápis 21. 8. 2026, kdy proběhl update). **Nutno detekovat za běhu.** |
| Verze aplikace | ✅ | Vyparsovatelná ze stack trace v `main.log`: `Claude_1.46388.4.0_x64__pzs8sxrjxfjjc`. |
| Vytížení plánu | ✅ živé | `%APPDATA%\Claude\plan-usage-history.json` → `{"version":2,"samples":[{"t":<epoch_ms>,"org":"<uuid>","u":{"fh":55,"sd":22}}]}`. `fh`/`sd` = procenta ve dvou oknech (pravděpodobně 5hodinové a 7denní — ověřit porovnáním s UI). |
| Heartbeat běhu | ✅ | `main.log`, řádek `[process-memory] trigger=interval tree_rss_sum=...MB electron(10)=...MB` každých ~30–60 s. |
| Jméno nástroje | ⚠️ jen občas | `main.log`: `Received permission response for <uuid>: once (tool: <toolName>)`. **Objeví se jen když uživatel odklikne povolení**, ne při každém volání. |
| Aktivita MCP serverů | ✅ nepřímo | `%LOCALAPPDATA%\Claude\Logs\mcp-server-<Name>.log` — mtime se hýbe, když server něco dělá. |
| **Živé "Claude přemýšlí"** | ❌ **není** | `mcp.log` obsahuje `method="tools/list"`, `"prompts/list"`, `"resources/list"` — ale **žádné `tools/call`**. Volání nástrojů se v této verzi nelogují. Nelze z logů spolehlivě zjistit, co Claude právě dělá. |

**Důsledek pro design:** místo parsování logů na "co Claude dělá" se stav `busy` odvodí z **CPU heuristiky** (viz §3). Log parser zůstává, ale jako doplněk, ne jako základ.

---

## 1. Volba stacku

**Node.js + TypeScript.** Důvody:

- `@xhayper/discord-rpc` je udržovaná; původní `discord-rpc` od Discordu je archivovaný a nedoporučuje se.
- `pkg` / `@yao-pkg/pkg` umí zabalit do jednoho `.exe` → uživatel nemusí mít nainstalovaný Node.
- GitHub Actions pro release buildy jsou triviální.

**Alternativa, kdyby vadila:** Python + `pypresence` + `psutil`. Kratší kód, ale distribuce přes PyInstaller je otravnější a antiviry to častěji označují. Pokud to nemá jít na GitHub pro cizí lidi, Python je klidně v pořádku.

---

## 2. Nastavení Discordu (uděláš ručně, jednorázově, ~3 minuty)

Tohle **nemůže udělat kód** — potřebuje to tvůj účet.

1. https://discord.com/developers/applications → **New Application**.

   > ⚠️ **Discord blokuje název `Claude`** — vrací "Název aplikace je neplatný". Blokované jsou i
   > varianty `Claude Desktop`, `Claude AI`, `Claude.ai` a `claude`; filtr zjevně matchuje podřetězec
   > "claude" a chrání ochrannou známku. Ověřeno 6. 9. 2026.
   >
   > **Použij `C.L.A.U.D.E`** — projde a je čitelné. Alternativy, pokud by se filtr změnil:
   > `Claudius`, `Desktop Presence`, `CDRP`.
   >
   > Neobcházej filtr neviditelnými znaky (zero-width space apod.) — Discord za to aplikace maže
   > a zdědil by ten problém každý, kdo si nástroj nainstaluje.

2. Zkopíruj **Application ID** (číslo) — to půjde do konfigurace.
3. **Rich Presence → Art Assets** → nahraj obrázky (min. 512×512 PNG):
   - klíč `claude_logo` — hlavní ikona
   - klíč `busy` — malá ikona, když Claude pracuje
   - klíč `idle` — malá ikona, když nečinný
4. Discord → Nastavení → **Aktivita** → zapnuto "Zobrazovat aktuální aktivitu jako stav".

> Application ID je veřejná hodnota, není to tajemství — může být klidně v repu jako default.

---

## 3. Návrh chování

### Stavový model

```
OFFLINE   → Claude.exe neběží           → presence smazána (clearActivity)
IDLE      → běží, nízké CPU             → "Nečinný"
ACTIVE    → běží a okno je v popředí    → "Aktivní chat"
BUSY      → CPU nad prahem              → "Pracuje…"
TOOL      → BUSY + nedávný permission   → "Nástroj: <jméno>"
```

### Detekce `BUSY` (jádro celé věci)

Log parsing tady selhal, takže se to dělá takhle:

1. Jedním PowerShell dotazem posbírat všechny procesy `claude.exe` i s `TotalProcessorTime`. **Bez `pidusage`** — ta na Windows sahá po `wmic`, který na cílovém stroji neexistuje (viz §0). Přesný tvar dotazu je v §P2.
2. Spočítat delta CPU-ms za interval **jen z PIDů přítomných v obou po sobě jdoucích vzorcích** (`CpuMs` je kumulativní od startu procesu, zmizelý renderer by jinak vyrobil zápornou deltu), vydělit `Δ wall-clock ms × počet jader` → procenta.
3. Klouzavý průměr přes posledních 5 vzorků, aby to neblikalo.
4. Práh: `> 12 %` → `BUSY`. **Práh musí být v konfiguraci**, protože závisí na CPU.
5. Hystereze: do `BUSY` se přechází nad prahem, zpět až pod `práh × 0.6` — jinak to bude oscilovat.

**Vzorkování je adaptivní, ne fixní na 2 s:** `BUSY`/`TOOL`/`ACTIVE` → 2 s, `IDLE` → 10 s, `OFFLINE` → 30 s. Spawn PowerShellu každé 2 s je ~1800 procesů za hodinu a daemon by sám žral CPU, které má měřit; Discord navíc nedovolí update presence častěji než 15 s. `pollIntervalMs` z configu je **spodní hranice**, ne fixní perioda.

**Známý falešný pozitiv:** scrollování, přehrávání videa a načítání velkého chatu taky žerou CPU. Zdokumentovat v README, neschovávat.

### Mapování na Discord presence

| Pole | Obsah |
|---|---|
| `details` (1. řádek) | `Claude Desktop — <stav>`, kde stav je `Pracuje…` / `Aktivní chat` / `Nečinný` / `Nástroj: <name>`. Prefix "Claude Desktop" tu je schválně: hlavička presence ukazuje název aplikace (`C.L.A.U.D.E`), takže skutečné jméno musí nést tenhle řádek. |
| `state` (2. řádek) | Rotuje po 20 s mezi: `Vytížení 5h: 55 %`, `Verze 1.46388.4.0`, `MCP: 22 serverů` (jen ty položky, které jsou v configu zapnuté) |
| `startTimestamp` | **Nejstarší** `StartTime` ze všech `claude.exe` procesů, **zamrzlý až do přechodu do `OFFLINE`** → Discord ukáže "elapsed". Nesmí se brát start procesu s hlavním oknem: restart rendereru změní jeho PID, timestamp by poskočil a Discord by odpočet resetoval. |
| `largeImageKey` | `claude_logo` |
| `largeImageText` | `Claude Desktop 1.46388.4.0` |
| `smallImageKey` | `busy` / `idle` |
| `buttons` | Volitelně odkaz na repo. **Pozn.: vlastní tlačítka nevidíš na svém profilu, jen ostatní.** |

> **Texty nejsou v kódu.** Všechny řetězce z téhle tabulky žijí v sekci `text` v `config.json`
> (viz §4) — repo jde na GitHub, takže si je každý může přeložit. České znění je default
> v `config.example.json`. Zástupné symboly ve složených závorkách (`{app}`, `{status}`,
> `{tool}`, `{percent}`, `{version}`, `{count}`) se dosazují při vykreslení.
>
> Diagnostické a logovací hlášky daemona jsou naopak **anglicky** — jde o veřejné repo
> a chybové hlášky čtou i cizí lidé.

### Rate limit — nepřehlédnout

Discord aktualizace presence **throttluje**. Nastav minimální interval mezi `setActivity` na **15 sekund** a interně drž poslední odeslaný payload — pokud se nic nezměnilo, neposílej vůbec nic. Bez tohohle to Discord začne zahazovat a bude to vypadat jako bug v kódu.

---

## 4. Struktura repa

```
claude-desktop-presence/
├─ src/
│  ├─ index.ts               # entrypoint, hlavní smyčka, graceful shutdown
│  ├─ config.ts              # načtení + validace config.json, defaulty
│  ├─ discord/
│  │  ├─ client.ts           # připojení, reconnect s backoffem, rate-limit gate
│  │  └─ presence.ts         # stav → payload, rotace 2. řádku
│  ├─ sources/
│  │  ├─ process.ts          # nalezení claude.exe, startTime, CPU vzorkování
│  │  ├─ focus.ts            # GetForegroundWindow → PID → je to Claude?
│  │  ├─ logs.ts             # detekce log adresáře, tail s offsetem, extraktory
│  │  └─ planUsage.ts        # parse plan-usage-history.json, poslední sample
│  ├─ state.ts               # stavový automat + hystereze
│  └─ log.ts                 # vlastní logování daemona
├─ config.example.json
├─ scripts/install-autostart.ps1
├─ .github/workflows/release.yml
├─ README.md
└─ package.json
```

### `config.example.json`

```json
{
  "clientId": "SEM_APPLICATION_ID",
  "pollIntervalMs": 2000,
  "presenceMinIntervalMs": 15000,
  "busyCpuThresholdPercent": 12,
  "show": {
    "planUsage": true,
    "appVersion": true,
    "mcpServerCount": true,
    "toolNames": true,
    "elapsedTime": true
  },
  "text": {
    "appName": "Claude Desktop",
    "detailsFormat": "{app} — {status}",
    "statusBusy": "Pracuje…",
    "statusTool": "Nástroj: {tool}",
    "statusActive": "Aktivní chat",
    "statusIdle": "Nečinný",
    "planUsageFiveHour": "Vytížení 5h: {percent} %",
    "planUsageWeek": "Vytížení týden: {percent} %",
    "appVersion": "Verze {version}",
    "mcpServerCount": "MCP: {count} serverů",
    "largeImageText": "{app} {version}"
  },
  "logDirOverride": null,
  "debug": false
}
```

Poznámky ke schématu:

- `pollIntervalMs` je **spodní hranice** vzorkování, ne fixní perioda — viz adaptivní interval v §3.
- Celá sekce `text` je volitelná; chybějící klíče se doplní českými defaulty výše.
- Neznámý klíč není fatální, jen se ohlásí varováním s návrhem („did you mean…"), aby překlep
  v configu nezůstal tiše ignorovaný a zároveň starší daemon nespadl na novějším configu.

### Kde se config hledá

V tomhle pořadí, první nález vyhrává:

1. `--config <cesta>` na příkazové řádce (přijme i adresář)
2. adresář `.exe`, když je daemon zabalený přes `pkg`
3. adresář vstupního modulu

**Nikdy `cwd`.** V P7 poběží daemon jako Scheduled Task, kde je pracovní adresář typicky
`C:\Windows\System32` — tam by config hledal a podle fallbacku si tam zapsal šablonu.

---

## 5. Ochrana soukromí — tvrdé pravidlo

Daemon **nikdy nečte obsah konverzací**. Do repa i README napsat explicitně:

- Z logů se extrahují **jen řádky odpovídající whitelistu regexů**, nic jiného se nikam nepředává.
- Nesahat na `%APPDATA%\Claude\Local Storage`, `IndexedDB`, `Network\Cookies`, `sentry\` ani na OAuth tokeny. Anthropic navíc zakazuje používání OAuth tokenů z účtu v jiných produktech.
- Do Discordu neposílat nikdy: názvy chatů, cesty k souborům, `org` UUID z `plan-usage-history.json`, jména uživatele.
- V configu mít `show.*` přepínače, aby si každý mohl vypnout i to procento vytížení.

---

## 6. Prompty pro Claude Code

Spouštěj postupně, každý v novém tahu. Po každém nech Claude Code říct, co udělal, než pustíš další.

---

### P0 — bootstrap

```
Založ nový TypeScript projekt `claude-desktop-presence` — Node 20+, ESM, striktní tsconfig,
build přes tsup do dist/, eslint + prettier. Cílová platforma Windows.

Závislosti: @xhayper/discord-rpc, zod (validace configu).
Dev: typescript, tsup, @types/node, vitest.

POZN.: pidusage tu původně bylo, ale vypadlo — na Windows sahá po `wmic`, který na
cílovém stroji neexistuje (§0). CPU se čte z PowerShellu, viz P2.

Vytvoř kostru souborů podle téhle struktury (zatím prázdné moduly s exportovanými
typy a TODO komentáři, žádná logika):

src/index.ts, src/config.ts, src/state.ts, src/log.ts,
src/discord/client.ts, src/discord/presence.ts,
src/sources/process.ts, src/sources/focus.ts, src/sources/logs.ts, src/sources/planUsage.ts

Přidej config.example.json (obsah ti dám v dalším promptu), .gitignore, LICENSE (MIT).
Zatím nepiš README.
```

---

### P1 — config

```
Implementuj src/config.ts.

Načítá config.json ze stejného adresáře jako spustitelný soubor; když neexistuje,
zkopíruje config.example.json a vypíše hlášku, že uživatel musí doplnit clientId.

Schéma (zod), s těmito defaulty:
  clientId: string, povinné, musí být 17-20 číslic
  pollIntervalMs: number, default 2000, min 500
  presenceMinIntervalMs: number, default 15000, min 15000   <- Discord throttluje, pod 15s nepovolit
  busyCpuThresholdPercent: number, default 12, rozsah 1-100
  show: { planUsage, appVersion, mcpServerCount, toolNames, elapsedTime } — všechno boolean, default true
  text: viz sekce `text` v §4 — všechno string, defaulty česky
  logDirOverride: string | null, default null
  debug: boolean, default false

Cesta ke configu se hledá podle §4 ("Kde se config hledá") — přepínač --config <cesta>
má přednost, pak adresář .exe pod pkg, pak adresář vstupního modulu. Nikdy cwd.

Při nevalidním configu vypiš čitelnou chybu (ne zod stack trace) a skonči s kódem 1.
Napiš k tomu vitest testy.
```

---

### P2 — detekce procesu a CPU

```
Implementuj src/sources/process.ts.

export type ClaudeProcessInfo = {
  running: boolean;
  mainPid: number | null;      // proces s neprázdným window title
  allPids: number[];
  startTime: Date | null;      // nejstarší StartIso, zamrzlý — viz níž
  cpuPercent: number;          // součet přes všechny procesy, normalizovaný na počet jader
};

Ověřená fakta o cílovém systému:
- Proces se jmenuje `claude.exe` (Electron: main, gpu, renderer, utility...).
  POČET NENÍ KONSTANTNÍ — naměřeno 12, 16 i 17. Nikde ho nehardcoduj, vždy iteruj
  přes to, co dotaz vrátí.
- Hlavní okno má MainWindowTitle == "Claude", ostatní mají prázdný.
- Nespoléhej na instalační cestu — je to MSIX balíček pod
  C:\Program Files\WindowsApps\Claude_<verze>_x64__<hash>\, ta se mění s každou verzí.
- `wmic` na tomhle stroji NEEXISTUJE (Microsoft ho z Windows 11 odstranil), takže
  ŽÁDNÝ pidusage — sahá po něm.

Jeden PowerShell dotaz dá všechno naráz (ověřeno na cílovém stroji):

  Get-Process claude -ErrorAction SilentlyContinue |
    Select-Object Id, MainWindowTitle,
      @{n='StartIso';e={$_.StartTime.ToUniversalTime().ToString('o')}},
      @{n='CpuMs';e={$_.TotalProcessorTime.TotalMilliseconds}} |
    ConvertTo-Json -Compress

- Spouštěj s -NoProfile -NonInteractive a **vynuť UTF-8 výstup** (cesty obsahují
  diakritiku — bez toho dostaneš mojibake).
- StartTime musí být na ISO naformátovaný už v PowerShellu; ConvertTo-Json ho jinak
  vypíše jako /Date(1788649144131)/.
- ConvertTo-Json vrátí u JEDNOHO procesu objekt, u více pole → normalizuj na pole.
- Deltu CpuMs počítej jen z PIDů přítomných v OBOU po sobě jdoucích vzorcích. CpuMs je
  kumulativní od startu procesu, zmizelý renderer by jinak vyrobil zápornou deltu
  a nový proces falešný špičku.
- cpuPercent = Δ CpuMs / (Δ wall-clock ms × jádra) × 100; jádra z
  [Environment]::ProcessorCount jednou při startu (na cílovém stroji 12).
- Klouzavý průměr přes posledních 5 vzorků.
- Adaptivní interval podle SAMPLE_INTERVAL_MS (§3): BUSY/TOOL/ACTIVE 2 s, IDLE 10 s,
  OFFLINE 30 s. pollIntervalMs z configu je spodní hranice, ne fixní perioda.
- startTime = NEJSTARŠÍ StartIso ze všech procesů, zamrzlý dokud se nepřejde do OFFLINE.
  Novější „nejstarší" start znamená restart aplikace → přijmi ho.
- Vzorkování nesmí blokovat hlavní smyčku ani spawnovat překrývající se dotazy.

Testy piš s nasimulovanými vzorky — hlavně zmizelý PID, jediný proces (objekt místo
pole) a restart aplikace (nový nejstarší StartIso).
```

---

### P3 — focus okna

```
Implementuj src/sources/focus.ts — zjisti, jestli je okno Claude v popředí.

export async function isClaudeFocused(claudePids: number[]): Promise<boolean>

Použij Win32 GetForegroundWindow + GetWindowThreadProcessId. Preferuj to bez nativních
addonů (žádný node-gyp — rozbilo by to `pkg` build). Buď přes `koffi` (FFI, funguje
s pkg), nebo přes krátký PowerShell s Add-Type.

Pokud se to nepodaří zjistit, vrať false a zaloguj warning — focus je nice-to-have,
daemon musí fungovat i bez něj.
```

---

### P4 — logy

```
Implementuj src/sources/logs.ts.

DŮLEŽITÉ — ověřeno na reálné instalaci 6.9.2026:
- Aktivní adresář je `%LOCALAPPDATA%\Claude\Logs` (velké L).
- `%APPDATA%\Claude\logs` je zastaralý pozůstatek po updatu, ale pořád existuje a
  obsahuje staré soubory. Nesmí se použít.
- Adresář vyber tak, že z obou kandidátů (+ logDirOverride) vezmeš ten, jehož
  `main.log` má nejnovější mtime. Kontroluj to při startu a pak každých 5 minut.

Implementuj tail s perzistentním byte offsetem. Když soubor zmenší velikost = rotace,
resetuj offset na 0. Čti jako UTF-8.

Extraktory (whitelist regexů, nic jiného se nezpracovává — kvůli soukromí):

1) appVersion — z main.log, vzor: Claude_(\d+\.\d+\.\d+\.\d+)_x64__
   Bere se první nález, cachuje se.

2) recentTool — z main.log, vzor:
   Received permission response for [\da-f-]+: \w+ \(tool: ([\w:.\-]+)\)
   Platnost 30 s od zachycení, pak expiruje.
   POZOR: tenhle řádek vzniká JEN když uživatel odklikne dialog s povolením nástroje,
   ne při každém volání. Neber to jako spolehlivý zdroj.

3) mcpServerCount — z main.log, vzor:
   mcpServerStatus returned (\d+) servers

4) mcpActivity — mtime souborů `mcp-server-*.log` v log adresáři.
   Vrať true, pokud se některý změnil za posledních 10 s.

Explicitně NEIMPLEMENTUJ parsování tools/call z mcp.log — ověřoval jsem to, v této
verzi se volání nástrojů do mcp.log nezapisují (jsou tam jen tools/list, prompts/list,
resources/list). Kdyby to Anthropic v budoucnu přidal, půjde to doplnit sem.
```

---

### P5 — vytížení plánu

```
Implementuj src/sources/planUsage.ts.

Soubor: %APPDATA%\Claude\plan-usage-history.json  (zůstal v Roaming, nepřestěhoval se!)

Ověřený formát:
{"version":2,"samples":[{"t":1786058038582,"org":"<uuid>","u":{"fh":55,"sd":22}}]}

- `t` = epoch ms, `u.fh` a `u.sd` = procenta ve dvou různých oknech
  (fh = pravděpodobně five-hour, sd = delší okno; do UI textu je pojmenuj neutrálně
  "Vytížení 5h" a "Vytížení týden", a do README napiš, že je to interpretace, ne
  dokumentované API).
- Ber jen POSLEDNÍ sample podle `t`.
- `org` UUID nikdy nikam neposílej — je to identifikátor organizace.
- Soubor může být uprostřed zápisu → parse obal do try/catch, při chybě vrať poslední
  známou hodnotu.
- Může být velký (u testovaného uživatele 52 KB a roste), takže necachuj celý obsah
  v paměti trvale.

Signatura: export async function readPlanUsage(): Promise<{ fh: number; sd: number; at: Date } | null>
```

---

### P6 — stavový automat a Discord

```
Implementuj src/state.ts, src/discord/client.ts a src/discord/presence.ts.

state.ts — stavy OFFLINE | IDLE | ACTIVE | BUSY | TOOL, přechody:
  proces neběží                      → OFFLINE
  cpuPercent > threshold             → BUSY   (a pokud je čerstvý recentTool → TOOL)
  mcpActivity == true                → BUSY
  okno v popředí                     → ACTIVE
  jinak                              → IDLE
Hystereze: z BUSY zpět až když cpuPercent klesne pod threshold * 0.6.

client.ts — připojení přes @xhayper/discord-rpc.
  - Když Discord neběží, NEPADEJ. Zkoušej se připojit s exponenciálním backoffem
    (5s → 10s → 30s → max 60s) a mezitím jen sbírej stav.
  - Rate-limit gate: setActivity se nesmí zavolat častěji než presenceMinIntervalMs,
    a když je nový payload identický s posledním odeslaným, neposílej ho vůbec.
  - Při OFFLINE zavolej clearActivity().
  - Na SIGINT/SIGTERM: clearActivity() + destroy() + čistý exit.

presence.ts — mapování stavu na payload:
  details:  BUSY -> "Pracuje…" | TOOL -> "Nástroj: <name>" | ACTIVE -> "Aktivní chat" | IDLE -> "Nečinný"
  state:    rotace po 20 s mezi zapnutými položkami z config.show:
            "Vytížení 5h: 55 %", "Verze 1.46388.4.0", "MCP: 22 serverů"
  startTimestamp: startTime procesu, jen když show.elapsedTime
  largeImageKey "claude_logo", largeImageText "Claude Desktop <verze>"
  smallImageKey: "busy" pro BUSY/TOOL, jinak "idle"

Ošetři limity Discordu: details i state max 128 znaků, ořezávej.
```

---

### P7 — spuštění, autostart, distribuce

```
1) Dokonči src/index.ts: načti config, spusť smyčku s pollIntervalMs, ošetři
   neodchycené výjimky tak, aby daemon nespadl (zaloguj a pokračuj).
   Přidej přepínač --debug pro výpis stavu do konzole každý tick.

2) src/log.ts: rotující log daemona do %LOCALAPPDATA%\claude-desktop-presence\daemon.log,
   max 5 MB, 2 soubory. Nikdy do něj nepiš obsah log řádků Claude Desktopu, jen
   extrahované hodnoty.

3) scripts/install-autostart.ps1: zaregistruje Scheduled Task při přihlášení uživatele,
   běh na pozadí bez okna, s parametrem pro odinstalaci (-Uninstall).
   NEPOUŽÍVEJ startup složku — chceme běh bez blikajícího okna.

4) tsup + @yao-pkg/pkg → jeden claude-desktop-presence.exe pro win-x64.
   GitHub Actions workflow: na tag v* zbuildit a přiložit exe + config.example.json
   k releasu.

5) README.md — česky i anglicky, musí obsahovat:
   - postup vytvoření Discord aplikace a nahrání assetů (claude_logo, busy, idle)
   - upozornění, že BUSY detekce je CPU heuristika, tzn. scrollování nebo video
     v chatu ji můžou spustit falešně
   - upozornění, že se to opírá o nedokumentované cesty a formáty logů Anthropicu
     a update Claude Desktopu to může rozbít (přesně to se stalo 21. 8. 2026, kdy
     se log adresář přesunul z Roaming do Local)
   - sekci Privacy: co všechno nástroj NEČTE
   - tabulku ověřených signálů z §0 téhle specifikace
```

---

## 7. Rizika, se kterými počítej

1. **Nedokumentované rozhraní.** Cesty i formáty logů si Anthropic může kdykoli změnit — v srpnu 2026 se to už jednou stalo. Proto: adresář se detekuje za běhu, každý extraktor umí selhat a vrátit `null`, a daemon musí fungovat i když všechny log extraktory selžou (spadne na "běží / neběží" + čas).
2. **CPU heuristika je odhad**, ne skutečný stav Clauda. Do README, ne do marketingu.
3. **`pkg` a nativní moduly.** Proto `koffi` místo `ffi-napi` a proto žádný `node-gyp`.
4. **Antivirus.** Nepodepsaný `.exe` na GitHubu bude Defender někdy hlásit. Počítej s tím, případně nabídni i variantu "spusť přes `npx`".
5. **Discord rate limit.** Nejčastější chyba v podobných projektech — presence se aktualizuje moc často, Discord updaty zahodí a vypadá to jako zamrznutí.

---

## 8. Až tohle poběží — jednodušší varianta

Slíbil jsem i minimální verzi. Jakmile bude P0–P2 hotové, dá se z toho vyříznout
~60řádkový skript: „běží claude.exe → pošli presence 'Claude' s elapsed časem, jinak
clearActivity". Žádné logy, žádné CPU. Ta se nikdy nerozbije updatem a je dobrá jako
fallback do README pro lidi, co nechtějí nic dalšího řešit.
