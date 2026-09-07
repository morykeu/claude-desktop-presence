# measurements

Raw calibration runs. Drop a `calibration-*.json` here and the generated sections of
README.md, README.cs.md, SPEC.md and SPEC.cs.md come from it.

## Why this directory exists

The streaming measurement of 2026-09-06 was written down as a summary — min, median, p90,
max — and the individual readings were thrown away. When the threshold rule later changed
to key off the p95 of idle and the p5 of work, there was nothing left to compute those
from. `src/measurement.ts` has been carrying a reconstruction ever since: arrays that
reproduce the recorded summary exactly and invent the tails between its anchors, with a
caveat printed in all four documents saying which figures are indicative.

A summary cannot be re-analysed. Readings can. So every run keeps them now.

## Adding a measurement

1. `claude-desktop-presence --calibrate`

   Phase 1: leave Claude alone for thirty seconds. Phase 2: send it a long prompt and let
   it generate for the full minute. The report ends with the path it wrote the readings
   to — `calibration-<timestamp>.json`, next to your `config.json`.

   Check the report before going further. `RESULT NOT USABLE` means phase 2 did not
   happen; `WARNING: idle and working overlap` means it did and still cannot be told
   apart from idle. Neither is worth publishing.

2. Copy that file into this directory.

3. `npm run docs:sync`

All four documents then come from the readings, and the caveat disappears on its own —
a recording has nothing to qualify.

## Notes

- Only files named `calibration-*.json` are picked up.
- With several here, the newest `recordedAt` wins. Older ones are kept as a record.
- A malformed file is an error, not something skipped: skipping it would regenerate the
  documents from the previous measurement while you believed the new one had been used.
- The file holds CPU readings of `claude.exe` and nothing else — no paths, no window
  titles, no conversation content.
