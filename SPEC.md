# claude-desktop-presence — specification

Discord Rich Presence for **Claude Desktop on Windows**. A standalone daemon; it does not
modify Claude Desktop and does not need developer mode.

🇨🇿 [Česká verze](SPEC.cs.md) — the original this was translated from.

This is the design document. For installation and usage, see the [README](README.md).

---

## 0. Verified facts

**Measured on a real installation on 2026-09-06. Claude Desktop `1.46388.4.0`, Windows
MSIX build.** None of this is guesswork, and everything else in this document rests on it.

If you are building your own tool on top of Claude Desktop, this section is probably the
only part of this repository you need. It is also the part most likely to go stale — none
of it is documented or supported by Anthropic, and it has already changed once.

| Signal                        | Status                | Detail                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Application process           | ✅ reliable           | `claude.exe` (Electron). **The instance count is not constant — 12, 16 and 17 have all been observed**, so never hardcode it. The main window is the process with a non-empty `MainWindowTitle` (the value is `"Claude"`); every other instance has an empty one.                                                                                                                    |
| `wmic`                        | ❌ **gone**           | Microsoft removed it from Windows 11. **Consequence: `pidusage` does not work on this machine**, because that is what it shells out to on Windows. CPU has to come from PowerShell instead (see §3).                                                                                                                                                                                 |
| Discord IPC                   | ✅ available          | The pipe `\\.\pipe\discord-ipc-0` exists while Discord is running. It is **per-session** — a process in session 0 cannot see it.                                                                                                                                                                                                                                                     |
| **Live log directory**        | ⚠️ **moved**          | Live: `%LOCALAPPDATA%\Claude\Logs`. Stale: `%APPDATA%\Claude\logs` (last written 2026-08-21, the day the update landed). **Must be detected at runtime.** The stale directory is _larger_ than the live one, so size is not a usable discriminator — only mtime is.                                                                                                                  |
| Application version           | ✅                    | Parseable out of a stack trace in `main.log`: `Claude_1.46388.4.0_x64__pzs8sxrjxfjjc`.                                                                                                                                                                                                                                                                                               |
| Plan usage                    | ✅ live               | `%APPDATA%\Claude\plan-usage-history.json` → `{"version":2,"samples":[{"t":<epoch_ms>,"org":"<uuid>","u":{"fh":55,"sd":22}}]}`. It **stayed in Roaming** when the logs moved to Local. `fh` / `sd` are percentages over two different windows; which windows is a derivation, not a documented API (see README). `org` is an organisation identifier and must not leave the machine. |
| Run heartbeat                 | ✅                    | `main.log`, a line reading `[process-memory] trigger=interval tree_rss_sum=...MB electron(10)=...MB` every ~30–60 s.                                                                                                                                                                                                                                                                 |
| Tool name                     | ⚠️ occasional         | `main.log`: `Received permission response for <uuid>: once (tool: <toolName>)`. **Written only when the user clicks through a permission dialog**, not on every call. Not a reliable source of "what is running right now".                                                                                                                                                          |
| MCP server activity           | ✅ indirect           | `%LOCALAPPDATA%\Claude\Logs\mcp-server-<Name>.log` — the mtime moves while that server is doing something.                                                                                                                                                                                                                                                                           |
| **Live "Claude is thinking"** | ❌ **does not exist** | `mcp.log` contains `method="tools/list"`, `"prompts/list"` and `"resources/list"` — but **no `tools/call`**. Tool invocations are not logged in this version. There is no way to tell from the logs what Claude is currently doing.                                                                                                                                                  |

**Design consequence:** since the logs cannot say what Claude is doing, `busy` is derived
from a **CPU heuristic** instead (§3). The log reader stays, but as a supplement rather
than the foundation.

Second-order consequence, worth stating plainly: all of this is an implementation detail
of somebody else's application. Every reader in this daemon is allowed to fail and return
`null`, and the daemon has to keep working when all of them do.

---

## 1. Stack

**Node.js + TypeScript.** Reasons:

- `@xhayper/discord-rpc` is maintained; Discord's own `discord-rpc` is archived and not
  recommended.
- `pkg` / `@yao-pkg/pkg` can bundle everything into a single `.exe`, so the user does not
  need Node installed.
- GitHub Actions release builds are trivial.

**Alternative, if that is unwelcome:** Python + `pypresence` + `psutil`. Shorter code, but
distribution through PyInstaller is more annoying and antivirus software flags it more
often. If this is not going on GitHub for strangers, Python is perfectly fine.

---

