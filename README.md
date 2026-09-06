# claude-desktop-presence

Discord Rich Presence for **Claude Desktop on Windows**. A standalone daemon — it does
not touch Claude Desktop, and it does not need developer mode.

> **Work in progress.** P0–P3 are done: config, process/CPU sampling, the state machine
> and focus detection. The Discord client, the log readers and packaging are still to
> come. Right now the only thing you can actually run is `--calibrate`.

---

## First step after installing: calibrate

**Do this before anything else.** The daemon decides "Claude is working" from CPU usage,
and there is no threshold that is correct on every machine. Measured on the development
machine during real agentic work, Claude Desktop used **3.9 % of one core** — a
hand-picked threshold of 12 % would never have fired once.

```bash
claude-desktop-presence --calibrate
```

It samples for 60 seconds. **Use Claude normally while it runs** — ideally ask it
something long-running, so the measurement sees both idle and busy. At the end it prints
the distribution and a block you can paste straight into `config.json`:

```
CPU used by claude.exe, in percent of ONE core:
  min          0.70 %
  median       2.91 %
  p90          4.07 %
  max          4.71 %
  idle floor   1.69 %  (p10)

BUSY would trigger above 2.64 % of one core.

Paste into config.json:

  "busy": {
    "baselineWindowSec": 300,
    "baselinePercentile": 10,
    "thresholdMultiplier": 1.6,
    "thresholdDeltaPercent": 1,
    "exitFactor": 0.6
  }
```

If it warns that idle and busy are barely distinguishable, you calibrated while Claude
was sitting idle. Run it again while Claude is actually working.

You can skip this — the defaults are reasonable — but then the busy detection is tuned
for someone else's computer, not yours.

### What the numbers mean

- The unit is **percent of one core**, not percent of the machine. Electron is largely
  single-threaded, so dividing by the core count buries the signal in noise. The value
  can go above 100 % when several processes are busy at once.
- The daemon keeps a **rolling idle floor** (the 10th percentile over the last five
  minutes) and calls it BUSY when usage rises above that floor by
  `thresholdMultiplier` times, or by `thresholdDeltaPercent` points — whichever is
  higher. So it adapts to your machine instead of trusting a constant.

---

## Configuration

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
config, with Czech shipped as the default. Translate them to whatever you like.

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
