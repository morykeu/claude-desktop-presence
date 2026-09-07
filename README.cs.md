# claude-desktop-presence

Discord Rich Presence pro **Claude Desktop na Windows**. Samostatný daemon — nesahá do
Claude Desktopu a nepotřebuje developer mód.

🇬🇧 [English version](README.md)

> **Tohle je neoficiální nástroj třetí strany.** Nedělá ho Anthropic, není s ním nijak
> spojený, neschválil ho a nepodporuje. Funguje tak, že čte cesty, logy a chování procesů,
> které Anthropic nedokumentuje a nikdy neslíbil, že je nechá být — **jakýkoli update
> Claude Desktopu ho může bez varování rozbít.** Není to hypotéza: 21. 8. 2026 přesunul
> update adresář s logy z Roaming do Local a nástroj s natvrdo zadanou cestou by tiše
> přestal fungovat. Všechno je tu psané tak, aby to spíš degradovalo než spadlo, a existuje
> [minimální varianta](#minimální-varianta), která nezávisí na ničem z toho — ale instaluj
> si to s tím, že to jednou budeš muset spravit.
>
> „Claude" a „Claude Desktop" jsou ochranné známky Anthropicu, použité tady jen k tomu,
> aby bylo řečeno, co ten nástroj sleduje.

---

## Instalace

Stáhni `claude-desktop-presence.exe`, `claude-desktop-presence-bg.exe` a
`config.example.json` z [posledního release](../../releases/latest) a dej je do stejné
složky.

**Dvě binárky, stejný program.** pkg umí vyrobit jen konzolovou aplikaci, takže Scheduled
Task spouštějící konzolovou variantu vyhodí při každém přihlášení okno cmd. Varianta
`-bg` je bajt po bajtu stejná kopie s PE subsystémem přepnutým z CONSOLE na WINDOWS,
takže ji Windows spustí bez konzole úplně.

| Binárka                          | K čemu                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `claude-desktop-presence.exe`    | `--calibrate`, `--debug`, ruční spuštění — všude, kde chceš vidět výstup            |
| `claude-desktop-presence-bg.exe` | autostart. Žádné okno, ale ani žádný výstup na konzoli: všechno jde do `daemon.log` |

Kalibruj konzolovou, na autostart registruj `-bg`.

`.exe` **není podepsané**, takže tě SmartScreen napoprvé nejspíš zastaví („Systém Windows
ochránil váš počítač" → Další informace → Přesto spustit) a Defender ho může dát do
karantény. Přesně tak vypadá nepodepsaná binárka z internetu; certifikát stojí peníze a
tohle je hobby daemon. Když se ti přes to klikat nechce, spusť to ze zdrojáků:

```bash
git clone <tenhle repozitář>
cd claude-desktop-presence
npm install
npm run build
node dist/index.js
```

Všechno níž platí stejně — jen místo `claude-desktop-presence.exe` piš `node dist/index.js`.

---

## 1. Vytvoř Discord aplikaci

Tohle nemůže udělat kód, potřebuje to tvůj účet.

1. [discord.com/developers/applications](https://discord.com/developers/applications) →
   **New Application**.

   > ⚠️ **Discord nedovolí název „Claude".** Odmítne ho rovnou, a stejně tak
   > `Claude Desktop`, `Claude AI`, `Claude.ai` i `claude` — filtr matchuje podřetězec a
   > chrání ochrannou známku. Ověřeno 6. 9. 2026.
   >
   > Použij **`C.L.A.U.D.E`**. Projde a je to čitelné. Kdyby se filtr změnil, fungují i
   > `Claudius`, `Desktop Presence` nebo `CDRP`.
   >
   > **Neobcházej filtr** neviditelnými znaky. Discord za to aplikace maže a ten problém
   > by zdědil každý, kdo si nástroj nainstaloval.

2. Zkopíruj **Application ID** (dlouhé číslo). To půjde do `config.json`.

3. **Rich Presence → Art Assets**, nahraj tři obrázky (min. 512×512 PNG) přesně pod
   těmito klíči:

   | Klíč          | K čemu                          |
   | ------------- | ------------------------------- |
   | `claude_logo` | velká ikona                     |
   | `busy`        | malá ikona, když Claude pracuje |
   | `idle`        | malá ikona, když ne             |

   Názvy musí sedět přesně. Nenahraný klíč se vykreslí jako nic, bez jakékoli chybové
   hlášky.

4. V samotném Discordu: **Nastavení → Soukromí aktivity → „Zobrazovat aktuální aktivitu
   jako stav"** musí být zapnuté.

Application ID je veřejná hodnota, není to tajemství.

---

## 2. Kalibrace

**Tohle udělej jako první.** Daemon pozná „Claude pracuje" z vytížení procesoru a
neexistuje práh, který by seděl na každý stroj. Naměřeno na vývojovém stroji, když Claude
streamoval dlouhou odpověď:

<!-- generated:calibration-table -->

| Fáze  | vzorků | min      | medián   | p90   | max      |
| ----- | ------ | -------- | -------- | ----- | -------- |
| klid  | 14     | 0,98     | **1,75** | 2,69  | **3,02** |
| práce | 27     | **5,39** | **9,57** | 12,25 | 13,96    |

<!-- /generated:calibration-table -->

<!-- generated:calibration-provenance -->

_Naměřeno 2026-09-06 na cílovém stroji (12 jader), Claude Desktop 1.46388.4.0, při streamování dlouhé odpovědi. Vygenerováno z `src/measurement.ts` přes `npm run docs:sync` — needituj ručně._

<!-- /generated:calibration-provenance -->

Všechno v procentech **jednoho jádra**. Nejnižší vzorek při práci je nad nejvyšším v
klidu — žádný překryv, což je pro takovouhle heuristiku nejlepší možný případ. A zároveň
je to důvod, proč se práh musí změřit a ne uhodnout: původní ručně zvolených 12 %
překročí i tady jen pár nejvyšších pracovních vzorků a proti agentní session, která se
měřila jako první — 3,9 % jednoho jádra — by nenastal ani jednou.

```bash
claude-desktop-presence --calibrate
```

Dvě fáze, dohromady zhruba 90 sekund, a u každé ti řekne, co máš dělat:

| Fáze | Délka | Co děláš ty                                                    | Co se měří       |
| ---- | ----- | -------------------------------------------------------------- | ---------------- |
| 1    | 30 s  | **Nech Clauda v klidu.** Nepiš mu nic.                         | klidová podlaha  |
| 2    | 60 s  | **Pošli mu dlouhý dotaz** a nech ho vygenerovat celou odpověď. | úroveň při práci |

Dvě fáze místo jedné neřízené minuty, protože jedna minuta klid od práce nerozezná. První
verze tohohle nástroje vzorkovala jednu minutu a vyšla jí „klidová podlaha" 1,69 % —
jenom proto, že Claude během ní nikdy neztichl.

Na konci dostaneš rozdělení obou fází a hotový blok do `config.json`. Tohle je ten běh,
ze kterého je tabulka výš, tak jak ho vypsal sám kalibrátor (výstup je anglicky):

<!-- generated:calibration-report -->

```
Calibration result
==================

Machine: 12 cores (context only; not part of the formula)
CPU used by claude.exe, in percent of ONE core:

Phase 1 — idle (14 samples)
  min 0.98 %   median 1.75 %   p90 2.69 %   max 3.02 %
Phase 2 — working (27 samples)
  min 5.39 %   median 9.57 %   p90 12.25 %   max 13.96 %

  idle floor   1.07 %  (p5 of phase 1)
  idle edge    2.82 %  (p95 of phase 1)
  work edge    6.38 %  (p5 of phase 2)
  BUSY above   4.60 %  (midway between the two edges)
  back to idle 3.22 %  (hysteresis)

Paste into config.json:

  "busy": {
    "baselineWindowSec": 1800,
    "baselinePercentile": 5,
    "thresholdMultiplier": 2.5,
    "thresholdDeltaPercent": 3.5,
    "exitFactor": 0.7
  }
```

<!-- /generated:calibration-report -->

Což vychází takhle:

<!-- generated:calibration-derived -->

- **podlaha 1,07 %** — p5 fáze 1, na tuhle hodnotu se za běhu ustálí klouzavá základna
- **horní okraj klidu 2,82 %** (p95 fáze 1) · **dolní okraj práce 6,38 %** (p5 fáze 2) → odstup 3,56 bodu, rozdělení se nepřekrývají
- **BUSY nad 4,60 %** — přesně uprostřed mezi těmi dvěma okraji
- **zpátky do klidu na 3,22 %** — nad klidovým maximem 3,02 %, takže běžný výkyv daemona nenechá zaseknutého v BUSY
- do configu (přesně takhle, s tečkou): multiplier 2.5 · delta 3.5 · exitFactor 0.7

> Naměřený je ten souhrn (min, medián, p90, max a podlaha p5). Jednotlivé vzorky se neuchovaly, takže percentily separace — p95 klidu a p5 práce — pocházejí z rekonstrukce se stejným tvarem a jsou orientační, ne naměřené.

<!-- /generated:calibration-derived -->

`thresholdDeltaPercent` je skok z podlahy na práh a je to pravidlo, které ve skutečnosti
spíná; `thresholdMultiplier` je pojistka pro stroje s vysokým klidem. `exitFactor` se
odvozuje a nefixuje, protože výstupní hranice musí ležet **nad** klidovým maximem — jinak
daemon zůstane na běžném klidovém výkyvu zaseknutý v BUSY, což by pevných 0,6 tady
udělalo.

Pokazit se to může dvěma způsoby a hlásí se každý zvlášť:

- **`RESULT NOT USABLE`** — fáze 2 se nedostala jasně nad podlahu. Skoro vždycky to
  znamená, že se fáze 2 nekonala. Pošli dotaz dost dlouhý na to, aby Claude na konci fáze
  ještě generoval.
- **`WARNING: idle and working overlap`** — fáze 2 proběhla a stejně ji od klidu nejde
  odlišit: horní okraj klidového rozdělení zasahuje do dolního okraje pracovního. Na
  takovém stroji je ta dvě rozdělení neoddělí žádný práh, takže návrh je nejlepší
  dostupný odhad, ne dobrý odhad. Obvykle něco jiného žere CPU `claude.exe` ve chvíli,
  kdy si myslíš, že je klid.

Kalibraci můžeš přeskočit, defaulty jsou rozumné. Ale pak je detekce práce naladěná na
cizí počítač, ne na tvůj.

### Co ta čísla znamenají

- Jednotka jsou **procenta jednoho jádra**, ne procenta stroje. Electron pracuje
  převážně jednovláknově, takže dělení počtem jader signál pohřbí v šumu. Hodnota může
  přesáhnout 100 %, když pracuje víc procesů najednou.
- Daemon si drží **klouzavou klidovou podlahu** (5. percentil za posledních 30 minut) a
  vyhlásí BUSY, když vytížení stoupne nad ni `thresholdMultiplier`krát, nebo o
  `thresholdDeltaPercent` bodů — podle toho, co je víc. Přizpůsobí se tedy tvému stroji
  místo důvěry v konstantu.
- Do podlahy se počítá **každý** vzorek, bez ohledu na to, jak byl klasifikovaný. To, že
  dlouhý burst okno nepřeválcuje, zařídí délka okna: po deseti minutách souvislé práce v
  něm pořád zbývá dvacet minut klidných vzorků. Filtrování podle stavu naopak vede k
  deadlocku na stroji, jehož skutečné klidové CPU je vysoké — první vzorek vypadá jako
  práce, učení se nikdy nerozjede a stav zamrzne na „pracuje" navždy.

---

## 3. Ověření, že to funguje

### Nasucho, bez Discordu

```bash
claude-desktop-presence --no-discord --debug
```

Nikam se nic neposílá. Dostaneš jeden řádek na tik plus payload, který _by_ šel ven.

S nakalibrovaným configem shora:

<!-- generated:calibration-debug -->

```
IDLE    cpu=1.75% baseline=0.00% threshold=3.50% reason=idle details="Claude Desktop — Idle" state="Version 1.46388.4.0"  <- warmup
BUSY    cpu=9.57% baseline=0.00% threshold=3.50% reason=cpu details="Claude Desktop — Working…" state="MCP: 22 servers"  <- warmup, NOT PUBLISHED (warmup)
[no-discord] setActivity {"details":"Claude Desktop — Idle","smallImageKey":"idle",...}
IDLE    cpu=1.75% baseline=1.07% threshold=4.57% reason=idle details="Claude Desktop — Idle" state="Usage 5h: 29 %"
BUSY    cpu=9.57% baseline=1.07% threshold=4.57% reason=cpu details="Claude Desktop — Working…" state="MCP: 22 servers"
[no-discord] setActivity {"details":"Claude Desktop — Working…","smallImageKey":"busy",...}
```

<!-- /generated:calibration-debug -->

Čte se to jako: stav, pak čísla za tím rozhodnutím, pak co by ukázal Discord. `reason`
říká, které pravidlo zabralo — `cpu`, `mcp`, `focus`, `idle` nebo `offline`.

Mezi prvními dvěma řádky a posledními dvěma se práh posune a stojí za to vědět proč.
Dokud se podlaha teprve učí, počítá se základna jako nula, takže prahem je holý
`thresholdDeltaPercent`; jakmile se základna ustálí na naměřené podlaze, je z toho
podlaha + delta.

Všimni si, jak málo je řádků `setActivity` oproti tikům: to je rate limiter. Discord se
aktualizuje nejvýš jednou za 15 sekund a jen když se něco změnilo.

`<- warmup` znamená, že se podlaha teprve učí. Viz [Známá omezení](#známá-omezení).

Tenhle režim je tu proto, abys při ladění nemusel dvacetkrát restartovat Discord.

### Naostro

Spusť Discord, pak daemona. Do zhruba patnácti sekund by měl tvůj profil ukazovat:

- **C.L.A.U.D.E** jako hlavičku — to je název aplikace, protože Discord odmítá cokoli s
  „claude". Přesně proto řádek pod tím říká „Claude Desktop": bez něj by nikdo nepoznal,
  o co jde.
- **první řádek**: `Claude Desktop — Idle` / `Working…` / `Active chat` / `Tool: <jméno>`
  (výchozí texty jsou anglické; česky viz [Konfigurace](#konfigurace))
- **druhý řádek**: střídá se po 20 sekundách mezi vytížením plánu, verzí aplikace a
  počtem MCP serverů — podle toho, co máš zapnuté v `show`
- **velká ikona** `claude_logo`, **malá ikona** `busy` nebo `idle`
- **odpočet** od chvíle, kdy se spustil Claude Desktop

Chybí ikony, ale text je → klíče assetů v Developer Portalu nesedí. Nezobrazuje se nic →
zkontroluj nastavení soukromí aktivity z kroku 1 a že `clientId` je Application ID té
aplikace, do které jsi nahrál assety.

Vlastní log daemona je v `%LOCALAPPDATA%\claude-desktop-presence\daemon.log`
(5 MB, dva soubory). Zapisuje INFO a výš bez ohledu na `--debug`: start, vybraný log
adresář, připojení a odpojení Discordu, každou změnu stavu a **heartbeat každých
15 minut**. Ten heartbeat je tam proto, abys poznal zdravého nečinného daemona od
zaseknutého — jinak zdravý daemon celé hodiny nemá co říct a mlčící log by od mrtvého
nešel odlišit.

### Tlačítka

**Vlastní tlačítka na svém profilu neuvidíš.** Discord je autorovi nevykresluje, vidí je
jen ostatní. Když sis tlačítko nastavil a chybí, nech se na profil podívat někoho jiného,
než to prohlásíš za rozbité.

---

## 4. Spouštění po přihlášení

```powershell
.\install-autostart.ps1
.\install-autostart.ps1 -Uninstall
```

Skript si `claude-desktop-presence-bg.exe` najde sám — vedle sebe nebo v `release\` — a
upozorní tě, když najde jen konzolovou variantu.

Tři nastavení v té úloze jsou nosná:

- běží **ve tvé vlastní session**. Nepřepínej ji na „spouštět bez ohledu na přihlášení",
  aby se schovalo okno: tím se úloha přesune do session 0, kde
  `\\.\pipe\discord-ipc-0` neexistuje, a presence přestane fungovat úplně. Okno řeší
  binárka `-bg`.
- **žádný časový limit běhu**. Výchozí jsou tři dny, po kterých by plánovač daemona bez
  jediného slova zabil.
- **explicitní pracovní adresář**. Scheduled Task jinak startuje v
  `C:\Windows\System32`, což není místo, kde chceš mít config.

Složka Po spuštění se schválně nepoužívá — problikávalo by při každém přihlášení okno
konzole.

Pozor: `Start-ScheduledTask` neudělá nic, dokud už jedna instance běží (`MultipleInstances`
je `IgnoreNew`). Když chceš čistý start, úlohu nejdřív zastav — jinak to vypadá, že se
nestalo vůbec nic.

---

## Konfigurace

### Přepínače

| Přepínač           | Co dělá                                                      |
| ------------------ | ------------------------------------------------------------ |
| `--calibrate`      | změří tenhle stroj, vypíše hodnoty do configu a skončí       |
| `--config <cesta>` | kde hledat `config.json` (přijme i adresář)                  |
| `--debug`          | jeden řádek na tik: stav, CPU, podlaha, práh, důvod, payload |
| `--no-discord`     | všechno běží, payload se vypíše, nic se neodesílá            |

`config.json` se hledá v tomhle pořadí:

1. kam ukazuje `--config <cesta>`
2. vedle `.exe`, u zabaleného buildu
3. vedle vstupního modulu

Nikdy ne v aktuálním adresáři — u Scheduled Tasku by to byl `C:\Windows\System32`.

Při prvním spuštění daemon zkopíruje `config.example.json` a vyzve tě doplnit `clientId`.
Neznámý klíč není chyba, jen dostaneš varování s návrhem („did you mean"), aby překlep
tiše nespadl zpátky na default.

Texty presence **nejsou v kódu** — jsou v sekci `text`, výchozí znění je anglické. Přepiš
si je, jak chceš; cokoli přes 128znakový limit Discordu se ořeže výpustkou, ne natvrdo.
Nahrazují se jen klíče, které vypíšeš, takže můžeš změnit jeden řádek a zbytek nechat být.
Česky:

```json
"text": {
  "statusBusy": "Pracuje…",
  "statusTool": "Nástroj: {tool}",
  "statusActive": "Aktivní chat",
  "statusIdle": "Nečinný",
  "planUsageShortWindow": "Vytížení 5h: {percent} %",
  "planUsageLongWindow": "Vytížení 7d: {percent} %",
  "appVersion": "Verze {version}",
  "mcpServerCount": "MCP: {count} serverů"
}
```

Zástupné symboly ve složených závorkách — `{app}`, `{status}`, `{tool}`, `{percent}`,
`{version}`, `{count}` — se dosazují při vykreslení. Když nějaký napíšeš špatně, zůstane
v textu tak, jak je, takže je ta chyba vidět a neztratí se.

`buttons` bere až dvě položky `{ "label": ..., "url": ... }`, třeba odkaz na tenhle
repozitář. Viz poznámka výš o tom, že vlastní tlačítka nevidíš.

---

## Vytížení plánu

Claude Desktop si drží `%APPDATA%\Claude\plan-usage-history.json`, kde jsou u každého
vzorku dvě procenta pod klíči `fh` a `sd`.

**Co ta dvě okna znamenají, je odvození, ne dokumentované API.** Anthropic o tomhle
souboru nezveřejňuje nic. To čtení vychází ze tří věcí, které se potkávají:

- samotné názvy klíčů — `fh` jako five hours, `sd` jako seven days;
- struktura publikovaných limitů Anthropicu, která stojí na krátkém klouzavém okně plus
  týdenním;
- to, že se ty dvě hodnoty pohybují nezávisle na sobě — což je přesně to, co bys čekal od
  dvou různých oken, a ne od jednoho čísla zobrazeného dvakrát. Na stejné instalaci bylo
  naměřeno 55/22 i 29/29.

To stačí na to, aby ve výchozím textu presence stálo „5h" a „7d", a nestačí to na to, aby
se na tom dalo stavět. **Klíče** proto zůstávají neutrální — `planUsageShortWindow` a
`planUsageLongWindow` v configu, `shortWindowPercent` a `longWindowPercent` v kódu — a
„5h" a „7d" říkají jen ty řetězce, které skutečně čteš. Kdyby update Claude Desktopu
změnil význam těch polí, je oprava jeden řádek v tvém configu.

UUID `org` v tom souboru je identifikátor organizace. Nikdy se nečte, necachuje, neloguje
ani neposílá do Discordu — viz [Soukromí](#soukromí).

---

## Známá omezení

- **Detekce práce je heuristika, ne fakt.** Scrollování, přehrávání videa v chatu i
  načítání dlouhé konverzace taky žerou CPU a kterékoli z toho se může projevit jako
  „pracuje". Je to zdokumentované, ne schované.
- **Prvních ~20 sekund po startu je ticho.** Dokud nemá podlaha deset vzorků, verdikt
  „pracuje" založený jen na CPU se vůbec nepublikuje. Na vývojovém stroji sedí nečinný
  Claude nad výchozím prahem — viz medián klidu v tabulce v [Kalibraci](#2-kalibrace) —
  takže bez tohohle by daemon hlásil „pracuje" při každém jediném startu, zatímco Claude nedělá nic. Nepublikovat nic
  je poctivé, publikovat odhad ne. Signály, které podlahu nepotřebují — Claude neběží,
  aktivita MCP, okno v popředí — se publikují po celou dobu.
- **Burst delší než celé 30minutové okno spadne zpátky do klidu.** Odlišit to od trvale
  vysoké klidové podlahy by znamenalo počkat, až skončí.
- **`wmic` z Windows 11 zmizel**, takže `pidusage` tady nefunguje. CPU se čte jedním
  PowerShell dotazem.
- **Opírá se to o nedokumentované cesty a formáty logů.** Tohle je ta hlavní věc.
  Anthropic z toho nezveřejňuje nic a může to kdykoli změnit — a už se to stalo:
  **21. 8. 2026 se adresář s logy přesunul z Roaming do Local**, což by daemonovi s
  natvrdo zadanou cestou tiše rozbilo všechno. Každý čtenář tady smí selhat a vrátit
  null, adresář s logy se detekuje za běhu a daemon funguje, i když selžou všichni —
  spadne na „běží / neběží" plus odpočet. Ale update to pořád rozbít může. Když se to
  stane, [minimální varianta](#minimální-varianta) funguje dál.

### Ověřené signály

Naměřeno na reálné instalaci 6. 9. 2026, Claude Desktop `1.46388.4.0`, Windows MSIX.
Všechno výš na tom stojí.

| Signál                     | Stav              | Detail                                                                                                                                                                                                                              |
| -------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proces                     | ✅ spolehlivé     | `claude.exe` (Electron). **Počet instancí není konstantní — naměřeno 12, 16 i 17.** Hlavní okno = proces s neprázdným `MainWindowTitle` (hodnota `"Claude"`).                                                                       |
| `wmic`                     | ❌ neexistuje     | Odstraněný z Windows 11. `pidusage` na něm závisí, takže CPU jde z PowerShellu.                                                                                                                                                     |
| Discord IPC                | ✅ dostupné       | `\\.\pipe\discord-ipc-0` existuje, když běží Discord. Je per-session.                                                                                                                                                               |
| **Živý adresář logů**      | ⚠️ **přesunutý**  | Živý: `%LOCALAPPDATA%\Claude\Logs`. Zastaralý: `%APPDATA%\Claude\logs` (poslední zápis 21. 8. 2026). Nutno detekovat za běhu — zastaralý je _větší_, takže je odlišuje jedině mtime.                                                |
| Verze aplikace             | ✅                | Ze stack trace v `main.log`: `Claude_1.46388.4.0_x64__pzs8sxrjxfjjc`.                                                                                                                                                               |
| Vytížení plánu             | ✅ živé           | `%APPDATA%\Claude\plan-usage-history.json` — při přesunu logů zůstal v Roaming.                                                                                                                                                     |
| Heartbeat běhu             | ✅                | `main.log`, řádek `[process-memory]` každých ~30–60 s.                                                                                                                                                                              |
| Jméno nástroje             | ⚠️ jen občas      | `main.log`: `Received permission response for <uuid>: once (tool: <jméno>)`. **Vzniká jen když odklikneš dialog s povolením**, ne při každém volání.                                                                                |
| Aktivita MCP serverů       | ✅ nepřímo        | mtime `mcp-server-<Name>.log` se hýbe, když server něco dělá.                                                                                                                                                                       |
| **Živé „Claude přemýšlí"** | ❌ **neexistuje** | `mcp.log` obsahuje `tools/list`, `prompts/list`, `resources/list` — ale **žádné `tools/call`**. Volání nástrojů se v této verzi nelogují, takže z logů nejde zjistit, co Claude dělá. Proto je stav „pracuje" vůbec CPU heuristika. |

---

## Minimální varianta

[`scripts/minimal.mjs`](scripts/minimal.mjs) má zhruba sedmdesát řádků kódu: běží `claude.exe` →
presence s odpočtem, jinak smazat. Žádné logy, žádná CPU heuristika, žádná kalibrace,
žádný config.

```bash
node scripts/minimal.mjs <discord-application-id>
```

Nic v tom nezávisí na nedokumentované cestě ani formátu logu, takže to update Claude
Desktopu nemůže rozbít. Použij to, když nechceš kalibrovat, nebo jako náhradu, když
update rozbije ten pořádný daemon.

---

## Soukromí

Daemon **nikdy nečte obsah konverzací**.

- Z logů se extrahují jen řádky odpovídající explicitnímu whitelistu regexů. Nic jiného
  se nezpracovává ani nikam nepředává.
- Nesahá na `%APPDATA%\Claude\Local Storage`, `IndexedDB`, `Network\Cookies`, `sentry\`
  ani na OAuth tokeny.
- Do Discordu nikdy neposílá názvy chatů, cesty k souborům, UUID `org` z
  `plan-usage-history.json` ani jméno uživatele.
- Vlastní log daemona obsahuje jen extrahované hodnoty a errno kódy — nikdy syrový řádek
  z logu Claude Desktopu.
- Každou položku jde vypnout zvlášť přes `show.*`, včetně procenta vytížení.

---

## Vývoj

```bash
npm install
npm run build      # dist/index.js (ESM) + dist/index.cjs (CJS, vstup pro pkg)
npm test
npm run package    # release/claude-desktop-presence.exe + -bg.exe
npm run docs:sync  # přegeneruje sekce s měřením v README a SPECech
```

`npm run lint`, `npm run typecheck` a `npm run format` dělají, co se od nich čeká. Celá
specifikace včetně měření, na kterých všechno stojí, je v [SPEC.md](SPEC.md) (anglicky),
česky v [SPEC.cs.md](SPEC.cs.md).

**Kalibrační čísla v těchhle dokumentech se generují, nepíšou.** Berou se z
[`src/measurement.ts`](src/measurement.ts) přes tentýž `analyse` a `formatReport`, jaké
používá program, do oblastí označených `<!-- generated:... -->` v README.md, README.cs.md,
SPEC.md a SPEC.cs.md. Změň měření, spusť `npm run docs:sync` a všechny čtyři se posunou
naráz. `npm run docs:check` selže, když se to nestalo, `npm test` tu kontrolu pouští a CI
ji pouští před releasem — protože ty čtyři dokumenty se už jednou rozešly a nikdo si toho
nevšiml.

## Licence

MIT