## 2. Discord setup (manual, one-off, ~3 minutes)

**Code cannot do this** — it needs your account.

1. https://discord.com/developers/applications → **New Application**.

   > ⚠️ **Discord blocks the name `Claude`** — it returns "application name is invalid".
   > The variants `Claude Desktop`, `Claude AI`, `Claude.ai` and `claude` are blocked too;
   > the filter evidently matches the substring "claude" and protects the trademark.
   > Verified 2026-09-06.
   >
   > **Use `C.L.A.U.D.E`** — it goes through and it is readable. Alternatives if the filter
   > changes: `Claudius`, `Desktop Presence`, `CDRP`.
   >
   > Do not evade the filter with invisible characters (zero-width space and friends).
   > Discord deletes applications for that, and the problem would be inherited by everyone
   > who installs the tool.

2. Copy the **Application ID** (a number) — it goes in the config.
3. **Rich Presence → Art Assets** → upload images (512×512 PNG minimum):
   - key `claude_logo` — the main icon
   - key `busy` — small icon while Claude is working
   - key `idle` — small icon while it is not
4. Discord → Settings → **Activity Privacy** → "Display current activity as a status
   message" must be on.

> The Application ID is a public value, not a secret — it can sit in the repository as a
> default.

---

## 3. Behaviour

### State model

```
OFFLINE   → claude.exe not running        → presence cleared (clearActivity)
IDLE      → running, low CPU              → "Idle"
ACTIVE    → running and window focused    → "Active chat"
BUSY      → CPU above the threshold       → "Working…"
TOOL      → BUSY + a recent permission    → "Tool: <name>"
```

### Detecting `BUSY` (the core of the whole thing)

Log parsing failed here, so it works like this instead:

1. Collect every `claude.exe` process along with its `TotalProcessorTime` in a single
   PowerShell query. **No `pidusage`** — on Windows it reaches for `wmic`, which does not
   exist on the target machine (§0). The exact query is in §P2.
2. Compute the CPU-ms delta over the interval **only from PIDs present in both consecutive
   samples** (`CpuMs` is cumulative since process start, so a renderer that disappeared
   would otherwise produce a negative delta), and divide by the wall-clock delta. **Do not
   divide by the core count** — see below.
3. Moving average over the last 5 samples, so it does not flicker.
4. The threshold is **not a number you type; it is calibrated at runtime** — see below.
5. Hysteresis: BUSY is entered above the threshold and left only below
   `threshold × exitFactor` — otherwise it oscillates.

#### The unit is "percent of one core", not percent of the machine

Measured on the target machine (12 cores, 4 s sample) during real agentic work:

| Unit                        | Value             |
| --------------------------- | ----------------- |
| normalised across all cores | **0.32 %**        |
| percent of one core         | **3.9 %**         |
| busiest single process      | 2.3 % of one core |

The original threshold `busyCpuThresholdPercent = 12` was therefore off by roughly **40×**
and would never have fired. Electron is largely single-threaded, so dividing by the core
count dissolves the signal into noise. In this unit the value **can exceed 100 %** when
several processes are busy at once.

> **That figure was a lower bound.** It came from an agentic session, which is mostly
> waiting on the network. Streaming an answer is higher — and has since been measured too,
> see below.

#### Measuring a streaming answer (2026-09-06, 12 cores)

The first real measurement of generation rather than an agentic session. Percent of one
core:

| Phase               | samples | min      | median   | p90   | max      |
| ------------------- | ------- | -------- | -------- | ----- | -------- |
| idle                | 14      | 0.98     | **1.75** | 2.69  | **3.02** |
| working (streaming) | 27      | **5.39** | **9.57** | 12.25 | 13.96    |

**There is no overlap between idle and working** — the quietest working sample (5.39) sits
above the noisiest idle one (3.02). That is the best possible outcome: on this class of
workload the heuristic has clean separation.

Three things follow from those numbers, and all three are now in the calibrator:

1. **The idle floor here is 1.07 % of one core**, not the 0.32 % from the agentic session.
   Idle is not a constant of the machine; it depends on what Claude has open.
2. **The multiplier must not be derived as `threshold ÷ floor`.** On this data that gives
   4.2 — and as soon as the runtime floor climbs above 2.3 %, `floor × 4.2` overshoots the
   median of real work (9.57) and `BUSY` stops happening entirely. The delta is the primary
   rule; the multiplier is only a safety net for machines with a higher floor. It is held
   conservatively at 2.5 and pulled down if `floor × multiplier` would exceed half the
   working median.
