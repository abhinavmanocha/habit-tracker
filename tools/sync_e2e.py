"""Real two-device sync test against the deployed Worker + live site.

Device A connects and seeds the server; device B (fresh browser context) connects,
pulls A's habits, ticks one, pushes; A pulls and sees the tick. Leaves the server
empty at the end so the user starts clean.

Usage: python tools/sync_e2e.py <sync-key> [site-url]
"""
import json
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

KEY = sys.argv[1].strip()
SITE = sys.argv[2] if len(sys.argv) > 2 else "https://abhinavmanocha.github.io/habit-tracker/"
API = "https://habit-tracker-sync.abhinavmanocha.workers.dev/api/state"
# Cloudflare's edge rejects the default urllib user-agent (403), so identify ourselves.
UA = {"User-Agent": "habit-tracker-sync-test/1.0"}

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
    page.click("#cloudBtn")
    page.fill("#cloudKey", KEY)
    page.click("#cloudSave")
    page.wait_for_timeout(2500)


def fresh(ctx):
    page = ctx.new_page()
    page.on("dialog", lambda d: d.accept())   # confirm() must be accepted, not dismissed
    page.goto(SITE, wait_until="networkidle")
    page.evaluate("localStorage.clear()")
    page.reload(wait_until="networkidle")
    return page


print("resetting server:", reset_server())

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---- device A: seed ----
    ctx_a = browser.new_context(viewport={"width": 1280, "height": 900}, service_workers="block")
    a = fresh(ctx_a)
    a.get_by_role("button", name="Load starter habits").click()
    a.wait_for_timeout(600)
    connect(a)
    a.wait_for_timeout(1500)
    check("A connected", "Synced" in a.locator("#cloudState").inner_text(),
          a.locator("#cloudState").inner_text())

    served = json.load(urllib.request.urlopen(urllib.request.Request(
        API, headers={"Authorization": "Bearer " + KEY, **UA}), timeout=30))
    names = [h["name"] for h in (served.get("payload") or {}).get("habits", [])]
    check("A pushed its 7 habits to D1", len(names) == 7, names)
    check("A's Garmin-sourced sleep habit survived the round trip",
          any(h.get("source") == "garmin-sleep"
              for h in (served.get("payload") or {}).get("habits", [])))

    # ---- device B: fresh browser, should pull A's data ----
    ctx_b = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block")
    b = fresh(ctx_b)
    check("B starts empty", b.locator("#grid tbody tr").count() == 0)
    connect(b)
    b.wait_for_timeout(1500)
    check("B pulled A's habits", b.locator("#grid tbody tr").count() == 7,
          b.locator("#grid tbody tr").count())
    check("B sees the same habit names",
          "Wake up at 9:00" in b.locator("#grid tbody tr").first.inner_text())

    # ---- B ticks today, pushes; A pulls ----
    b.locator("#grid tbody tr").first.locator("button.box").nth(
        __import__("datetime").date.today().day - 1).click()
    b.wait_for_timeout(2600)   # debounce + push
    a.click("#cloudSyncNow")
    a.wait_for_timeout(2000)
    ticked = "on" in (a.locator("#grid tbody tr").first.locator("button.box").nth(
        __import__("datetime").date.today().day - 1).get_attribute("class") or "")
    check("A received the tick B made", ticked)

    # ---- A deletes, B must not resurrect it ----
    a.locator("#grid tbody tr").last.locator(".name-btn").click()
    a.click("#deleteHabit")
    a.wait_for_timeout(2600)
    before = b.locator("#grid tbody tr").count()
    b.click("#cloudSyncNow")
    b.wait_for_timeout(2000)
    after = b.locator("#grid tbody tr").count()
    check("delete propagated to B", after == before - 1, (before, after))

    for page in (a, b):
        page.screenshot(path="tools/shots/sync-%s.png" % ("a" if page is a else "b"), full_page=False)
    browser.close()

print("\nresetting server for a clean start:", reset_server())
print("\n%d failure(s)" % len(failures))
sys.exit(1 if failures else 0)
