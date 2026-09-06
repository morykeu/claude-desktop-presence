# claude-desktop-presence

Discord Rich Presence for **Claude Desktop on Windows**. A standalone daemon — it does
not touch Claude Desktop, and it does not need developer mode.

> **Work in progress.** P0–P6 are done, so the daemon runs end to end and publishes a
> presence. Still missing: the rotating log file, the autostart script and the packaged
> `.exe` (P7).

---

## First step after installing: calibrate

**Do this before anything else.** The daemon decides "Claude is working" from CPU usage,
and there is no threshold that is correct on every machine. Measured on the development
machine during real agentic work, Claude Desktop used **3.9 % of one core** — a
hand-picked threshold of 12 % would never have fired once.

```bash
claude-desktop-presence --calibrate
```

It runs in **two phases**, about 90 seconds in total, and tells you what to do in each:

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

  idle floor   0.32 %  (p10 of phase 1)
  BUSY above   1.75 %

Paste into config.json:

  "busy": {
    "baselineWindowSec": 300,
    "baselinePercentile": 10,
    "thresholdMultiplier": 5.5,
    "thresholdDeltaPercent": 1.4,
    "exitFactor": 0.6
  }
```

If phase 2 does not come out clearly above the floor, the result is reported as **not
usable** rather than dressed up as a recommendation — that almost always means phase 2
did not really happen. Send a prompt long enough that Claude is still generating when
the phase ends.

You can skip calibration — the defaults are reasonable — but then the busy detection is
tuned for someone else's computer, not yours.

### What the numbers mean

- The unit is **percent of one core**, not percent of the machine. Electron is largely
  single-threaded, so dividing by the core count buries the signal in noise. The value
  can go above 100 % when several processes are busy at once.
- The daemon keeps a **rolling idle floor** (the 10th percentile over the last five
  minutes) and calls it BUSY when usage rises above that floor by
  `thresholdMultiplier` times, or by `thresholdDeltaPercent` points — whichever is
  higher. So it adapts to your machine instead of trusting a constant.
- **Every** sample feeds that floor, whatever it was classified as. The length of the
  window is what stops a long burst taking it over: ten minutes of continuous work still
  leaves twenty minutes of quiet samples behind it. Filtering by state instead deadlocks
  on a machine whose genuine idle CPU is high — the first sample looks busy, learning
  never starts, and the status sticks on "working" forever.
- A burst longer than the **whole** window will still drift back to idle. Telling that
  apart from a permanently high floor would mean waiting for it to end.

---

## Checking that it works

### 1. Dry run, without touching Discord

```bash
claude-desktop-presence --no-discord --debug
```

Nothing is sent anywhere. You get one line per tick plus the payload that _would_ have
gone out:

```
IDLE    cpu=0.00% baseline=0.00% threshold=1.50% reason=idle details="Claude Desktop — Nečinný" state="Vytížení 5h: 39 %"
BUSY    cpu=2.13% baseline=0.00% threshold=1.50% reason=cpu details="Claude Desktop — Pracuje…" state="Vytížení 7d: 30 %"
[no-discord] setActivity {"details":"Claude Desktop — Pracuje…","smallImageKey":"busy",...}
```

Read it as: `state`, then the numbers behind the decision, then what Discord would show.
`reason` tells you which rule fired — `cpu`, `mcp`, `focus`, `idle` or `offline`.

Note how few `setActivity` lines there are compared to tick lines: that is the rate
limiter doing its job. Discord is only updated at most every 15 seconds, and only when
something actually changed.

This mode exists so you do not have to restart Discord twenty times while tuning your
config.

### 2. For real

Start Discord, then start the daemon. Within about fifteen seconds your profile should
show:

- the app name **C.L.A.U.D.E** as the header — Discord rejects any application name
  containing "claude", so that is the closest legal name. This is why the first line
  underneath spells out "Claude Desktop": without it, nobody could tell what the entry
  is.
- **first line**: `Claude Desktop — Nečinný` / `Pracuje…` / `Aktivní chat` /
  `Nástroj: <name>`
- **second line**: cycling every 20 seconds through plan usage, the app version and the
  MCP server count — whichever you left enabled in `show`
- **large icon** `claude_logo`, **small icon** `busy` or `idle`
- an **elapsed timer** counting from when Claude Desktop started

If the icons are missing but the text is there, the asset keys in the Developer Portal do
not match. They have to be named exactly `claude_logo`, `busy` and `idle` — a key that
was never uploaded renders as nothing at all, with no error anywhere.

If nothing appears: check Discord → Settings → Activity Privacy → "Display current
activity as a status message" is on, and that `clientId` in your config is the
Application ID of the app whose assets you uploaded.

### 3. Buttons

**You cannot see your own buttons.** Discord does not render them on your own profile —
only other people see them. If you configured a button and it is missing, ask someone
else to look at your profile before assuming it is broken.

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

1. wherever `--config <path>` points (a directory works too)
2. next to the `.exe`, for a packaged build
3. next to the entry module

Never the current working directory — as a Scheduled Task that would be
`C:\Windows\System32`.

On first run the daemon copies `config.example.json` and asks you to fill in `clientId`.
An unknown key is not an error; you get a warning with a "did you mean" suggestion, so a
typo does not silently fall back to the default.

The presence strings are **not hardcoded** — they are in the `text` section of the
config, with Czech shipped as the default. Translate them to whatever you like; anything
over Discord's 128-character limit is trimmed with an ellipsis rather than cut off.

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

That is good enough to label them "5h" and "7d" in the default presence text, and not good
enough to rely on. So the **keys** stay neutral — `planUsageShortWindow` and
`planUsageLongWindow` in the config, `shortWindowPercent` and `longWindowPercent` in the
code — and only the strings you actually read say 5h and 7d. If a Claude Desktop update
changes what those fields mean, the fix is one line in your config, not a rename through
the whole daemon.

The `org` UUID in that file is an organisation identifier. It is never read, never
cached, never logged and never sent to Discord — see Privacy.

---

## Known limitations

- **The busy detection is a heuristic, not a fact.** Scrolling, playing a video in the
  chat, and loading a long conversation all burn CPU too, and any of them can show up as
  "working". This is documented rather than hidden.
- **The measured baseline is a lower bound.** It was taken during an agentic session,
  which is mostly waiting on the network. Streaming a long answer into the renderer will
  be higher and has not been measured yet.
- **It relies on undocumented paths and log formats.** Anthropic can change them at any
  time, and did: on 2026-08-21 the log directory moved from Roaming to Local. Every
  reader is allowed to fail and return null, and the daemon still works when all of them
  do — it falls back to "running / not running" plus elapsed time.
- **`wmic` is gone from Windows 11**, so `pidusage` does not work here. CPU comes from a
  single PowerShell query instead.

---

## Privacy

The daemon **never reads conversation content**.

- Only lines matching an explicit whitelist of regexes are extracted from the logs.
  Nothing else is processed or forwarded.
- It does not touch `%APPDATA%\Claude\Local Storage`, `IndexedDB`, `Network\Cookies`,
  `sentry\`, or OAuth tokens.
- It never sends chat names, file paths, the `org` UUID from `plan-usage-history.json`,
  or your username to Discord.
- The daemon's own log file contains extracted values only — never a raw line from a
  Claude Desktop log.
- Every field can be switched off individually via `show.*` in the config, including the
  plan usage percentage.

---

## Development

```bash
npm install
npm run build
npm test
```

`npm run lint`, `npm run typecheck` and `npm run format` do what they say. The full
specification, including the verified measurements this is built on, is in `SPEC.md`.

## License

MIT