3. **`exitFactor` has to be derived from the data, not fixed at 0.6.** The exit threshold
   must sit ABOVE the idle maximum, or an ordinary idle fluctuation keeps it latched in
   `BUSY`. Here: entry threshold 4.47, idle max 3.02 → 0.6 gives 2.68, i.e. below the very
   noise it is supposed to ignore. The correct value is **0.7**.

#### Self-calibration instead of a fixed threshold

No constant fits every machine, so the daemon maintains its own threshold:

- **baseline** = the 5th percentile of `cpuPercent` over the last **30–60 minutes**
  (rolling window; default 30 min, `baselineWindowSec` in the config)
- **EVERY sample feeds the baseline**, regardless of state. The window length does that
  work, not filtering:
  - a long burst does not take the window over — ten minutes of continuous work still
    leaves twenty minutes of quiet samples behind it, and p5 lands in those
  - a machine with a permanently high idle CPU settles on its real floor, because those
    samples count like any others
- **p5, not the minimum** — one anomalous sample must not drag the floor down and turn
  everything above it into "work"
- ~~gating on `BUSY`~~ (learning only from non-busy samples) **did not work out**: on a
  machine with a genuinely high floor it deadlocks — the first sample is classified `BUSY`,
  learning never starts, and the daemon reports "working" forever. A timed escape hatch
  only postpones it. The long window handles both cases with no extra mechanism.
- **threshold** = `max(baseline × thresholdMultiplier, baseline + thresholdDeltaPercent)`
  — `max`, not `min`: the delta is an absolute floor on the jump, otherwise with a
  near-zero baseline every twitch would clear the multiplier
- until at least 10 samples have accumulated the baseline counts as 0, so the threshold is
  the bare delta. Without that, a daemon started mid-burst would calibrate its floor to
  that burst.
- **warmup:** while the baseline is not established, a `BUSY` that rests only on the CPU
  estimate **is not published at all** — nothing is sent rather than a guess. On the
  development machine idle Claude sits at ~1.8 % of one core, above the default delta, so
  without this the daemon would announce "working" for the first twenty seconds of every
  start. Signals that do not need the baseline (OFFLINE, MCP activity, focus) are published
  throughout.
- **known limitation:** a burst longer than the entire window still causes drift. After
  30 minutes of continuous work there is nothing else left in the window and the state
  falls back to `IDLE`. Telling that apart from a permanently high floor is not possible
  without waiting for it to end.
- the parameters live in the `busy` section of the config (§4); `--calibrate` works them
  out

#### `--calibrate` is two-phase

One undirected minute cannot tell idle from busy. On the first single-phase run the "idle
floor" came out at 1.69 % purely because Claude never went quiet during that minute.

```
phase 1 (30 s): "Leave Claude alone, do not type anything to it."        -> the floor
phase 2 (60 s): "Send it a long prompt and let it generate the answer."  -> the ceiling

floor     = p5 of phase 1     (the same percentile the daemon uses at runtime)
threshold = floor + 0.4 × (median of phase 2 − floor)
```

When **the median of phase 2 < 1.5 × the floor**, the result is not marked valid and the
report says phase 2 most likely did not happen. Likewise when the median of phase 2 is
essentially zero — with a floor near zero the ratio rule is satisfied vacuously, and
"I measured nothing at all" would pass as a valid calibration.

The values it emits must round-trip through the config validator, and a test enforces that.
The two drifted apart once already, and the calibrator went on printing a block its own
validator would have rejected.

This is the first step after installing — see the README.

**Sampling is adaptive, not fixed at 2 s:** `BUSY`/`TOOL`/`ACTIVE` → 2 s, `IDLE` → 10 s,
`OFFLINE` → 30 s. Spawning PowerShell every 2 s is ~1800 processes an hour and the daemon
would burn the very CPU it is trying to measure; Discord will not accept presence updates
faster than 15 s anyway. `pollIntervalMs` from the config is a **lower bound**, not a fixed
period.

**Known false positive:** scrolling, playing video and loading a large chat all consume CPU
too. Document it in the README; do not hide it.

#### `mcpActivity` outranks CPU

During agentic work, movement in `mcp-server-*.log` is **more direct evidence of activity
than an estimate from the processor**, so it is evaluated first and holds `BUSY` open even
when CPU has dropped below the exit threshold. Without that, a long tool call (waiting on
the network, no CPU) would flicker back to `IDLE`.

### Mapping onto the Discord presence

