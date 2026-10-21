# Habit Tracker

A month-grid habit tracker in the style of a spreadsheet: habits down the rows,
days across the columns, weekly progress, a daily completion chart, a done/left
donut and a top-10 consistency ranking.

Colours: Neon Maritime `#0038BD`, Amber Ignite `#EF8E01`, Pristine Logic `#EEEEEE`.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup and layout |
| `style.css` | Theme, grid and responsive rules |
| `app.js` | State, maths, charts (inline SVG) and UI |
| `manifest.json`, `sw.js`, `icon-*.png` | Installable / offline support |
| `tools/ui_check.py` | Playwright smoke test (26 checks) + screenshots |

## Data model

```
habits: [{
  id, name,
  goals: { "2026-10": 31 },   // per-month target in days
  log:   { "2026-10-03": true }
}]
```

Stored in `localStorage` under `habit-tracker-v2`. Export/import JSON for backup.
Goal defaults to the number of days in the month; blank/absent = every day.

## Local development

```
python -m http.server 8014 --bind 127.0.0.1
# then open http://127.0.0.1:8014/
python tools/ui_check.py        # smoke test + screenshots into tools/shots/
```

## Garmin sleep sync

`tools/garmin_sync.py` logs into Garmin Connect, reads each night's sleep, and
publishes `garmin-sleep.json` next to the app; the app fetches that file on load and
after the **Sync Garmin** button, and ticks any habit flagged *Auto-fill from Garmin sleep*.

```
C:\Python313\python.exe tools\garmin_sync.py            # fetch + publish + git push
C:\Python313\python.exe tools\garmin_sync.py --no-push  # local file only
C:\Python313\python.exe tools\garmin_sync.py --threshold 7.5 --include-hours
```

- Credentials: `~/.hermes/garmin.json` → `{"email", "password", "threshold_hours"}`.
  Garth tokens are cached in `~/.hermes/garmin_tokens`, so MFA is only needed once.
- Default window is the current month plus the previous one; a missed run self-heals
  because every run refetches the whole window.
- Scheduled task **Habit Tracker Garmin Sync** (Windows Task Scheduler) runs it daily
  at 09:00. `Start-ScheduledTask -TaskName 'Habit Tracker Garmin Sync'` runs it on demand.
- Nights with no Garmin record (watch off) or naps only produce no tick — by design.
- `garmin-sleep.json` is public on Pages: it carries per-night booleans only. Add
  `--include-hours` and it also carries durations (think before enabling).

## Deploy

Live: **https://abhinavmanocha.github.io/habit-tracker/** (GitHub Pages, `main` branch root).

Push to `main` and Pages rebuilds; verify the build with
`gh api repos/abhinavmanocha/habit-tracker/pages/builds/latest --jq .status`.

Cloudflare Pages is the intended long-term host but `wrangler login` cannot work on
this PC (its localhost OAuth callback server never binds). With a Pages:Edit API token
in `.cf-token`:

```
./deploy.sh          # or: npx wrangler@4 pages deploy . --project-name habit-tracker --branch main
```

