# claude-desktop-presence — spec + prompty pro Claude Code

Discord Rich Presence pro **Claude Desktop na Windows**. Standalone daemon, žádný zásah do Claude Desktopu, žádný developer mód.

---

## 0. Ověřená fakta (průzkum 6. 9. 2026, Claude Desktop `1.46388.4.0`, Windows MSIX)

Tohle není odhad — bylo změřeno na reálné instalaci. Zbytek specifikace na tom stojí.

| Signál                     | Stav              | Detail                                                                                                                                                                                                                           |
| -------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proces aplikace            | ✅ spolehlivé     | `claude.exe` (Electron). **Počet instancí není konstantní — naměřeno 12, 16 i 17**, nikde ho nehardcodovat. Hlavní okno = ten proces, který má neprázdný `MainWindowTitle` (hodnota `"Claude"`).                                 |
| `wmic`                     | ❌ **neexistuje** | Microsoft ho z Windows 11 odstranil. **Důsledek: `pidusage` na tomhle stroji nefunguje**, protože po něm na Windows sahá. CPU se čte z PowerShellu (viz §3).                                                                     |
| Discord IPC                | ✅ dostupné       | Pipe `\\.\pipe\discord-ipc-0` existuje, když běží Discord.                                                                                                                                                                       |
| **Aktivní log adresář**    | ⚠️ **přesunut**   | Živý: `%LOCALAPPDATA%\Claude\Logs`. Zastaralý: `%APPDATA%\Claude\logs` (poslední zápis 21. 8. 2026, kdy proběhl update). **Nutno detekovat za běhu.**                                                                            |
| Verze aplikace             | ✅                | Vyparsovatelná ze stack trace v `main.log`: `Claude_1.46388.4.0_x64__pzs8sxrjxfjjc`.                                                                                                                                             |
| Vytížení plánu             | ✅ živé           | `%APPDATA%\Claude\plan-usage-history.json` → `{"version":2,"samples":[{"t":<epoch_ms>,"org":"<uuid>","u":{"fh":55,"sd":22}}]}`. `fh`/`sd` = procenta ve dvou oknech (pravděpodobně 5hodinové a 7denní — ověřit porovnáním s UI). |
| Heartbeat běhu             | ✅                | `main.log`, řádek `[process-memory] trigger=interval tree_rss_sum=...MB electron(10)=...MB` každých ~30–60 s.                                                                                                                    |
| Jméno nástroje             | ⚠️ jen občas      | `main.log`: `Received permission response for <uuid>: once (tool: <toolName>)`. **Objeví se jen když uživatel odklikne povolení**, ne při každém volání.                                                                         |
| Aktivita MCP serverů       | ✅ nepřímo        | `%LOCALAPPDATA%\Claude\Logs\mcp-server-<Name>.log` — mtime se hýbe, když server něco dělá.                                                                                                                                       |
| **Živé "Claude přemýšlí"** | ❌ **není**       | `mcp.log` obsahuje `method="tools/list"`, `"prompts/list"`, `"resources/list"` — ale **žádné `tools/call`**. Volání nástrojů se v této verzi nelogují. Nelze z logů spolehlivě zjistit, co Claude právě dělá.                    |

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
2. Spočítat delta CPU-ms za interval **jen z PIDů přítomných v obou po sobě jdoucích vzorcích** (`CpuMs` je kumulativní od startu procesu, zmizelý renderer by jinak vyrobil zápornou deltu) a vydělit `Δ wall-clock ms`. **Nedělit počtem jader** — viz níž.
3. Klouzavý průměr přes posledních 5 vzorků, aby to neblikalo.
4. Práh se **nezadává číslem, ale kalibruje se za běhu** — viz níž.
5. Hystereze: do `BUSY` se přechází nad prahem, zpět až pod `práh × exitFactor` (default 0.6) — jinak to bude oscilovat.

#### Jednotka je „procenta jednoho jádra", ne procenta stroje

Naměřeno na cílovém stroji (12 jader, 4s vzorek) během reálné práce Clauda:

