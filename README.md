# claude-desktop-presence

Discord Rich Presence for **Claude Desktop on Windows**. A standalone daemon — it does
not touch Claude Desktop, and it does not need developer mode.

> **Work in progress.** P0–P5 are done: config, process/CPU sampling, the state machine,
> focus detection, the log readers and plan usage. The Discord client and packaging are
> still to come. Right now the only thing you can actually run is `--calibrate`.

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

## Plan usage

Claude Desktop keeps `%APPDATA%\Claude\plan-usage-history.json`, which holds two usage
percentages per sample under the keys `fh` and `sd`.

**What those two windows actually are is a guess.** Anthropic documents none of this. The
common reading is that `fh` is a five-hour window and `sd` a weekly one, and it does line
up with what the app shows — but that was checked by eye against the UI, not against any
specification, and an update could change it without warning. The daemon therefore calls
them the **shorter window** and the **longer window** everywhere: in the code, in the
config, and in the default presence text. If you are confident about the reading, put
"5h" and "week" in your own `text` section.

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
