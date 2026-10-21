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

## Deploy (Cloudflare Pages)

```
npx wrangler@4 pages deploy . --project-name habit-tracker --branch main
```