| Jednotka                         | Hodnota             |
| -------------------------------- | ------------------- |
| normalizováno na všechna jádra   | **0.32 %**          |
| procenta jednoho jádra           | **3.9 %**           |
| nejvytíženější jednotlivý proces | 2.3 % jednoho jádra |

Původní práh `busyCpuThresholdPercent = 12` byl tedy vedle zhruba **40×** a nenastal by nikdy.
Electron pracuje převážně jednovláknově, takže dělení počtem jader signál rozmělní v šumu.
Hodnota v této jednotce **může přesáhnout 100 %**, když pracuje víc procesů najednou.

> **Ta hodnota byla dolní hranice.** Měřilo se během agentní session, která je převážně
> čekání na síť. Streamování odpovědi je vyšší — a teď už je i změřené, viz níž.

#### Měření streamování odpovědi (6. 9. 2026, 12 jader)

První skutečné měření generování, ne agentní session. Procenta jednoho jádra:

<!-- generated:calibration-table -->

| Fáze  | vzorků | min      | medián   | p90   | max      |
| ----- | ------ | -------- | -------- | ----- | -------- |
| klid  | 14     | 0,98     | **1,75** | 2,69  | **3,02** |
| práce | 27     | **5,39** | **9,57** | 12,25 | 13,96    |

<!-- /generated:calibration-table -->

<!-- generated:calibration-provenance -->

_Naměřeno 2026-09-06 na cílovém stroji (12 jader), Claude Desktop 1.46388.4.0, při streamování dlouhé odpovědi. Vygenerováno z `src/measurement.ts` přes `npm run docs:sync` — needituj ručně._

<!-- /generated:calibration-provenance -->

Co z toho udělá `analyse`:

<!-- generated:calibration-derived -->

- **podlaha 1,07 %** — p5 fáze 1, na tuhle hodnotu se za běhu ustálí klouzavá základna
- **horní okraj klidu 2,82 %** (p95 fáze 1) · **dolní okraj práce 6,38 %** (p5 fáze 2) → odstup 3,56 bodu, rozdělení se nepřekrývají
- **BUSY nad 4,60 %** — přesně uprostřed mezi těmi dvěma okraji
- **zpátky do klidu na 3,22 %** — nad klidovým maximem 3,02 %, takže běžný výkyv daemona nenechá zaseknutého v BUSY
- do configu: multiplier 2,5 · delta 3,5 · exitFactor 0,7

> Naměřený je ten souhrn (min, medián, p90, max a podlaha p5). Jednotlivé vzorky se neuchovaly, takže percentily separace — p95 klidu a p5 práce — pocházejí z rekonstrukce se stejným tvarem a jsou orientační, ne naměřené.

<!-- /generated:calibration-derived -->

**Mezi klidem a prací není žádný překryv** — nejnižší vzorek při práci je nad nejvyšším
vzorkem v klidu. To je nejlepší možný výsledek: heuristika má na téhle třídě zátěže čistý
odstup. Zaručený není, takže to kalibrátor nově kontroluje sám a varuje, když p95 fáze 1
dosáhne na p5 fáze 2 (viz `overlapping`).

Věci, které z těch čísel plynou a promítly se do kalibrátoru:

1. **Klidová podlaha je tady výrazně nad 0,32 % z agentní session.** Klid není konstanta
   stroje, závisí na tom, co má Claude otevřené.
2. **Násobek se nesmí odvozovat jako `práh ÷ podlaha`.** Na těchhle datech to dá zhruba 4
   — a jakmile podlaha za běhu vystoupá nad zhruba polovinu toho, `podlaha × násobek`
   přeskočí medián skutečné práce a `BUSY` přestane nastávat úplně. Delta je primární
   pravidlo, násobek jen pojistka pro stroje s vyšší podlahou; drží se konzervativně na
   `CONSERVATIVE_MULTIPLIER` a shazuje se, kdyby `podlaha × násobek` přesáhlo polovinu
   mediánu práce.
3. **`exitFactor` se musí odvodit z dat, ne být konstanta 0,6.** Výstupní práh musí ležet
   NAD maximem klidu, jinak ho běžný klidový výkyv udrží v `BUSY`. Na těchhle datech
   pevných 0,6 skončí pod šumem, který má ignorovat; odvozená hodnota klidové maximum
   překročí. Obojí je v seznamu výš.