| Field              | Content                                                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `details` (line 1) | `Claude Desktop — <status>`, where status is `Working…` / `Active chat` / `Idle` / `Tool: <name>`. The "Claude Desktop" prefix is deliberate: the presence header shows the application name (`C.L.A.U.D.E`), so the real name has to be carried by this line.                                      |
| `state` (line 2)   | Rotates every 20 s between: `Usage 5h: 55 %`, `Version 1.46388.4.0`, `MCP: 22 servers` (only the items enabled in the config)                                                                                                                                                                       |
| `startTimestamp`   | The **oldest** `StartTime` across all `claude.exe` processes, **frozen until the transition to `OFFLINE`** → Discord shows an elapsed counter. The main window's process start must not be used: a renderer restart changes its PID, the timestamp would jump, and Discord would reset the counter. |
| `largeImageKey`    | `claude_logo`                                                                                                                                                                                                                                                                                       |
| `largeImageText`   | `Claude Desktop 1.46388.4.0`                                                                                                                                                                                                                                                                        |
| `smallImageKey`    | `busy` / `idle`                                                                                                                                                                                                                                                                                     |
| `buttons`          | Optionally a link to the repository. **Note: you cannot see your own buttons on your own profile, only other people can.**                                                                                                                                                                          |

> **The strings are not in the code.** Every string in this table lives in the `text`
> section of `config.json` (§4), so anyone can translate it. English is the default in
> `config.example.json`; the README shows a Czech example. Placeholders in braces (`{app}`,
> `{status}`, `{tool}`, `{percent}`, `{version}`, `{count}`) are substituted at render
> time. Anything over Discord's 128-character limit is trimmed with an ellipsis.

### Rate limiting — do not skip this

Discord **throttles** presence updates. Set the minimum interval between `setActivity`
calls to **15 seconds** and keep the last payload sent internally — if nothing changed,
send nothing at all. Without this, Discord starts dropping updates and it looks like a bug
in the code.

---

## 4. Repository layout

```
claude-desktop-presence/
├─ src/
│  ├─ index.ts               # entrypoint, main loop, graceful shutdown
│  ├─ config.ts              # loading + validating config.json, defaults
│  ├─ calibrate.ts           # --calibrate: the two-phase measurement
│  ├─ discord/
│  │  ├─ client.ts           # connection, reconnect backoff, rate-limit gate
│  │  └─ presence.ts         # state → payload, second-line rotation
│  ├─ sources/
│  │  ├─ process.ts          # finding claude.exe, startTime, CPU sampling
│  │  ├─ focus.ts            # GetForegroundWindow → PID → is it Claude?
│  │  ├─ logs.ts             # log directory detection, tail with offset, extractors
│  │  └─ planUsage.ts        # parsing plan-usage-history.json, newest sample
│  ├─ state.ts               # state machine + hysteresis
│  └─ log.ts                 # the daemon's own logging
├─ config.example.json
├─ scripts/install-autostart.ps1
├─ scripts/minimal.mjs
├─ .github/workflows/release.yml
├─ README.md / README.cs.md
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
    "statusBusy": "Working…",
    "statusTool": "Tool: {tool}",
    "statusActive": "Active chat",
    "statusIdle": "Idle",
    "planUsageShortWindow": "Usage 5h: {percent} %",
    "planUsageLongWindow": "Usage 7d: {percent} %",
    "appVersion": "Version {version}",
    "mcpServerCount": "MCP: {count} servers",
    "largeImageText": "{app} {version}"
  },
  "buttons": [],
  "logDirOverride": null,
  "debug": false
}
```

Notes on the schema:

- `pollIntervalMs` is a **lower bound** on sampling, not a fixed period — see the adaptive
  interval in §3.
- The `busy` section replaced the removed `busyCpuThresholdPercent` field. The values are
  not guessed by hand; `--calibrate` produces them. The unit of `thresholdDeltaPercent` is
  **percent of one core**.
- The whole `text` section is optional; missing keys fall back to the English defaults
  above.
- The `planUsage*` keys are deliberately neutral. What windows `u.fh` and `u.sd` cover is a
  derivation, not a documented API, and the code has to survive that changing; only the
  strings a person reads say 5h and 7d.
- An unknown key is not fatal — it produces a warning with a suggestion ("did you mean…"),
  so a typo is not silently ignored while an older daemon still tolerates a newer config.
- `buttons` is an array of at most two `{ label, url }`. **You cannot see your own buttons
  on your own profile, only other people can** — before declaring it broken, have someone
  else look at your profile.

### Where the config is looked up

In this order; first match wins:

