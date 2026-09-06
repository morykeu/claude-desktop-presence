# claude-desktop-presence

Discord Rich Presence for **Claude Desktop on Windows**. A standalone daemon — it does
not touch Claude Desktop, and it does not need developer mode.

🇨🇿 [Česká verze](README.cs.md)

---

## Install

Download `claude-desktop-presence.exe` and `config.example.json` from the
[latest release](../../releases/latest) and put them in the same folder.

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
machine during real agentic work, Claude Desktop used **3.9 % of one core** — a
hand-picked threshold of 12 % would never have fired once.

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
`config.json`:

```
Phase 1 — idle (14 samples)
  min 0.21 %   median 0.32 %   p90 0.45 %   max 0.58 %
Phase 2 — working (29 samples)
  min 1.90 %   median 3.90 %   p90 5.20 %   max 6.10 %

  idle floor   0.32 %  (p5 of phase 1)
  BUSY above   1.75 %

Paste into config.json:

  "busy": {
    "baselineWindowSec": 1800,
    "baselinePercentile": 5,
    "thresholdMultiplier": 5.5,
    "thresholdDeltaPercent": 1.4,
    "exitFactor": 0.6
  }
```

If phase 2 does not come out clearly above the floor, the result is reported as **not
usable** rather than dressed up as a recommendation — that almost always means phase 2
did not really happen. Send a prompt long enough that Claude is still generating when the
phase ends.

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
gone out:

```
IDLE    cpu=0.00% baseline=0.00% threshold=1.50% reason=idle details="Claude Desktop — Nečinný" state="Verze 1.46388.4.0"  <- warmup
BUSY    cpu=2.27% baseline=0.00% threshold=1.50% reason=cpu details="Claude Desktop — Pracuje…" state="MCP: 22 serverů"  <- warmup, NOT PUBLISHED (warmup)
[no-discord] setActivity {"details":"Claude Desktop — Nečinný","smallImageKey":"idle",...}
```

Read it as: state, then the numbers behind the decision, then what Discord would show.
`reason` tells you which rule fired — `cpu`, `mcp`, `focus`, `idle` or `offline`.

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
- **first line**: `Claude Desktop — Nečinný` / `Pracuje…` / `Aktivní chat` /
  `Nástroj: <name>`
- **second line**: cycling every 20 seconds through plan usage, the app version and the
  MCP server count — whichever you left enabled under `show`
- **large icon** `claude_logo`, **small icon** `busy` or `idle`
- an **elapsed timer** counting from when Claude Desktop started

Icons missing but text present → the asset keys in the Developer Portal do not match.
Nothing at all → check the activity privacy setting from step 1, and that `clientId` is
the Application ID of the app whose assets you uploaded.

The daemon's own log is at `%LOCALAPPDATA%\claude-desktop-presence\daemon.log`
(5 MB, two files).

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

Registers a Scheduled Task that runs at logon. Three settings in it are load-bearing: the
task runs **in your own session** (the Discord IPC pipe is per-session and invisible from
session 0), has **no execution time limit** (the default is three days, after which the
scheduler would kill it), and has an **explicit working directory** (a Scheduled Task
otherwise starts in `C:\Windows\System32`, which is not where you want your config).

The startup folder is deliberately not used — it flashes a console window at every logon.

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

The presence strings are **not hardcoded** — they are in the `text` section, with Czech
shipped as the default. Translate them to whatever you like; anything over Discord's
128-character limit is trimmed with an ellipsis rather than cut off.

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
  machine idle Claude sits at ~1.8 % of one core, which is above the default threshold —
  without this the daemon would announce "working" every single time it started, while
  Claude sat there doing nothing. Publishing nothing is honest; publishing a guess is
  not. Signals that do not depend on the floor — Claude not running, MCP activity, window
  focus — are published throughout.
- **A burst longer than the whole 30-minute window will drift back to idle.** Telling
  that apart from a permanently high idle floor would mean waiting for it to end.
- **The measured baseline is a lower bound.** It was taken during an agentic session,
  which is mostly waiting on the network. Streaming a long answer into the renderer will
  be higher and has not been measured yet.
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

[`scripts/minimal.mjs`](scripts/minimal.mjs) is about sixty lines: is `claude.exe`
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
npm run package    # release/claude-desktop-presence.exe
```

`npm run lint`, `npm run typecheck` and `npm run format` do what they say. The full
specification, including the measurements everything rests on, is in [SPEC.md](SPEC.md)
(Czech).

## License

MIT