4. **Práh leží přesně uprostřed mezi okraji obou rozdělení** — p95 fáze 1 a p5 fáze 2 —
   ne v nějakém zvoleném zlomku cesty k mediánu práce. Staré pravidlo znělo
   `podlaha + 0,4 × (medián − podlaha)` a ta 0,4 se nebrala odnikud: někdo ji zvolil a
   delta i exitFactor se pak odvozovaly z toho, co vyšlo. Okraje jsou to, mezi čím práh
   ve skutečnosti musí ležet, a teprve díky nim jde vůbec kontrolovat překryv. Na těchhle
   datech obě pravidla vyjdou na pár desetin stejně.

#### Samokalibrace místo fixního prahu

Žádná konstanta nesedne na každý stroj, takže si daemon drží vlastní práh:

- **základna** = 5. percentil `cpuPercent` za posledních **30–60 minut** (klouzavé okno,
  default 30 min, v configu jako `baselineWindowSec`)
- **do základny se počítá KAŽDÝ vzorek**, bez ohledu na stav. Tu práci odvádí délka okna,
  ne filtrování:
  - dlouhý burst okno nepřeválcuje — při 10minutové souvislé práci v něm pořád zbývá
    20 minut klidných vzorků a p5 padne do nich
  - stroj s trvale vysokým klidovým CPU se usadí na té skutečné podlaze, protože se ty
    vzorky počítají jako každé jiné
- **p5, ne minimum** — jeden anomální vzorek nesmí podlahu strhnout dolů a udělat ze všeho
  nad ním „práci"
- ~~gating na `BUSY`~~ (učit se jen z ne-BUSY vzorků) se **neosvědčil**: na stroji s vysokou
  skutečnou podlahou vede k deadlocku — první vzorek se označí za `BUSY`, učení se nikdy
  nerozjede a daemon hlásí „pracuje" navždy. Časovaná pojistka to jen odloží. Dlouhé okno
  řeší obojí bez extra mechanismu.
- **práh** = `max(základna × thresholdMultiplier, základna + thresholdDeltaPercent)`
  — `max`, ne `min`: delta je absolutní minimum skoku, jinak by u základny blízko nule
  stačil k překročení násobku každý záškub
- dokud se nenasbírá aspoň 10 vzorků, počítá se základna jako 0 → práh je čistá delta.
  Bez toho by daemon spuštěný uprostřed práce zkalibroval základnu na tu práci.
- **známé omezení:** burst delší než celé okno drift stejně způsobí. Po 30 minutách souvislé
  práce v okně nic jiného není a stav spadne do `IDLE`. Odlišit to od trvale vysoké podlahy
  nejde, aniž by se počkalo, až to skončí.
- parametry jsou v configu v sekci `busy` (§4), zjistí je `--calibrate`

#### `--calibrate` je dvoufázový

Jedna neřízená minuta nedokáže odlišit klid od práce. Při prvním jednofázovém běhu vyšla
„klidová podlaha" 1,69 % jenom proto, že Claude během té minuty nikdy neztichl.

```
fáze 1 (30 s): "Nech Clauda v klidu, nepiš mu."                        -> podlaha
fáze 2 (60 s): "Pošli mu dlouhý dotaz a nech ho vygenerovat celou odpověď." -> strop

podlaha     = p5 fáze 1     (stejný percentil, jaký používá daemon za běhu)
okraj klidu = p95 fáze 1    (horní okraj klidu)
okraj práce = p5 fáze 2     (dolní okraj práce)
práh        = (okraj klidu + okraj práce) / 2
```

Práh leží přesně uprostřed mezi těmi dvěma okraji, ne v nějakém zvoleném zlomku cesty k
mediánu práce. Okraje jsou to, mezi čím musí ve skutečnosti ležet; percentily místo
krajních hodnot, aby s ním nehnul jeden odchýlený vzorek.

Hlásí se dvě selhání a nejsou to tatáž věc:

