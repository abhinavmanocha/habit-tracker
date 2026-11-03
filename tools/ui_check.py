"""Mobile-first UI suite for the habit tracker.

Runs at the Pixel 10 Pro CSS viewport (412 x 915) with touch enabled and asserts the
behaviour a phone user actually performs: tick today, open a habit, fix a past day,
add/edit/delete, switch tabs, sync.

Usage:
  python tools/ui_check.py                        # local (needs http.server on 8014)
  python tools/ui_check.py https://.../index.html # live
"""
import datetime
import json as _json
import sys

from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8014/"
VP = {"width": 412, "height": 915}
today = datetime.date.today()
yesterday = today - datetime.timedelta(days=1)
DIM = (datetime.date(today.year + (today.month // 12), (today.month % 12) + 1, 1)
       - datetime.timedelta(days=1)).day

checks = 0
failures = []


def check(name, cond, detail=""):
    global checks
    checks += 1
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond else "   -> %s" % (detail,)))
    if not cond:
        failures.append(name)


def is_visible(pg, sel):
    loc = pg.locator(sel)
    return loc.count() > 0 and loc.first.is_visible()


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport=VP, device_scale_factor=2, is_mobile=True,
                              has_touch=True, service_workers="block")
    page = ctx.new_page()
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append("PAGEERROR " + str(e)))
    page.on("dialog", lambda d: d.accept())

    # --- mocks: Garmin nights + the Cloudflare worker -------------------------
    garmin = {"generated": "2026-01-01T08:00:00Z", "threshold_hours": 7,
              "days": {today.isoformat(): True, yesterday.isoformat(): True}}
    page.route("**/garmin-sleep.json*", lambda r: r.fulfill(
        status=200, content_type="application/json", body=_json.dumps(garmin)))

    site = {"payload": None, "puts": 0}

    def worker(route):
        req = route.request
        if req.method == "OPTIONS":
            return route.fulfill(status=204)
        if "test-key" not in (req.headers.get("authorization") or ""):
            return route.fulfill(status=401, content_type="application/json", body='{"error":"unauthorized"}')
        if req.method == "PUT":
            site["payload"] = (req.post_data_json or {}).get("payload")
            site["puts"] += 1
            return route.fulfill(status=200, content_type="application/json", body='{"ok":true}')
        return route.fulfill(status=200, content_type="application/json",
                             body=_json.dumps({"ok": True, "payload": site["payload"]}))

    page.route("**/habit-tracker-sync.abhinavmanocha.workers.dev/**", worker)

    page.goto(SITE, wait_until="networkidle")
    page.evaluate("localStorage.clear()")
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(700)

    # ================= boot & layout invariants =================
    check("opens on the Today tab", is_visible(page, "#view-today"))
    check("month feed is not shown yet", not is_visible(page, "#view-month"))
    check("no console errors on load", not console_errors, console_errors[:3])

    overflow = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    check("no sideways page scroll at 412px", overflow <= 1, overflow)

    # ================= empty state =================
    check("empty state offers starters", is_visible(page, "#loadStarters"))
    page.click("#loadStarters")
    page.wait_for_timeout(1800)
    check("7 habits land on Today", page.locator("#todayList .row").count() == 7,
          page.locator("#todayList .row").count())

    # ================= today: tick / untick =================
    first = page.locator("#todayList .row").first
    name = first.locator(".row-name").inner_text()
    left_before = page.locator("#todayLeft").inner_text()
    was_done = "done" in (first.get_attribute("class") or "")
    first.locator(".row-toggle").click()
    page.wait_for_timeout(400)
    first = page.locator("#todayList .row").first
    now_done = "done" in (first.get_attribute("class") or "")
    check("tapping a row toggles it", now_done != was_done, (was_done, now_done))
    check("the 'left today' line updates", page.locator("#todayLeft").inner_text() != left_before,
          (left_before, page.locator("#todayLeft").inner_text()))
    check("the progress ring renders", page.locator("#todayRing svg circle").count() >= 2)

    # garmin mirroring
    sleep_row = page.locator("#todayList .row", has_text="Sleep 7 hours").first
    check("garmin habit is badged", sleep_row.locator(".badge-garmin").count() == 1)
    check("garmin ticked today for the sleep habit", "done" in (sleep_row.get_attribute("class") or ""))

    # persistence
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(900)
    persisted = "done" in (page.locator("#todayList .row").first.get_attribute("class") or "")
    check("the tick survives a reload", persisted == now_done, (persisted, now_done))

    # ================= tabs =================
    page.click(".tab[data-view=month]")
    page.wait_for_timeout(500)
    check("Month tab shows the month feed", is_visible(page, "#view-month"))
    check("Today is hidden on the Month tab", not is_visible(page, "#view-today"))
    check("active tab is marked", page.locator(".tab[data-view=month]").get_attribute("aria-current") == "page")
    rows = page.locator("#monthList .mrow")
    check("month feed lists every habit", rows.count() == 7, rows.count())
    dots = rows.first.locator(".strip .dot")
    check("each row carries one dot per day of the month", dots.count() == DIM, dots.count())
    strip_overflow = page.evaluate("""() => { const s = document.querySelector('#monthList .strip');
        return s ? s.scrollWidth - s.clientWidth : 0; }""")
    check("the heatmap strip fits without scrolling", strip_overflow <= 1, strip_overflow)

    # ================= habit sheet: fix a past day =================
    rows.first.click()
    page.wait_for_timeout(500)
    check("tapping a month row opens the habit sheet", is_visible(page, "#habitSheet .sheet"))
    check("sheet is titled with the habit", page.locator("#sheetTitle").inner_text() != "")
    cells = page.locator("#sheetCal .cal-day")
    check("calendar shows every day of the month", cells.count() == DIM, cells.count())
    cell_box = cells.first.bounding_box()
    check("calendar days are at least 44px", cell_box["height"] >= 44 and cell_box["width"] >= 44,
          (round(cell_box["width"]), round(cell_box["height"])))

    if today.day >= 2:
        target = 1                                    # a past day, safe to toggle
        before_cls = cells.nth(target - 1).get_attribute("class")
        cells.nth(target - 1).click()
        page.wait_for_timeout(400)
        after_cls = page.locator("#sheetCal .cal-day").nth(target - 1).get_attribute("class")
        check("a past day can be ticked from the sheet", ("on" in after_cls) != ("on" in before_cls),
              (before_cls, after_cls))
        page.click("#sheetClose")
        page.wait_for_timeout(350)
        dot_cls = page.locator("#monthList .mrow").first.locator(".strip .dot").nth(target - 1).get_attribute("class")
        check("the month heatmap reflects that change", "on" in dot_cls, dot_cls)
    else:
        page.click("#sheetClose")
        page.wait_for_timeout(300)

    # ================= add / edit / delete =================
    page.click("#addBtn")
    page.wait_for_timeout(400)
    check("+ opens the editor", is_visible(page, "#scrim .sheet"))
    page.fill("#nameInput", "Stretch 10 min")
    page.fill("#goalInput", "12")
    page.click("#saveBtn")
    page.wait_for_timeout(600)
    page.click(".tab[data-view=today]")
    page.wait_for_timeout(500)
    check("new habit appears on Today",
          page.locator("#todayList .row", has_text="Stretch 10 min").count() == 1)

    page.click(".tab[data-view=month]")
    page.wait_for_timeout(400)
    new_row = page.locator("#monthList .mrow", has_text="Stretch 10 min").first
    check("new habit shows its goal in the month feed", "/12" in new_row.locator(".mrow-num").inner_text(),
          new_row.locator(".mrow-num").inner_text())
    new_row.click()
    page.wait_for_timeout(400)
    page.click("#sheetEdit")
    page.wait_for_timeout(400)
    page.fill("#nameInput", "Stretch 12 min")
    page.fill("#goalInput", "20")
    page.click("#saveBtn")
    page.wait_for_timeout(600)
    renamed = page.locator("#monthList .mrow", has_text="Stretch 12 min")
    check("rename applies", renamed.count() == 1)
    check("goal edit applies", "/20" in renamed.first.locator(".mrow-num").inner_text(),
          renamed.first.locator(".mrow-num").inner_text())

    renamed.first.click()
    page.wait_for_timeout(400)
    page.click("#sheetDelete")
    page.wait_for_timeout(700)
    check("delete removes the habit", page.locator("#monthList .mrow").count() == 7,
          page.locator("#monthList .mrow").count())

    # ================= month navigation =================
    label_now = page.locator("#monthLabel").inner_text()
    page.click("#prevMonth")
    page.wait_for_timeout(400)
    check("previous month changes the label", page.locator("#monthLabel").inner_text() != label_now,
          page.locator("#monthLabel").inner_text())
    page.click("#nextMonth")
    page.wait_for_timeout(400)
    check("next month returns", page.locator("#monthLabel").inner_text() == label_now)
    page.click("#prevMonth")
    page.wait_for_timeout(300)
    page.click("#monthLabel")
    page.wait_for_timeout(400)
    check("tapping the month jumps back to this month", page.locator("#monthLabel").inner_text() == label_now)

    # ================= stats =================
    page.click(".tab[data-view=stats]")
    page.wait_for_timeout(700)
    check("stats tab visible", is_visible(page, "#view-stats"))
    check("tiles are populated", page.locator("#tileTicks").inner_text() != "0",
          page.locator("#tileTicks").inner_text())
    check("line chart drew", page.locator("#lineChart svg path").count() >= 1)
    labels = page.evaluate("""() => [...document.querySelectorAll('#lineChart text.xlab')]
        .map(t => ({ txt: t.textContent, box: t.getBoundingClientRect(), size: parseFloat(getComputedStyle(t).fontSize) }))""")
    check("axis has a few readable labels", 4 <= len(labels) <= 8 and all(l["size"] >= 9 for l in labels),
          [l["txt"] for l in labels])
    overlaps = [(a["txt"], b["txt"]) for a, b in zip(labels, labels[1:])
                if a["box"]["x"] + a["box"]["width"] + 2 > b["box"]["x"]]
    check("axis labels do not overlap", not overlaps, overlaps)
    check("donut drew", page.locator("#donut svg").count() == 1)
    check("consistency list fills", page.locator("#topHabits li").count() >= 5)

    # ================= settings & sync =================
    page.click(".tab[data-view=settings]")
    page.wait_for_timeout(500)
    check("settings tab visible", is_visible(page, "#view-settings"))
    check("disconnect hidden while not connected", not is_visible(page, "#cloudForget"))
    check("sync-now hidden while not connected", not is_visible(page, "#cloudSyncNow"))
    check("garmin pill reports a sync", page.locator("#syncState").get_attribute("data-state") == "ok",
          page.locator("#syncState").inner_text())

    page.click("#cloudBtn")
    page.wait_for_timeout(400)
    page.fill("#cloudKey", "test-key")
    page.click("#cloudSave")
    page.wait_for_timeout(2200)
    pushed = site["payload"] or {}
    check("connect pushes the document", site["puts"] >= 1 and len(pushed.get("habits", [])) == 7,
          (site["puts"], len(pushed.get("habits", []))))
    check("cloud pill turns green", page.locator("#cloudState").get_attribute("data-state") == "ok",
          page.locator("#cloudState").inner_text())
    check("disconnect appears once connected", is_visible(page, "#cloudForget"))

    # another device adds a habit; this one must pull it
    site["payload"]["habits"].append({
        "id": "remote-1", "name": "Remote habit", "goals": {}, "log": {today.isoformat(): True},
        "source": None, "updatedAt": 1
    })
    page.click("#cloudSyncNow")
    page.wait_for_timeout(1800)
    page.click(".tab[data-view=today]")
    page.wait_for_timeout(600)
    check("pulled a habit written on another device",
          page.locator("#todayList .row", has_text="Remote habit").count() == 1)
    check("pulled its tick as well",
          "done" in (page.locator("#todayList .row", has_text="Remote habit").get_attribute("class") or ""))

    # delete must propagate as a tombstone
    page.locator("#todayList .row", has_text="Remote habit").locator(".row-more").click()
    page.wait_for_timeout(400)
    page.click("#sheetDelete")
    page.wait_for_timeout(2400)
    pushed = site["payload"] or {}
    ids = [h.get("id") for h in pushed.get("habits", [])]
    check("delete propagated to the server", "remote-1" not in ids, ids)
    check("tombstone published", any(t.get("id") == "remote-1" for t in pushed.get("deleted", [])))

    # ================= tap targets (last, after all flows) =================
    page.click(".tab[data-view=today]")
    page.wait_for_timeout(500)
    small = page.evaluate("""() => [...document.querySelectorAll('button, input, select')]
        .filter(el => el.offsetParent !== null && !el.closest('[hidden]'))
        .filter(el => !(el.tagName === 'INPUT' && el.closest('label')))   // label is the hit area
        .map(el => { const r = el.getBoundingClientRect();
          return { t: (el.id || el.className || el.tagName).toString().slice(0, 40),
                   w: Math.round(r.width), h: Math.round(r.height) }; })
        .filter(o => o.h > 0 && (o.h < 44 || o.w < 44))""")
    check("every visible control is at least 44px", not small, small[:6])

    check("no console errors overall", not console_errors, console_errors[:4])

    page.screenshot(path="tools/shots/ui-final.png", full_page=True)
    browser.close()

print("\n%d/%d checks passed" % (checks - len(failures), checks))
sys.exit(1 if failures else 0)