1. `--config <path>` on the command line (a directory is accepted too)
2. the directory of the `.exe`, when packaged with `pkg`
3. the directory of the entry module

**Never `cwd`.** The daemon runs as a Scheduled Task, where the working directory is
typically `C:\Windows\System32` — it would look for the config there and, worse, write the
template there.

---

## 5. Privacy — a hard rule

The daemon **never reads conversation content**. State this explicitly in the repository
and in the README:

- Only lines matching a **whitelist of regexes** are extracted from the logs; nothing else
  is processed or passed anywhere.
- Do not touch `%APPDATA%\Claude\Local Storage`, `IndexedDB`, `Network\Cookies`, `sentry\`
  or OAuth tokens. Anthropic additionally prohibits using account OAuth tokens in other
  products.
- Never send to Discord: chat names, file paths, the `org` UUID from
  `plan-usage-history.json`, or usernames.
- The daemon's own log contains extracted values and errno codes only — never a raw line
  from a Claude Desktop log.
- Keep `show.*` switches in the config so anyone can turn off even the usage percentage.

---

## 6. Build prompts

A historical record of how this was built, kept because the reasoning behind each step is
usually more useful than the resulting code. Each was run in turn, with a report back
before the next one started. Where a later measurement invalidated an earlier instruction,
the correction is recorded in place rather than silently rewritten.

---

### P0 — bootstrap

```
Set up a new TypeScript project `claude-desktop-presence` — Node 20+, ESM, strict tsconfig,
build through tsup into dist/, eslint + prettier. Target platform is Windows.

Dependencies: @xhayper/discord-rpc, zod (config validation).
Dev: typescript, tsup, @types/node, vitest.

NOTE: pidusage was here originally but was dropped — on Windows it reaches for `wmic`,
which does not exist on the target machine (§0). CPU comes from PowerShell, see P2.

Create the file skeleton following the layout above (empty modules with exported types and
TODO comments for now, no logic).

Add config.example.json, .gitignore, LICENSE (MIT). Do not write the README yet.
```

---

### P1 — config

```
Implement src/config.ts.

Loads config.json; when it does not exist, copies config.example.json and reports that the
user has to fill in clientId.

Schema (zod), with these defaults:
  clientId: string, required, must be 17-20 digits
  pollIntervalMs: number, default 2000, min 500
  presenceMinIntervalMs: number, default 15000, min 15000  <- Discord throttles; do not
                                                              allow anything under 15 s
  busy: { baselineWindowSec (default 1800, min 600 — a shorter window does not survive a
          long burst), baselinePercentile (default 5, 1-50), thresholdMultiplier
          (default 3, min 1), thresholdDeltaPercent (default 1.5, percent of ONE core),
          exitFactor (default 0.6, 0.1-1) }
  show: { planUsage, appVersion, mcpServerCount, toolNames, elapsedTime } — all boolean,
         default true
  text: see the `text` section in §4 — all strings, English defaults
  logDirOverride: string | null, default null
  debug: boolean, default false

The config path is resolved per §4 ("Where the config is looked up") — --config <path>
wins, then the .exe directory under pkg, then the entry module directory. Never cwd.

On an invalid config print a readable error (not a zod stack trace) and exit with code 1.
Write vitest tests.
```

---

### P2 — process detection and CPU

```
Implement src/sources/process.ts.

export type ClaudeProcessInfo = {
  running: boolean;
  mainPid: number | null;      // the process with a non-empty window title
  allPids: number[];
  startTime: Date | null;      // the oldest StartIso, frozen — see below
  cpuPercent: number;          // summed across all processes, percent of ONE core
};

Verified facts about the target system:
- The process is called `claude.exe` (Electron: main, gpu, renderer, utility...).
  THE COUNT IS NOT CONSTANT — 12, 16 and 17 have all been observed. Never hardcode it;
  always iterate over whatever the query returns.
- The main window has MainWindowTitle == "Claude"; the others are empty.
- Do not rely on the install path — it is an MSIX package under
  C:\Program Files\WindowsApps\Claude_<version>_x64__<hash>\, which changes with every
  version.
- `wmic` DOES NOT EXIST on this machine (Microsoft removed it from Windows 11), so NO
  pidusage — that is what it reaches for.

One PowerShell query returns everything at once (verified on the target machine):

  Get-Process claude -ErrorAction SilentlyContinue |
    Select-Object Id, MainWindowTitle,
      @{n='StartIso';e={$_.StartTime.ToUniversalTime().ToString('o')}},
      @{n='CpuMs';e={$_.TotalProcessorTime.TotalMilliseconds}} |
    ConvertTo-Json -Compress