- **neplatné** — **medián fáze 2 < 1,5 × podlaha**: vypíše se, že se fáze 2 nejspíš
  nepovedla. Stejně tak, když je medián fáze 2 prakticky nulový — u podlahy blízko nule
  je poměrové pravidlo splněné triviálně a „nezměřil jsem nic" by prošlo jako platná
  kalibrace.
- **překryv** — **okraj klidu dosáhne na okraj práce**: fáze 2 proběhla, dostala se jasně
  nad podlahu, a klid od ní stejně nejde odlišit. Na takovém stroji ta dvě rozdělení
  neoddělí žádný práh. Výsledek zůstává platný a návrh se dál vypisuje — je to nejlepší
  dostupný odhad — jen s varováním, které to říká naplno. Bez toho vypadá report úplně
  zdravě, zatímco daemon poskakuje.

Je to první krok po instalaci — viz README.

**Vzorkování je adaptivní, ne fixní na 2 s:** `BUSY`/`TOOL`/`ACTIVE` → 2 s, `IDLE` → 10 s, `OFFLINE` → 30 s. Spawn PowerShellu každé 2 s je ~1800 procesů za hodinu a daemon by sám žral CPU, které má měřit; Discord navíc nedovolí update presence častěji než 15 s. `pollIntervalMs` z configu je **spodní hranice**, ne fixní perioda.

**Známý falešný pozitiv:** scrollování, přehrávání videa a načítání velkého chatu taky žerou CPU. Zdokumentovat v README, neschovávat.

#### `mcpActivity` má přednost před CPU

Pohyb v `mcp-server-*.log` je u agentní práce **přímější důkaz aktivity než odhad z procesoru**,
takže se vyhodnocuje dřív a `BUSY` drží i tehdy, když CPU spadlo pod výstupní práh. Bez toho by
dlouhé volání nástroje (čekání na síť, nulové CPU) probliklo zpátky do `IDLE`.

### Mapování na Discord presence

