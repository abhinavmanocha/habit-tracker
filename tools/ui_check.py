"""Browser smoke test for the habit tracker (Playwright, Chromium).

Usage: python tools/ui_check.py [base_url]
Checks: empty state, starter habits, ticking maths, persistence, add/edit/
delete, month navigation, console errors. Saves screenshots to tools/shots/.
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8014/"
SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
os.makedirs(SHOTS, exist_ok=True)

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS  " if cond else "FAIL  ") + name + (("  -> " + str(detail)) if detail and not cond else ""))


def run(page):
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())

    # Mock the published Garmin sleep file so the sync path is testable offline.
    import datetime
    import json as _json
    today = datetime.date.today()
    yesterday = today - datetime.timedelta(days=1)
    days = {today.isoformat(): True, yesterday.isoformat(): True}
    if today.day > 1:
        days[today.replace(day=1).isoformat()] = False
    garmin_fixture = {
        "generated": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "threshold_hours": 7,
        "days": days,
    }
    page.route("**/garmin-sleep.json*", lambda route: route.fulfill(
        status=200, content_type="application/json", body=_json.dumps(garmin_fixture)))

    page.goto(BASE, wait_until="networkidle")
    page.evaluate("localStorage.clear()")
    page.reload(wait_until="networkidle")

    check("empty state shown", page.locator(".empty").count() == 1)
    check("no console errors on load", not console_errors, console_errors)

    # ---- starter habits ----
    page.get_by_role("button", name="Load starter habits").click()
    page.wait_for_timeout(200)
    check("7 habit rows rendered", page.locator("#grid tbody tr").count() == 7,
          page.locator("#grid tbody tr").count())
    check("31 day columns", page.locator("#grid thead th.day-h").count() == 31)
    check("week headers 5", page.locator("#grid thead th.week-h").count() == 5)

    # ---- Garmin sleep auto-fill ----
    sleep_row = page.locator("#grid tbody tr", has_text="Sleep 7 hours").first
    check("garmin badge on the sleep habit", page.locator("#grid .badge").count() == 1,
          page.locator("#grid .badge").count())
    check("sync pill reports connected",
          page.locator("#syncState").get_attribute("data-state") == "ok",
          page.locator("#syncState").get_attribute("data-state"))
    check("sleep ticked for today from Garmin",
          "on" in (sleep_row.locator("button.box").nth(today.day - 1).get_attribute("class") or ""))
    if yesterday.month == today.month:
        check("sleep ticked for yesterday from Garmin",
              "on" in (sleep_row.locator("button.box").nth(yesterday.day - 1).get_attribute("class") or ""))

    # ---- tick the first habit on day 1 and day 2 ----
    row = page.locator("#grid tbody tr").first
    row.locator("button.box").nth(0).click()
    row.locator("button.box").nth(1).click()
    page.wait_for_timeout(120)
    row = page.locator("#grid tbody tr").first
    check("done count = 2", row.locator("td.num").first.inner_text() == "2",
          row.locator("td.num").first.inner_text())
    check("left count = 29", row.locator("td.num.left").inner_text() == "29",
          row.locator("td.num.left").inner_text())
    check("progress shows 2/31", "2/31" in row.locator(".prog-meta").inner_text(),
          row.locator(".prog-meta").inner_text())
    check("overview day1 completed = 1",
          page.locator("#overview tbody tr").first.locator("td.ov-day").first.inner_text() == "1")

    # ---- persistence ----
    page.reload(wait_until="networkidle")
    check("tick persisted after reload",
          page.locator("#grid tbody tr").first.locator("button.box.on").count() == 2,
          page.locator("#grid tbody tr").first.locator("button.box.on").count())

    # ---- add habit ----
    page.click("#addBtn")
    page.fill("#nameInput", "Cold shower")
    page.fill("#goalInput", "10")
    page.click("#saveBtn")
    page.wait_for_timeout(150)
    check("habit added (8 rows)", page.locator("#grid tbody tr").count() == 8)
    last = page.locator("#grid tbody tr").last
    check("new habit goal 10", last.locator(".goal-input").input_value() == "10")
    check("new habit left 10", last.locator("td.num.left").inner_text() == "10")
    check("new habit appears in top10 list",
          page.locator("#topHabits li").count() == 8, page.locator("#topHabits li").count())

    # ---- rename + goal edit ----
    last.locator(".name-btn").click()
    page.fill("#nameInput", "Cold shower 2 min")
    page.click("#saveBtn")
    page.wait_for_timeout(150)
    check("rename applied",
          page.locator("#grid tbody tr").last.locator(".name-btn").inner_text() == "Cold shower 2 min")
    page.locator("#grid tbody tr").last.locator(".goal-input").fill("5")
    page.locator("#grid tbody tr").last.locator(".goal-input").press("Enter")
    page.wait_for_timeout(150)
    check("goal edit -> left 5",
          page.locator("#grid tbody tr").last.locator("td.num.left").inner_text() == "5",
          page.locator("#grid tbody tr").last.locator("td.num.left").inner_text())

    # ---- donut + chart rendered ----
    check("donut svg present", page.locator("#donut svg").count() == 1)
    check("line chart svg present", page.locator("#lineChart svg").count() == 1)
    check("chart has data path", page.locator("#lineChart path").count() >= 1)

    # ---- month navigation ----
    page.select_option("#monthSel", "8")  # September 2026 = 30 days
    page.wait_for_timeout(150)
    check("September has 30 columns", page.locator("#grid thead th.day-h").count() == 30)
    check("September goal defaults to 30",
          page.locator("#grid tbody tr").first.locator(".goal-input").input_value() == "30",
          page.locator("#grid tbody tr").first.locator(".goal-input").input_value())
    check("October ticks not counted in September",
          page.locator("#grid tbody tr").first.locator("td.num").first.inner_text() == "0")
    page.select_option("#monthSel", "9")
    page.wait_for_timeout(150)
    check("back to October keeps ticks",
          page.locator("#grid tbody tr").first.locator("td.num").first.inner_text() == "2")

    # ---- screenshots (with a realistic demo history so the charts are legible) ----
    page.evaluate("""() => {
      const raw = localStorage.getItem('habit-tracker-v2');
      const data = JSON.parse(raw);
      const now = new Date();
      const y = now.getFullYear(), m = now.getMonth();
      const pad = (n) => String(n).padStart(2, '0');
      const dim = new Date(y, m + 1, 0).getDate();
      data.habits.forEach((h, i) => {
        for (let d = 1; d <= Math.min(dim, now.getDate()); d++) {
          if ((i * 5 + d * 3) % 10 < 6) h.log[y + '-' + pad(m + 1) + '-' + pad(d)] = true;
        }
      });
      localStorage.setItem('habit-tracker-v2', JSON.stringify(data));
      location.reload();
    }""")
    page.wait_for_timeout(900)
    check("demo history drives charts",
          "%" in page.locator("#tileCons").inner_text() and page.locator("#tileCons").inner_text() != "0%",
          page.locator("#tileCons").inner_text())

    page.set_viewport_size({"width": 1440, "height": 1000})
    page.wait_for_timeout(250)
    page.screenshot(path=os.path.join(SHOTS, "desktop.png"), full_page=True)

    mob = page.context.new_page()
    mob.set_viewport_size({"width": 390, "height": 844})
    mob.goto(BASE, wait_until="networkidle")
    mob.wait_for_timeout(400)
    mob.screenshot(path=os.path.join(SHOTS, "mobile.png"), full_page=True)
    mob.screenshot(path=os.path.join(SHOTS, "mobile-top.png"))

    # ---- delete ----
    last = page.locator("#grid tbody tr").last
    last.locator(".name-btn").click()
    page.click("#deleteHabit")
    page.wait_for_timeout(200)
    check("habit deleted (7 rows)", page.locator("#grid tbody tr").count() == 7)

    check("no console errors overall", not console_errors, console_errors)


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(
        viewport={"width": 1440, "height": 1000},
        # Block the service worker: it intercepts fetches (so route mocks are bypassed)
        # and could serve a stale cached build instead of the deployed one.
        service_workers="block",
    )
    pg = ctx.new_page()
    try:
        run(pg)
    except Exception as exc:  # noqa: BLE001 - report, don't crash the whole run
        results.append(("exception", False, repr(exc)))
        print("FAIL  exception: " + repr(exc))
        pg.screenshot(path=os.path.join(SHOTS, "failure.png"), full_page=True)
    browser.close()

failed = [r for r in results if not r[1]]
print("\n%d/%d checks passed" % (len(results) - len(failed), len(results)))
sys.exit(1 if failed else 0)