- Run it with -NoProfile -NonInteractive and **force UTF-8 output** (paths contain
  diacritics; without it you get mojibake).
- StartTime must be formatted to ISO inside PowerShell; ConvertTo-Json would otherwise emit
  it as /Date(1788649144131)/.
- ConvertTo-Json returns an OBJECT for a single process and an array for several →
  normalise to an array.
- Compute the CpuMs delta only from PIDs present in BOTH consecutive samples. CpuMs is
  cumulative since process start, so a renderer that vanished would otherwise produce a
  negative delta, and a new process a fake spike.
- cpuPercent = delta CpuMs / delta wall-clock ms * 100. THE UNIT IS "PERCENT OF ONE CORE";
  do NOT divide by the core count (§3) and allow the value to exceed 100. Still read
  [Environment]::ProcessorCount once at startup, but only for the --calibrate output.
- Moving average over the last 5 samples.
- Adaptive interval per SAMPLE_INTERVAL_MS (§3): BUSY/TOOL/ACTIVE 2 s, IDLE 10 s,
  OFFLINE 30 s. pollIntervalMs from the config is a lower bound, not a fixed period.
- startTime = the OLDEST StartIso across all processes, frozen until the transition to
  OFFLINE. A newer "oldest" start means the application restarted → accept it.
- Sampling must not block the main loop or allow overlapping queries.

Write tests with simulated samples — especially a vanished PID, a single process (object
instead of array), and an application restart (a new oldest StartIso).
```

---

### P3 — window focus

```
Implement src/sources/focus.ts — is the Claude window in the foreground?

export async function isClaudeFocused(claudePids: number[]): Promise<boolean>

Use Win32 GetForegroundWindow + GetWindowThreadProcessId. Prefer no native addons (no
node-gyp — it would break the `pkg` build). Either through `koffi` (FFI, works with pkg),
or through a short PowerShell with Add-Type.

If it cannot be determined, return false and log a warning — focus is nice-to-have, the
daemon has to work without it.
```

---

### P4 — logs

```
Implement src/sources/logs.ts.

IMPORTANT — verified on a real installation on 2026-09-06:
- The live directory is `%LOCALAPPDATA%\Claude\Logs` (capital L).
- `%APPDATA%\Claude\logs` is a leftover from the update; it still exists and still holds
  old files. It must not be used.
- Choose the directory by taking whichever candidate (plus logDirOverride) has the newest
  `main.log` mtime. Check at startup and then every 5 minutes.

Implement a tail with a persistent byte offset. A file that shrank means rotation; reset
the offset to 0. Read as UTF-8.

Extractors (a whitelist of regexes; nothing else is processed — for privacy):

1) appVersion — from main.log, pattern: Claude_(\d+\.\d+\.\d+\.\d+)_x64__
   First match wins, then cache it.

2) recentTool — from main.log, pattern:
   Received permission response for [\da-f-]+: \w+ \(tool: ([\w:.\-]+)\)
   Valid for 30 s after capture, then it expires.
   NOTE: this line is produced ONLY when the user clicks through a tool permission dialog,
   not on every call. Do not treat it as a reliable source.

3) mcpServerCount — from main.log, pattern:
   mcpServerStatus returned (\d+) servers

4) mcpActivity — the mtime of `mcp-server-*.log` files in the log directory.
   Return true if any of them changed in the last 10 s.

Explicitly DO NOT implement parsing tools/call out of mcp.log — this was checked, and in
this version tool invocations are not written there (only tools/list, prompts/list,
resources/list). If Anthropic adds it later, it can be added here.

Three additions to the above:

a) On the first open of main.log, DO NOT process the whole backlog. The file is 4 MB on the
   target machine, and yesterday's "Received permission response ... (tool: X)" would set
   recentTool the moment the daemon boots. Instead: scan the last ~256 kB once for the
   static values (appVersion, mcpServerCount), then set the offset to the end of the file
   and tail live from there.

b) Claude Desktop holds main.log open for writing. Open read-only and expect reads to fail
   occasionally (EBUSY/EACCES) — log it and try again next time, never crash.

c) mcpActivity now outranks CPU in state.ts, so it matters more than it used to: check the
   mtime of mcp-server-*.log files on every tick (fs.stat is cheap), not only when the logs
   are read.
```

---

### P5 — plan usage

```
Implement src/sources/planUsage.ts.