| Pole                 | Obsah                                                                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `details` (1. řádek) | `Claude Desktop — <stav>`, kde stav je `Pracuje…` / `Aktivní chat` / `Nečinný` / `Nástroj: <name>`. Prefix "Claude Desktop" tu je schválně: hlavička presence ukazuje název aplikace (`C.L.A.U.D.E`), takže skutečné jméno musí nést tenhle řádek.               |
| `state` (2. řádek)   | Rotuje po 20 s mezi: `Vytížení 5h: 55 %`, `Verze 1.46388.4.0`, `MCP: 22 serverů` (jen ty položky, které jsou v configu zapnuté)                                                                                                                                  |
| `startTimestamp`     | **Nejstarší** `StartTime` ze všech `claude.exe` procesů, **zamrzlý až do přechodu do `OFFLINE`** → Discord ukáže "elapsed". Nesmí se brát start procesu s hlavním oknem: restart rendereru změní jeho PID, timestamp by poskočil a Discord by odpočet resetoval. |
| `largeImageKey`      | `claude_logo`                                                                                                                                                                                                                                                    |
| `largeImageText`     | `Claude Desktop 1.46388.4.0`                                                                                                                                                                                                                                     |
| `smallImageKey`      | `busy` / `idle`                                                                                                                                                                                                                                                  |
| `buttons`            | Volitelně odkaz na repo. **Pozn.: vlastní tlačítka nevidíš na svém profilu, jen ostatní.**                                                                                                                                                                       |

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
  "busy": {
    "baselineWindowSec": 1800,
    "baselinePercentile": 5,
    "thresholdMultiplier": 3,
    "thresholdDeltaPercent": 1.5,
    "exitFactor": 0.6
  },
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
    "planUsageShortWindow": "Vytížení 5h: {percent} %",
    "planUsageLongWindow": "Vytížení 7d: {percent} %",
    "appVersion": "Verze {version}",
    "mcpServerCount": "MCP: {count} serverů",
    "largeImageText": "{app} {version}"
  },
  "buttons": [],
  "logDirOverride": null,
  "debug": false
}
```

Poznámky ke schématu:

- `pollIntervalMs` je **spodní hranice** vzorkování, ne fixní perioda — viz adaptivní interval v §3.
- Sekce `busy` nahradila zrušené pole `busyCpuThresholdPercent`. Hodnoty se nehádají ručně —
  vyrobí je `--calibrate`. Jednotka `thresholdDeltaPercent` jsou **procenta jednoho jádra**.
- Celá sekce `text` je volitelná; chybějící klíče se doplní českými defaulty výše.
- Neznámý klíč není fatální, jen se ohlásí varováním s návrhem („did you mean…"), aby překlep
  v configu nezůstal tiše ignorovaný a zároveň starší daemon nespadl na novějším configu.
- `buttons` je pole nejvýš dvou `{ label, url }`. **Vlastní tlačítka autor na svém profilu
  nevidí, jen ostatní** — než to prohlásíš za rozbité, nech se na profil podívat někoho jiného.

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
  busy: { baselineWindowSec (default 1800, min 600 — kratší okno dlouhý burst nepřežije),
          baselinePercentile (default 5, 1-50), thresholdMultiplier (default 3, min 1),
          thresholdDeltaPercent (default 1.5, procenta JEDNOHO jádra),
          exitFactor (default 0.6, 0.1-1) }
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
- cpuPercent = Δ CpuMs / Δ wall-clock ms × 100. JEDNOTKA JE "PROCENTA JEDNOHO JÁDRA",
  počtem jader se NEDĚLÍ (viz §3) a hodnota může přesáhnout 100.
  [Environment]::ProcessorCount stejně zjisti jednou při startu (na cílovém stroji 12),
  ale jen kvůli výstupu --calibrate.
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

- `t` = epoch ms, `u.fh` a `u.sd` = procenta ve dvou různých oknech.
- Ber jen POSLEDNÍ sample podle `t`.
- `org` UUID nikdy nikam neposílej — je to identifikátor organizace. NESMÍ opustit modul,
  ani do daemon logu. Nejlevnější záruka je prostě ho nikdy nepřečíst.
- **Nečti to každý tik.** Soubor se aktualizuje řádově po minutách → interval 60 s
  s cachovanou hodnotou mezitím.
- **Soubor roste.** Ověřeno 51,5 kB, ale přibývá vzorek každých pár minut. Když přesáhne
  5 MB, čti jen koncový blok a najdi v něm poslední KOMPLETNÍ objekt vzorku, místo
  parsování celého souboru.
- **Zápis nemusí být atomický** → parse do try/catch a při chybě vrať poslední známou
  hodnotu, ne null. Rozliš "soubor neexistuje" (→ null) od "zrovna se zapisuje"
  (→ poslední známá).
- **Význam `fh`/`sd` je odvození, ne dokumentované API.** V KÓDU a v KLÍČÍCH configu je
  pojmenuj neutrálně (`shortWindowPercent` / `longWindowPercent`, `planUsageShortWindow` /
  `planUsageLongWindow`), aby kód přežil změnu formátu. Výchozí TEXTY můžou být čitelné
  ("Vytížení 5h", "Vytížení 7d"). Do README napiš, odkud to odvození je.

Signatura:
  export interface PlanUsage { shortWindowPercent: number; longWindowPercent: number; at: Date }
  export async function readPlanUsage(): Promise<PlanUsage | null>
```

---

### P6 — stavový automat a Discord

