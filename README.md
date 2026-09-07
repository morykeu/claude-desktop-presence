# claude-desktop-presence

Discord Rich Presence for **Claude Desktop on Windows**. A standalone daemon — it does
not touch Claude Desktop, and it does not need developer mode.

🇨🇿 [Česká verze](README.cs.md)

> **This is an unofficial, third-party tool.** It is not made by, affiliated with, or
> endorsed by Anthropic, and it is not supported by them. It works by reading paths, log
> files and process behaviour that Anthropic does not document and has never promised to
> keep stable — **any Claude Desktop update can break it without warning.** That is not a
> hypothetical: on 2026-08-21 an update moved the log directory from Roaming to Local, and
> a tool with that path hardcoded would have silently stopped working. Everything here is
> written to degrade rather than crash, and there is a
> [minimal fallback](#minimal-fallback) that depends on none of it, but you should install
> this expecting to have to fix it one day.
>
> "Claude" and "Claude Desktop" are trademarks of Anthropic, used here only to say what
> this tool watches.

---

## Install

Download `claude-desktop-presence.exe`, `claude-desktop-presence-bg.exe` and
`config.example.json` from the [latest release](../../releases/latest) and put them in
the same folder.

**Two binaries, same program.** pkg can only produce console applications, so a
Scheduled Task starting the console build pops up a cmd window at every logon. The `-bg`
build is a byte-for-byte copy with the PE subsystem switched from CONSOLE to WINDOWS, so
Windows starts it without a console at all.

| Binary                           | Use it for                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `claude-desktop-presence.exe`    | `--calibrate`, `--debug`, running by hand — anything where you want to see output   |
| `claude-desktop-presence-bg.exe` | autostart. No window, and no console output either: everything goes to `daemon.log` |

Calibrate with the console one, autostart the `-bg` one.

The .exe is **not code-signed**, so SmartScreen will probably warn you the first time
("Windows protected your PC" → More info → Run anyway), and Defender may quarantine it.
That is what an unsigned binary from the internet looks like; a certificate costs money
and this is a hobby daemon. If you would rather not click through that, run it from
source instead:

```bash
git clone <this repo>
cd claude-desktop-presence
npm install
npm run build
node dist/index.js
```

Everything below works the same either way — replace `claude-desktop-presence.exe` with
`node dist/index.js`.

---

## 1. Create the Discord application

This part cannot be automated; it needs your account.

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
   → **New Application**.

   > ⚠️ **Discord will not let you call it "Claude."** The name is rejected outright, and
   > so are `Claude Desktop`, `Claude AI`, `Claude.ai` and `claude` — the filter matches
   > the substring and protects the trademark. Verified 2026-09-06.
   >
   > Use **`C.L.A.U.D.E`**. It goes through and it reads fine. If the filter ever
   > changes, `Claudius`, `Desktop Presence` or `CDRP` also work.
   >
   > Do **not** try to sneak past the filter with zero-width characters. Discord deletes
   > applications for that, and everyone who installed this tool would inherit the
   > problem.

2. Copy the **Application ID** (a long number). That goes in `config.json`.

3. **Rich Presence → Art Assets**, upload three images (512×512 PNG minimum) under
   exactly these keys:

   | Key           | Used for                           |
   | ------------- | ---------------------------------- |
   | `claude_logo` | the large icon                     |
   | `busy`        | small icon while Claude is working |
   | `idle`        | small icon while it is not         |

   The names have to match exactly. An asset key that was never uploaded renders as
   nothing at all, with no error message anywhere.

4. In Discord itself: **Settings → Activity Privacy → "Display current activity as a
   status message"** must be on.

The Application ID is a public value, not a secret.

---

## 2. Calibrate

**Do this before anything else.** The daemon decides "Claude is working" from CPU usage,
and there is no threshold that is correct on every machine. Measured on the development
machine while Claude streamed a long answer:

<!-- generated:calibration-table -->

| Phase   | samples | min      | median   | p90   | max      |
| ------- | ------- | -------- | -------- | ----- | -------- |
| idle    | 14      | 0.98     | **1.75** | 2.69  | **3.02** |
| working | 27      | **5.39** | **9.57** | 12.25 | 13.96    |

<!-- /generated:calibration-table -->

<!-- generated:calibration-provenance -->

_Measured 2026-09-06 on the target machine (12 cores), Claude Desktop 1.46388.4.0, while streaming a long answer. Generated from `src/measurement.ts` by `npm run docs:sync` — do not edit by hand._

<!-- /generated:calibration-provenance -->

All in percent of **one core**. The quietest working sample sits above the noisiest idle
one — no overlap, which is the best case for a heuristic like this. It is also why the
threshold has to be measured rather than guessed: the original hand-picked 12 % clears
only the top few working samples even here, and against the agentic session that was
measured first — 3.9 % of one core — it would never have fired at all.

```bash
claude-desktop-presence --calibrate
```

Two phases, about 90 seconds in total, and it tells you what to do in each:

| Phase | Length | What you do                                                         | What it measures  |
| ----- | ------ | ------------------------------------------------------------------- | ----------------- |
| 1     | 30 s   | **Leave Claude alone.** Do not type anything to it.                 | the idle floor    |
| 2     | 60 s   | **Send Claude a long prompt** and let it generate the whole answer. | the working level |

Two phases rather than one undirected minute, because one minute cannot tell idle from
busy. The first version of this tool sampled for a single minute and reported an "idle
floor" of 1.69 % — purely because Claude never actually went quiet during it.

At the end you get the distribution for both phases and a block to paste into
`config.json`. This is the run the table above came from, printed by the calibrator
itself:

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

Raw samples of both phases saved to:
  C:\Tools\claude-desktop-presence\calibration-2026-09-06T18-42-11Z.json
  Keep it. A summary cannot be re-analysed; these readings can.
```

<!-- /generated:calibration-report -->

Which works out as:

<!-- generated:calibration-derived -->

- **floor 1.07 %** — p5 of phase 1, where the rolling baseline settles at runtime
- **idle edge 2.82 %** (p95 of phase 1) · **work edge 6.38 %** (p5 of phase 2) → 3.56 points apart, the distributions do not overlap
- **BUSY above 4.60 %** — exactly midway between those two edges
- **back to idle at 3.22 %** — above the idle maximum of 3.02 %, so an ordinary fluctuation cannot keep the daemon latched in BUSY
- into the config: multiplier 2.5 · delta 3.5 · exitFactor 0.7

> The summary above (min, median, p90, max, and the p5 floor) is what was measured. The individual readings were not kept, so the separation percentiles — p95 of idle and p5 of working — come from a reconstruction with the same shape and are indicative rather than measured.

<!-- /generated:calibration-derived -->

`thresholdDeltaPercent` is the jump from the floor to the threshold, and it is the rule
that actually fires; `thresholdMultiplier` is a safety net for machines that idle high.
`exitFactor` is derived rather than fixed, because the exit bar has to land **above** the
idle maximum — otherwise an ordinary idle fluctuation keeps the daemon latched in BUSY,
which is what a fixed 0.6 would have done here.

Two things can go wrong, and they are reported separately:

- **`RESULT NOT USABLE`** — phase 2 never rose clearly above the floor. Almost always
  means phase 2 did not really happen. Send a prompt long enough that Claude is still
  generating when the phase ends.
- **`WARNING: idle and working overlap`** — phase 2 did happen, and still cannot be told
  apart from idle: the top of the idle distribution reaches into the bottom of the
  working one. No threshold separates them on that machine, so the suggestion is the
  best available guess rather than a good one. Usually something else is burning
  `claude.exe` CPU while you think it is idle.

### The run keeps its readings

Every run writes `calibration-<timestamp>.json` next to your `config.json` — every
individual reading of both phases, with its phase number and timestamp — and the report
ends with the path it used. The path above is an example; yours will be wherever your
config lives.

Keep those files. A summary cannot be re-analysed and readings can, which is not a
hypothetical here: the measurement in the table above was recorded as min/median/p90/max,
the readings were discarded, and when the threshold rule later changed to key off two
different percentiles there was nothing left to compute them from. The numbers you see
come from a reconstruction, and say so.

If you calibrate a machine and want to contribute the run, drop the file into
[`measurements/`](measurements/) and run `npm run docs:sync` — see
[measurements/README.md](measurements/README.md).

You can skip calibration; the defaults are reasonable. But then the busy detection is
tuned for someone else's computer, not yours.

### What the numbers mean

- The unit is **percent of one core**, not percent of the machine. Electron is largely
  single-threaded, so dividing by the core count buries the signal in noise. The value
  can go above 100 % when several processes are busy at once.
- The daemon keeps a **rolling idle floor** (the 5th percentile over the last 30 minutes)
  and calls it BUSY when usage rises above that floor by `thresholdMultiplier` times, or
  by `thresholdDeltaPercent` points — whichever is higher. So it adapts to your machine
  instead of trusting a constant.
- **Every** sample feeds that floor, whatever it was classified as. The length of the
  window is what stops a long burst taking it over: ten minutes of continuous work still
  leaves twenty minutes of quiet samples behind it. Filtering by state instead deadlocks
  on a machine whose genuine idle CPU is high — the first sample looks busy, learning
  never starts, and the status sticks on "working" forever.

---

## 3. Checking that it works

### Dry run, without touching Discord

```bash
claude-desktop-presence --no-discord --debug
```

Nothing is sent anywhere. You get one line per tick plus the payload that _would_ have
gone out.

With the calibrated config from above:

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

Read it as: state, then the numbers behind the decision, then what Discord would show.
`reason` tells you which rule fired — `cpu`, `mcp`, `focus`, `idle` or `offline`.

The threshold moves between the first two lines and the last two, and it is worth knowing
why. While the floor is still being learned the baseline counts as zero, so the threshold
is the bare `thresholdDeltaPercent`; once the baseline settles on the measured floor it
becomes floor + delta.

Note how few `setActivity` lines there are compared to tick lines: that is the rate
limiter. Discord is updated at most every 15 seconds, and only when something changed.

`<- warmup` means the idle floor is still being learned. See
[Known limitations](#known-limitations).

This mode exists so you do not have to restart Discord twenty times while tuning.

### For real

Start Discord, then start the daemon. Within about fifteen seconds your profile should
show:

- **C.L.A.U.D.E** as the header — that is the application name, because Discord rejects
  anything containing "claude". This is exactly why the line underneath spells out
  "Claude Desktop": without it, nobody could tell what the entry is.
- **first line**: `Claude Desktop — Idle` / `Working…` / `Active chat` / `Tool: <name>`
- **second line**: cycling every 20 seconds through plan usage, the app version and the
  MCP server count — whichever you left enabled under `show`
- **large icon** `claude_logo`, **small icon** `busy` or `idle`
- an **elapsed timer** counting from when Claude Desktop started

Icons missing but text present → the asset keys in the Developer Portal do not match.
Nothing at all → check the activity privacy setting from step 1, and that `clientId` is
the Application ID of the app whose assets you uploaded.

The daemon's own log is at `%LOCALAPPDATA%\claude-desktop-presence\daemon.log`
(5 MB, two files). It records INFO and above with or without `--debug`: startup, the log
directory it picked, Discord connecting and dropping, every state change, and a
**heartbeat every 15 minutes**. The heartbeat is there so you can tell a healthy idle
daemon from a stuck one — an otherwise healthy daemon has nothing to say for hours, and
a silent log would be indistinguishable from a dead one.

### Buttons

**You cannot see your own buttons.** Discord does not render them on your own profile —
only other people do. If you configured one and it is missing, ask someone else to look
before assuming it is broken.

---

## 4. Start it automatically

```powershell
.\install-autostart.ps1
.\install-autostart.ps1 -Uninstall
```

It picks up `claude-desktop-presence-bg.exe` on its own — next to the script or in
`release\` — and warns you if it can only find the console build.

Three settings in the task are load-bearing:

- it runs **in your own session**. Do not switch it to "run whether user is logged on or
  not" to hide the window: that moves the task into session 0, where
  `\\.\pipe\discord-ipc-0` does not exist, and the presence stops working entirely. The
  `-bg` binary is how the window is dealt with.
- **no execution time limit**. The default is three days, after which the scheduler would
  kill the daemon without a word.
- an **explicit working directory**. A Scheduled Task otherwise starts in
  `C:\Windows\System32`, which is not where you want your config.

The startup folder is deliberately not used — it flashes a console window at every logon.

Note that `Start-ScheduledTask` does nothing while an instance is already running
(`MultipleInstances` is `IgnoreNew`). Stop the task first if you want a fresh start —
otherwise it looks as though nothing happened.

---

## Configuration

### Flags

| Flag              | What it does                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `--calibrate`     | measure this machine, print config values, exit                     |
| `--config <path>` | where to look for `config.json` (a directory works too)             |
| `--debug`         | one line per tick: state, CPU, baseline, threshold, reason, payload |
| `--no-discord`    | run everything, print the payload, send nothing                     |

`config.json` lives, in order of priority:

1. wherever `--config <path>` points
2. next to the `.exe`, for a packaged build
3. next to the entry module

Never the current working directory — as a Scheduled Task that would be
`C:\Windows\System32`.

On first run the daemon copies `config.example.json` and asks you to fill in `clientId`.
An unknown key is not an error; you get a warning with a "did you mean" suggestion, so a
typo does not silently fall back to the default.

The presence strings are **not hardcoded** — they are in the `text` section, English by
default. Translate them to whatever you like; anything over Discord's 128-character limit
is trimmed with an ellipsis rather than cut off. Only the keys you list are replaced, so
you can change one line and leave the rest alone. A Czech example:

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

The placeholders in braces — `{app}`, `{status}`, `{tool}`, `{percent}`, `{version}`,
`{count}` — are substituted at render time. A placeholder you misspell is left in the
string as-is, so the mistake is visible rather than silent.

`buttons` takes up to two `{ "label": ..., "url": ... }` entries, e.g. a link to this
repo. See the note above about not being able to see your own.

---

## Plan usage

Claude Desktop keeps `%APPDATA%\Claude\plan-usage-history.json`, which holds two usage
percentages per sample under the keys `fh` and `sd`.

**What those two windows are is a derivation, not a documented API.** Nothing about this
file is published by Anthropic. The reading comes from three things lining up:

- the key names themselves — `fh` for five hours, `sd` for seven days;
- Anthropic's published plan limits, which are structured as a short rolling window plus
  a weekly one;
- the two values moving independently of each other, which is what you would expect from
  two separate windows rather than one number shown twice. Both 55/22 and 29/29 have been
  observed on the same install.

That is good enough to label them "5h" and "7d" in the default presence text, and not
good enough to rely on. So the **keys** stay neutral — `planUsageShortWindow` and
`planUsageLongWindow` in the config, `shortWindowPercent` and `longWindowPercent` in the
code — and only the strings you actually read say 5h and 7d. If a Claude Desktop update
changes what those fields mean, the fix is one line in your config.

The `org` UUID in that file is an organisation identifier. It is never read, never
cached, never logged and never sent to Discord — see [Privacy](#privacy).

---

## Known limitations

- **The busy detection is a heuristic, not a fact.** Scrolling, playing a video in the
  chat, and loading a long conversation all burn CPU too, and any of them can show up as
  "working". This is documented rather than hidden.
- **The first ~20 seconds after starting are quiet.** Until the idle floor has ten
  samples, a CPU-only "working" verdict is not published at all. On the development
  machine idle Claude sits above the default threshold — see the idle median in the table
  under [Calibrate](#2-calibrate) — so without this the daemon would announce "working"
  every single time it started, while Claude sat there doing nothing. Publishing nothing is honest; publishing a guess is
  not. Signals that do not depend on the floor — Claude not running, MCP activity, window
  focus — are published throughout.
- **A burst longer than the whole 30-minute window will drift back to idle.** Telling
  that apart from a permanently high idle floor would mean waiting for it to end.
- **`wmic` is gone from Windows 11**, so `pidusage` does not work here. CPU comes from a
  single PowerShell query instead.
- **It relies on undocumented paths and log formats.** This is the big one. Anthropic
  publishes none of this and can change it at any time — and did: on **2026-08-21 the log
  directory moved from Roaming to Local**, which would have silently broken a daemon with
  the path hardcoded. Every reader here is allowed to fail and return null, the log
  directory is re-detected at runtime, and the daemon still works when all of them fail —
  it falls back to "running / not running" plus elapsed time. But an update can still
  break it. If that happens, [the minimal fallback](#minimal-fallback) keeps working.

### Verified signals

Measured on a real installation on 2026-09-06, Claude Desktop `1.46388.4.0`, Windows
MSIX. Everything above rests on this.

| Signal                        | Status                | Detail                                                                                                                                                                                                                                           |
| ----------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Process                       | ✅ reliable           | `claude.exe` (Electron). **The instance count is not constant — 12, 16 and 17 all observed.** The main window is the process with a non-empty `MainWindowTitle` (value `"Claude"`).                                                              |
| `wmic`                        | ❌ gone               | Removed from Windows 11. `pidusage` depends on it, so CPU comes from PowerShell.                                                                                                                                                                 |
| Discord IPC                   | ✅ available          | `\\.\pipe\discord-ipc-0` exists while Discord runs. Per-session.                                                                                                                                                                                 |
| **Live log directory**        | ⚠️ **moved**          | Live: `%LOCALAPPDATA%\Claude\Logs`. Stale: `%APPDATA%\Claude\logs` (last written 2026-08-21). Must be detected at runtime — the stale one is _larger_, so only mtime tells them apart.                                                           |
| App version                   | ✅                    | Parsed from a stack trace in `main.log`: `Claude_1.46388.4.0_x64__pzs8sxrjxfjjc`.                                                                                                                                                                |
| Plan usage                    | ✅ live               | `%APPDATA%\Claude\plan-usage-history.json` — stayed in Roaming when the logs moved.                                                                                                                                                              |
| Run heartbeat                 | ✅                    | `main.log`, a `[process-memory]` line every ~30–60 s.                                                                                                                                                                                            |
| Tool name                     | ⚠️ occasional         | `main.log`: `Received permission response for <uuid>: once (tool: <name>)`. **Only written when you click through a permission dialog**, not on every call.                                                                                      |
| MCP server activity           | ✅ indirect           | `mcp-server-<Name>.log` mtime moves while a server is doing something.                                                                                                                                                                           |
| **Live "Claude is thinking"** | ❌ **does not exist** | `mcp.log` has `tools/list`, `prompts/list`, `resources/list` — but **no `tools/call`**. Tool invocations are not logged in this version, so the logs cannot tell you what Claude is doing. This is why the busy state is a CPU heuristic at all. |

---

## Minimal fallback

[`scripts/minimal.mjs`](scripts/minimal.mjs) is about seventy lines of code: is `claude.exe`
running → presence with an elapsed timer, otherwise clear it. No logs, no CPU heuristics,
no calibration, no config.

```bash
node scripts/minimal.mjs <discord-application-id>
```

Nothing in it depends on an undocumented path or log format, so a Claude Desktop update
cannot break it. Use it if you do not want to calibrate, or as a stopgap if an update
breaks the real daemon.

---

## Privacy

The daemon **never reads conversation content**.

- Only lines matching an explicit whitelist of regexes are extracted from the logs.
  Nothing else is processed or forwarded.
- It does not touch `%APPDATA%\Claude\Local Storage`, `IndexedDB`, `Network\Cookies`,
  `sentry\`, or OAuth tokens.
- It never sends chat names, file paths, the `org` UUID from `plan-usage-history.json`,
  or your username to Discord.
- The daemon's own log contains extracted values and errno codes only — never a raw line
  from a Claude Desktop log.
- Every field can be switched off individually via `show.*`, including the plan usage
  percentage.

---

## Development

```bash
npm install
npm run build      # dist/index.js (ESM) + dist/index.cjs (CJS, the input for pkg)
npm test
npm run package    # release/claude-desktop-presence.exe + -bg.exe
npm run docs:sync  # regenerate the measurement sections of the READMEs and SPECs
```

`npm run lint`, `npm run typecheck` and `npm run format` do what they say. The full
specification, including the measurements everything rests on, is in [SPEC.md](SPEC.md).

**The calibration numbers in these documents are generated, not typed.** They come from
a measurement, through the same `analyse` and `formatReport` the program uses, into the
regions marked `<!-- generated:... -->` in README.md, README.cs.md, SPEC.md and
SPEC.cs.md. Run `npm run docs:sync` and all four move together.

The measurement is the newest `calibration-*.json` in [`measurements/`](measurements/) if
there is one, and otherwise the reconstruction in
[`src/measurement.ts`](src/measurement.ts) — which is what it is today, hence the note
about indicative percentiles.

`npm run docs:check` fails when the documents have fallen behind the measurement,
`npm test` runs that check, and CI runs it before a release — because these four
documents did drift apart once, and nothing noticed.

## License

MIT
