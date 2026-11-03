"""Real two-device sync test against the deployed Worker + live site.

Device A (phone viewport) connects and seeds the server; device B (desktop viewport,
fresh context) connects, pulls A's habits, ticks one and pushes; A pulls and sees it.
A deletes a habit and B must not resurrect it. The server is emptied afterwards.

Usage: python tools/sync_e2e.py <sync-key> [site-url]
"""
import datetime
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

KEY = sys.argv[1].strip()
SITE = sys.argv[2] if len(sys.argv) > 2 else "https://abhinavmanocha.github.io/habit-tracker/"
API = "https://habit-tracker-sync.abhinavmanocha.workers.dev/api/state"
# Cloudflare's edge rejects the default urllib user-agent (403), so identify ourselves.
UA = {"User-Agent": "habit-tracker-sync-test/1.0"}
TODAY = datetime.date.today()

failures = []


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond else "  -> %s" % (detail,)))
    if not cond:
        failures.append(name)


def reset_server():
    body = json.dumps({"payload": {"version": 3, "habits": [], "deleted": []}}).encode()
    req = urllib.request.Request(API, data=body, method="PUT", headers={
        "Authorization": "Bearer " + KEY, "Content-Type": "application/json", **UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def connect(page):
    page.click(".tab[data-view=settings]")
    page.wait_for_timeout(350)
    page.click("#cloudBtn")
    page.wait_for_timeout(350)
    page.fill("#cloudKey", KEY)
    page.click("#cloudSave")
    page.wait_for_timeout(2600)


def fresh(ctx):
    page = ctx.new_page()
    page.on("dialog", lambda d: d.accept())   # confirm() must be accepted, not dismissed
    page.goto(SITE, wait_until="networkidle")
    page.evaluate("localStorage.clear()")
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(500)
    return page


print("resetting server:", reset_server())

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---- device A: the phone ----
    ctx_a = browser.new_context(viewport={"width": 412, "height": 915}, is_mobile=True,
                                has_touch=True, service_workers="block")
    a = fresh(ctx_a)
    a.click("#loadStarters")
    a.wait_for_timeout(900)
    connect(a)
    check("A connected", a.locator("#cloudState").get_attribute("data-state") == "ok",
          a.locator("#cloudState").inner_text())

    served = json.load(urllib.request.urlopen(urllib.request.Request(
        API, headers={"Authorization": "Bearer " + KEY, **UA}), timeout=30))
    habits = (served.get("payload") or {}).get("habits", [])
    check("A pushed its 7 habits to D1", len(habits) == 7, [h.get("name") for h in habits])
    check("A's Garmin-sourced sleep habit survived the round trip",
          any(h.get("source") == "garmin-sleep" for h in habits))

    # ---- device B: a fresh desktop browser ----
    ctx_b = browser.new_context(viewport={"width": 1280, "height": 900}, service_workers="block")
    b = fresh(ctx_b)
    check("B starts empty", b.locator("#todayList .row").count() == 0)
    connect(b)
    b.click(".tab[data-view=today]")
    b.wait_for_timeout(600)
    check("B pulled A's habits", b.locator("#todayList .row").count() == 7,
          b.locator("#todayList .row").count())

    # ---- B ticks its first habit, A must receive it ----
    b.locator("#todayList .row").first.locator(".row-toggle").click()
    b.wait_for_timeout(2600)                     # debounce + push
    a.click(".tab[data-view=settings]")
    a.wait_for_timeout(350)
    a.click("#cloudSyncNow")
    a.wait_for_timeout(2000)
    a.click(".tab[data-view=today]")
    a.wait_for_timeout(700)
    check("A received the tick B made",
          "done" in (a.locator("#todayList .row").first.get_attribute("class") or ""))

    # ---- A deletes, B must not resurrect it ----
    before = b.locator("#todayList .row").count()
    a.locator("#todayList .row").last.locator(".row-more").click()
    a.wait_for_timeout(400)
    a.click("#sheetDelete")
    a.wait_for_timeout(2600)
    b.click(".tab[data-view=settings]")
    b.wait_for_timeout(350)
    b.click("#cloudSyncNow")
    b.wait_for_timeout(2000)
    b.click(".tab[data-view=today]")
    b.wait_for_timeout(700)
    after = b.locator("#todayList .row").count()
    check("delete propagated to B", after == before - 1, (before, after))

    a.screenshot(path="tools/shots/sync-phone.png")
    b.screenshot(path="tools/shots/sync-desktop.png")
    browser.close()

print("\nresetting server for a clean start:", reset_server())
print("\n%d failure(s)" % len(failures))
sys.exit(1 if failures else 0)