```
Implementuj src/state.ts, src/discord/client.ts a src/discord/presence.ts.

state.ts — stavy OFFLINE | IDLE | ACTIVE | BUSY | TOOL, přechody v TOMTO pořadí:
  proces neběží                      → OFFLINE
  mcpActivity == true                → BUSY   (a pokud je čerstvý recentTool → TOOL)
  cpuPercent > threshold             → BUSY   (a pokud je čerstvý recentTool → TOOL)
  okno v popředí                     → ACTIVE
  jinak                              → IDLE
mcpActivity je schválně PŘED CPU a drží BUSY i pod výstupním prahem — viz §3.
threshold není konstanta, ale samokalibrace ze sekce busy v configu (§3).
Hystereze: z BUSY zpět až když cpuPercent klesne pod threshold * exitFactor.

client.ts — připojení přes @xhayper/discord-rpc.
  - Když Discord neběží, NEPADEJ. Zkoušej se připojit s exponenciálním backoffem
    (5s → 10s → 30s → max 60s) a mezitím jen sbírej stav.
  - Rate-limit gate: setActivity se nesmí zavolat častěji než presenceMinIntervalMs,
    a když je nový payload identický s posledním odeslaným, neposílej ho vůbec.
  - Při OFFLINE zavolej clearActivity().
  - Na SIGINT/SIGTERM: clearActivity() + destroy() + čistý exit.

presence.ts — mapování stavu na payload:
  details:  texty ber z config.text (statusBusy / statusTool / statusActive / statusIdle),
            složené do config.text.detailsFormat — nehardcoduj je
  state:    rotace po 20 s mezi zapnutými položkami z config.show:
            "Vytížení 5h: 55 %", "Verze 1.46388.4.0", "MCP: 22 serverů"
  startTimestamp: startTime procesu, jen když show.elapsedTime
  largeImageKey "claude_logo", largeImageText "Claude Desktop <verze>"
  smallImageKey: "busy" pro BUSY/TOOL, jinak "idle"

Ošetři limity Discordu: details i state max 128 znaků, ořezávej S VÝPUSTKOU, ne tvrdě —
texty jdou z configu, takže je uživatel může mít libovolně dlouhé.

Assety musí sedět s tím, co je nahrané v Developer Portalu: largeImageKey "claude_logo",
smallImageKey "busy" / "idle". Nenahraný klíč se vykreslí jako nic, bez chyby.

Přepínače, které k tomu patří:
- --no-discord: všechno běží, payload se vypíše na konzoli, nic se neodesílá. Ušetří to
  spoustu restartů Discordu při ladění.
- --debug: každý tik vypiš stav, cpuPercent, cpuBaseline, cpuThreshold, reason a payload.
  Ta pole už ve StateResult jsou.

Discord nemusí běžet, a když běží, uživatel nemusí být přihlášený. Ani jedno není chyba,
se kterou daemon něco zmůže — obojí řeš backoffem a mezitím dál sbírej stav. Otestuj obojí.
```

---

### P7 — spuštění, autostart, distribuce