File: %APPDATA%\Claude\plan-usage-history.json  (it stayed in Roaming; it did not move!)

Verified format:
{"version":2,"samples":[{"t":1786058038582,"org":"<uuid>","u":{"fh":55,"sd":22}}]}

- `t` = epoch ms, `u.fh` and `u.sd` = percentages over two different windows.
- Take only the LAST sample by `t`.
- Never send the `org` UUID anywhere — it is an organisation identifier. It MUST NOT leave
  the module, not even into the daemon log. The cheapest guarantee is never reading it.
- **Do not read it on every tick.** The file is updated on the order of minutes → a 60 s
  interval with a cached value in between.
- **The file grows.** 51.5 kB when measured, plus a sample every few minutes. Past 5 MB,
  read only a tail block and find the last COMPLETE sample object in it, instead of parsing
  the whole file.
- **The write is not necessarily atomic** → parse inside try/catch and on failure return
  the last known value, not null. Distinguish "the file does not exist" (→ null) from "it is
  being written right now" (→ last known).
- **The meaning of `fh`/`sd` is a derivation, not a documented API.** Name them neutrally in
  the CODE and in the config KEYS (`shortWindowPercent` / `longWindowPercent`,
  `planUsageShortWindow` / `planUsageLongWindow`) so the code survives a format change. The
  default STRINGS may be readable ("Usage 5h", "Usage 7d"). Write down where the derivation
  comes from in the README.

Signature:
  export interface PlanUsage { shortWindowPercent: number; longWindowPercent: number; at: Date }
  export async function readPlanUsage(): Promise<PlanUsage | null>
```

---

### P6 — state machine and Discord

```
Implement src/state.ts, src/discord/client.ts and src/discord/presence.ts.

state.ts — states OFFLINE | IDLE | ACTIVE | BUSY | TOOL, transitions in THIS order:
  process not running                → OFFLINE
  mcpActivity == true                → BUSY   (and TOOL if recentTool is fresh)
  cpuPercent > threshold             → BUSY   (and TOOL if recentTool is fresh)
  window focused                     → ACTIVE
  otherwise                          → IDLE
mcpActivity comes BEFORE CPU deliberately and holds BUSY open even below the exit
threshold — see §3.
The threshold is not a constant but the self-calibration from the `busy` config section.
Hysteresis: leave BUSY only once cpuPercent drops below threshold * exitFactor.

client.ts — connection through @xhayper/discord-rpc.
  - When Discord is not running, DO NOT CRASH. Retry with exponential backoff
    (5s → 10s → 30s → max 60s) and keep collecting state in the meantime.
  - Rate-limit gate: setActivity must not be called more often than presenceMinIntervalMs,
    and when the new payload is identical to the last one sent, do not send it at all.
  - On OFFLINE call clearActivity().
  - On SIGINT/SIGTERM: clearActivity() + destroy() + clean exit.

presence.ts — mapping state onto the payload:
  details:  take the strings from config.text (statusBusy / statusTool / statusActive /
            statusIdle), composed into config.text.detailsFormat — do not hardcode them
  state:    rotate every 20 s between the enabled items from config.show
  startTimestamp: the process start time, only when show.elapsedTime
  largeImageKey "claude_logo", largeImageText "Claude Desktop <version>"
  smallImageKey: "busy" for BUSY/TOOL, otherwise "idle"

Respect Discord's limits: details and state are 128 characters max, trim WITH AN ELLIPSIS
rather than hard — the strings come from the config, so a user can make them any length.

The asset keys must match what is uploaded in the Developer Portal: largeImageKey
"claude_logo", smallImageKey "busy" / "idle". A key that was never uploaded renders as
nothing at all, with no error.

The flags that belong with this:
- --no-discord: everything runs, the payload is printed to the console, nothing is sent. It
  saves a great many Discord restarts while debugging.
- --debug: every tick, print the state, cpuPercent, cpuBaseline, cpuThreshold, reason and
  the payload. Those fields are already on StateResult.

Discord may not be running, and when it is, the user may not be logged in. Neither is an
error the daemon can do anything about — handle both with the backoff and keep collecting
state. Test both.
```

---

### P7 — startup, autostart, distribution

```
1) Finish src/index.ts: load the config, run the loop on the adaptive interval, handle
   uncaught exceptions so the daemon does not die (log and continue).
   Add a --debug flag that prints the state to the console every tick.

   WARMUP: while the baseline is not established (< 10 samples), DO NOT PUBLISH a presence
   derived from CPU — publish nothing at all rather than a guess. On the development
   machine idle Claude sits at ~1.8 % of one core, above the default delta; without this
   the daemon would report "working" on every single start. Signals that do not need the
   baseline (OFFLINE, mcpActivity, focus) publish normally. Make the warmup visible in
   --debug.

