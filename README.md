# Habits

A phone-first daily habit tracker. Open it, see today, tap what you did.
Live: **https://abhinavmanocha.github.io/habit-tracker/**

## The four tabs

| Tab | What it is for |
|---|---|
| **Today** | One row per habit. Tap a row to tick it. Ring shows today's progress; rows show streaks and a Garmin badge. |
| **Month** | Every habit with a 30/31-dot heatmap of the month, done/goal, and a progress bar. Tap a row for details. |
| **Habit sheet** | Full month calendar, one button per day, all ≥ 44 px — this is how you fix a day you forgot. Edit / Delete live here. |
| **Stats** | Ticks, consistency, perfect days, daily completion chart, month-to-date donut, most-consistent list. |
| **Settings** | Cloud sync key, Garmin sync, JSON export/import. |

The app bar holds month navigation (`‹ Month Year ›`); tapping the month name jumps back to
the current month. The month arrows never change which tab you are on except from **Today**,
where they switch you to **Month** (changing month on a "today" screen would be meaningless).

## Design rules (keep these)

- **Mobile is the product.** Target viewport is 412 × 915 (Pixel 10 Pro). Nothing may
  scroll sideways; every visible control is at least 44 × 44 px.
- The month is a **heatmap strip**, not a 31-column table. The old grid needed 1014 px of
  horizontal scrolling inside a 336 px viewport and its day boxes were 17 px — unusable.
- Dark mode follows `prefers-color-scheme`; the bottom bar respects
  `env(safe-area-inset-bottom)` with `viewport-fit=cover`.
- Only the active view is rendered. `showView()` re-renders on switch, so a hidden tab is
  never stale when you arrive.
- `[hidden] { display: none !important; }` exists because `.btn { display: inline-flex }`
  beats the `hidden` attribute — without it, "Disconnect" and "Sync now" showed up while
  sync was off.

## Data

```js
localStorage['habit-tracker-v2'] = {
  version: 3,
  habits: [{ id, name, goals: {"2026-11": 30}, log: {"2026-11-03": true}, source: 'garmin-sleep' | null, updatedAt }],
  deleted: [{ id, updatedAt }]        // tombstones so deletes survive a sync merge
}
```

A missing goal means "every day of that month". Export/import is the offline backup and
carries the tombstones too.

## Sync

Cloudflare Worker + D1, one JSON document per household.

- Worker `habit-tracker-sync` → `https://habit-tracker-sync.abhinavmanocha.workers.dev`
- D1 `habit-tracker-sync` (`6e41733f-f658-4004-8077-46d8a996f527`)
- `GET /api/state`, `PUT /api/state`, `GET /health`; bearer `SYNC_KEY`; CORS locked to the
  Pages origin and localhost.
- Ticks are unioned, metadata is last-write-wins by `updatedAt`, deletes are tombstones.
- The key lives in `localStorage['ht-sync-key']` per device; pushes are debounced 1.5 s,
  pulls happen on load, on focus, and via **Sync now**.

```
cd sync-worker && cf deploy --secrets-file .env.sync     # .env.sync is gitignored
```

## Garmin sleep

`tools/garmin_sync.py` (Windows task **Habit Tracker Garmin Sync**, daily 09:00) logs into
Garmin, reads `sleepTimeSeconds` per night, writes `garmin-sleep.json` (booleans only) and
pushes it. The app mirrors those nights onto every habit with `source: 'garmin-sleep'`.

## Tests

```
/c/Python313/python.exe tools/ui_check.py                       # 53 checks, Pixel viewport
/c/Python313/python.exe tools/ui_check.py https://abhinavmanocha.github.io/habit-tracker/
/c/Python313/python.exe tools/sync_pullcheck.py <key>           # read-only: does a new device see the cloud?
/c/Python313/python.exe tools/sync_e2e.py <key>                 # destructive, refuses if the DB has habits
```

`ui_check.py` mocks both `garmin-sleep.json` and the Worker, drives every flow, and ends by
asserting no control is under 44 px and the page never scrolls sideways.

## Files

```
index.html  app.js  style.css   the app (no build step)
manifest.json  sw.js  icon-*.png   installable + offline
garmin-sleep.json               published Garmin nights
sync-worker/                    Cloudflare Worker + D1 binding
tools/                          garmin_sync.py, ui_check.py, sync_e2e.py, sync_pullcheck.py
```