```
1) Dokonči src/index.ts: načti config, spusť smyčku s adaptivním intervalem, ošetři
   neodchycené výjimky tak, aby daemon nespadl (zaloguj a pokračuj).
   Přidej přepínač --debug pro výpis stavu do konzole každý tick.

   WARMUP: dokud není základna (< 10 vzorků), NEPUBLIKUJ presence odvozenou z CPU —
   nepublikuj vůbec nic místo hádání. Na vývojovém stroji sedí nečinný Claude na
   1,75 % jednoho jádra, což je nad výchozí deltou; bez tohohle by daemon hlásil
   "pracuje" při každém jediném startu. Signály, které základnu nepotřebují
   (OFFLINE, mcpActivity, focus), publikuj normálně. V --debug ať je warmup vidět.

2) src/log.ts: rotující log daemona do %LOCALAPPDATA%\claude-desktop-presence\daemon.log,
   max 5 MB, 2 soubory. Nikdy do něj nepiš obsah log řádků Claude Desktopu, jen
   extrahované hodnoty a errno kódy.

   Vyřeš pořadí při startu: config se čte dřív, než logger existuje. Použij bootstrap
   buffer a přehraj LoadResult.warnings, jakmile logger vznikne — v produkci není
   konzole, kam by spadly.

3) scripts/install-autostart.ps1: zaregistruje Scheduled Task při přihlášení uživatele,
   běh na pozadí bez okna, s parametrem pro odinstalaci (-Uninstall).
   NEPOUŽÍVEJ startup složku — chceme běh bez blikajícího okna.

   Tři věci, na kterých to jinak tiše selže:
   - Úloha MUSÍ běžet v uživatelské session (LogonType Interactive). Discord IPC pipe
     je per-session; úloha jako SYSTEM nebo v session 0 ji neuvidí.
   - ExecutionTimeLimit na PT0S (bez limitu). Výchozí 3 dny by daemona zabily.
   - Pracovní adresář explicitně na adresář binárky — u Scheduled Tasku je to jinak
     C:\Windows\System32, tedy přesně ta past z P1.

4) tsup + @yao-pkg/pkg → jeden claude-desktop-presence.exe pro win-x64 z CJS buildu.
   OVĚŘ, že zabalený .exe skutečně BĚŽÍ — ne jen že se build povedl. Konkrétně: načte
   se koffi, funguje PowerShell fallback, resolveBaseDir najde config vedle .exe.

   POZOR (ověřeno): koffi se přes `await import()` v zabaleném .exe NENAČTE
   ("A dynamic import callback was not specified") a tiše spadne na pomalý fallback.
   Použij createRequire + tsup shims.
   POZOR 2: pkg-fetch nemá pro tag v3.6 předkompilovanou binárku node20-win-x64
   (404) a pokusí se kompilovat Node ze zdrojáků. Použij node22-win-x64.

   GitHub Actions workflow: na tag v* zbuildit a přiložit exe + config.example.json
   k releasu. Node verzi pinni. `npm ci` musí pustit install skripty (esbuild má
   postinstall, bez něj build spadne na chybějící binárce) — ověř to v CI explicitně.

5) README.md + README.cs.md — anglicky a česky, obojí musí obsahovat:
   - kalibraci jako první krok po instalaci
   - postup vytvoření Discord aplikace a nahrání assetů (claude_logo, busy, idle),
     včetně toho, že Discord blokuje název "Claude" i varianty
   - oddíl Ověření: jak poznat, že presence naskočila; vlastní buttons autor na svém
     profilu nevidí, jen ostatní
   - upozornění, že BUSY detekce je CPU heuristika, tzn. scrollování nebo video
     v chatu ji můžou spustit falešně; drift při práci delší než okno podlahy; warmup
   - upozornění, že se to opírá o nedokumentované cesty a formáty logů Anthropicu
     a update Claude Desktopu to může rozbít (přesně to se stalo 21. 8. 2026, kdy
     se log adresář přesunul z Roaming do Local)
   - sekci Privacy: co všechno nástroj NEČTE
   - tabulku ověřených signálů z §0 téhle specifikace
   - poznámku, že nepodepsaný .exe může Defender označit, a jak to spustit ze zdrojáků

6) scripts/minimal.mjs — vyříznutá minimální varianta z §8 jako fallback.
```

---

## 7. Rizika, se kterými počítej

1. **Nedokumentované rozhraní.** Cesty i formáty logů si Anthropic může kdykoli změnit — v srpnu 2026 se to už jednou stalo. Proto: adresář se detekuje za běhu, každý extraktor umí selhat a vrátit `null`, a daemon musí fungovat i když všechny log extraktory selžou (spadne na "běží / neběží" + čas).
2. **CPU heuristika je odhad**, ne skutečný stav Clauda. Do README, ne do marketingu.
3. **`pkg` a nativní moduly.** Proto `koffi` místo `ffi-napi` a proto žádný `node-gyp`.
4. **Antivirus.** Nepodepsaný `.exe` na GitHubu bude Defender někdy hlásit. Počítej s tím, případně nabídni i variantu "spusť přes `npx`".
5. **Discord rate limit.** Nejčastější chyba v podobných projektech — presence se aktualizuje moc často, Discord updaty zahodí a vypadá to jako zamrznutí.

---

## 8. Minimální varianta — HOTOVO

Vyříznuté jako `scripts/minimal.mjs`: „běží claude.exe → pošli presence s elapsed časem,
jinak clearActivity". Žádné logy, žádné CPU, žádná kalibrace, žádný config. Nic v tom
nezávisí na nedokumentované cestě ani formátu logu, takže to update rozbít nemůže.
V README jako fallback pro lidi, co nechtějí kalibrovat, a jako pojistka, kdyby update
Claude Desktopu rozbil zbytek.

    node scripts/minimal.mjs <discord-application-id>
