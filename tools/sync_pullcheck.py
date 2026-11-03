"""Non-destructive sync check: does a fresh device see the real cloud data?

Loads the live app with empty storage, connects with the sync key, and confirms the
habits stored in D1 appear — without ticking, deleting or pushing anything new.

Usage: python tools/sync_pullcheck.py <sync-key> [site-url]
"""
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

KEY = sys.argv[1].strip()
SITE = sys.argv[2] if len(sys.argv) > 2 else "https://abhinavmanocha.github.io/habit-tracker/"
API = "https://habit-tracker-sync.abhinavmanocha.workers.dev/api/state"
UA = {"User-Agent": "habit-tracker-sync-test/1.0"}

req = urllib.request.Request(API, headers={"Authorization": "Bearer " + KEY, **UA})
with urllib.request.urlopen(req, timeout=30) as r:
    remote = (json.load(r) or {}).get("payload") or {}
remote_names = sorted(h.get("name") for h in (remote.get("habits") or []))
print("cloud habits (%d): %s" % (len(remote_names), remote_names))

failures = []


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond else "  -> %s" % (detail,)))
    if not cond:
        failures.append(name)


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 412, "height": 915}, is_mobile=True,
                              has_touch=True, service_workers="block")
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    page.goto(SITE, wait_until="networkidle")
    page.evaluate("localStorage.clear()")      # no starters: nothing local to merge upward
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(500)

    page.click(".tab[data-view=settings]")
    page.wait_for_timeout(350)
    page.click("#cloudBtn")
    page.wait_for_timeout(350)
    page.fill("#cloudKey", KEY)
    page.click("#cloudSave")
    page.wait_for_timeout(3000)
    check("connected", page.locator("#cloudState").get_attribute("data-state") == "ok",
          page.locator("#cloudState").inner_text())

    page.click(".tab[data-view=today]")
    page.wait_for_timeout(800)
    shown = sorted(page.locator("#todayList .row .row-name").all_inner_texts())
    check("every cloud habit appears on this device", shown == remote_names,
          (len(shown), len(remote_names)))

    page.click(".tab[data-view=month]")
    page.wait_for_timeout(700)
    checked = 0
    rows = page.locator("#monthList .mrow")
    for i in range(rows.count()):
        name = rows.nth(i).locator(".mrow-name").inner_text()
        dots = sorted(int("on" in (rows.nth(i).locator(".strip .dot").nth(d).get_attribute("class") or ""))
                      for d in range(rows.nth(i).locator(".strip .dot").count())).count(1)
        want = len([k for k, v in ((remote.get("habits") or [])[0].get("log") or {}).items() if v])
        if name == (remote.get("habits") or [])[0].get("name"):
            checked = dots
    check("the heatmap picks up ticks from the cloud", checked > 0, checked)
    check("no page errors", not errs, errs[:3])
    browser.close()

print("\n%d failure(s)" % len(failures))
sys.exit(1 if failures else 0)