2) src/log.ts: a rotating daemon log at
   %LOCALAPPDATA%\claude-desktop-presence\daemon.log, 5 MB max, 2 files. Never write the
   contents of Claude Desktop log lines into it — only extracted values and errno codes.

   Resolve the startup ordering: the config is read before the logger exists. Use a
   bootstrap buffer and replay LoadResult.warnings once the logger is built — in production
   there is no console for them to fall back to.

3) scripts/install-autostart.ps1: registers a Scheduled Task at user logon, running in the
   background with no window, with an uninstall parameter (-Uninstall).
   DO NOT use the startup folder — we want no flashing console window.

   Three things that would otherwise fail silently:
   - The task MUST run in the user session (LogonType Interactive). The Discord IPC pipe is
     per-session; a task running as SYSTEM or in session 0 will never see it.
   - Set ExecutionTimeLimit to PT0S (no limit). The 3-day default would kill the daemon.
   - Set the working directory explicitly to the binary's directory — for a Scheduled Task
     it is otherwise C:\Windows\System32, exactly the trap from P1.

4) tsup + @yao-pkg/pkg → a single claude-desktop-presence.exe for win-x64 from the CJS
   build. VERIFY that the packaged .exe actually RUNS — not just that the build succeeded.
   Specifically: koffi loads, the PowerShell fallback works, resolveBaseDir finds the config
   next to the .exe.

   WARNING (verified): koffi loaded through `await import()` DOES NOT LOAD inside the
   packaged .exe ("A dynamic import callback was not specified") and silently falls back to
   the slow path. Use createRequire + tsup shims.
   WARNING 2: pkg-fetch has no prebuilt node20-win-x64 binary for tag v3.6 (404) and will
   try to compile Node from source. Use node22-win-x64.

   GitHub Actions workflow: on a v* tag, build and attach the exe + config.example.json to
   the release. Pin the Node version. `npm ci` must run install scripts (esbuild has a
   postinstall; without it the build fails on a missing binary) — verify that explicitly in
   CI.

5) README.md + README.cs.md — English and Czech, both must contain:
   - calibration as the first step after installing
   - creating the Discord application and uploading the assets (claude_logo, busy, idle),
     including the fact that Discord blocks the name "Claude" and its variants
   - a verification section: how to tell the presence came up; you cannot see your own
     buttons on your own profile, only other people can
   - the warning that BUSY detection is a CPU heuristic, i.e. scrolling or video in the chat
     can trigger it falsely; drift during work longer than the baseline window; the warmup
   - the warning that this rests on undocumented Anthropic paths and formats and that a
     Claude Desktop update can break it (which is exactly what happened on 2026-08-21, when
     the log directory moved from Roaming to Local)
   - a Privacy section: everything the tool does NOT read
   - the verified-signals table from §0 of this specification
   - a note that an unsigned .exe may be flagged by Defender, and how to run from source

6) scripts/minimal.mjs — the minimal variant from §8, carved out as a fallback.
```

---

## 7. Risks to plan for

1. **An undocumented interface.** Anthropic can change the paths and log formats at any
   time — it already happened once, in August 2026. Hence: the directory is detected at
   runtime, every extractor can fail and return `null`, and the daemon has to work even when
   every log extractor fails (falling back to "running / not running" plus elapsed time).
2. **The CPU heuristic is an estimate**, not Claude's actual state. That belongs in the
   README, not in the marketing.
3. **`pkg` and native modules.** Hence `koffi` rather than `ffi-napi`, and hence no
   `node-gyp`.
4. **Antivirus.** An unsigned `.exe` on GitHub will sometimes be flagged by Defender. Plan
   for it, and offer running from source as an alternative.
5. **The Discord rate limit.** The most common mistake in projects like this — the presence
   is updated too often, Discord drops the updates, and it looks like a freeze.

---

## 8. Minimal variant — DONE

Carved out as `scripts/minimal.mjs`: "claude.exe is running → send a presence with an
elapsed timer, otherwise clearActivity". No logs, no CPU, no calibration, no config. Nothing
in it depends on an undocumented path or log format, so an update cannot break it. In the
README as a fallback for people who do not want to calibrate, and as insurance if a Claude
Desktop update breaks the rest.

    node scripts/minimal.mjs <discord-application-id>
