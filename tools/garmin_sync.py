"""Push Garmin sleep results into the habit tracker.

Fetches each night's sleep from Garmin Connect and publishes a small JSON file
(``garmin-sleep.json``) next to the app, which the web app reads on load and
uses to tick any habit marked "Sync from Garmin sleep".

Credentials live in ``~/.hermes/garmin.json`` (never in the repo):

    {"email": "...", "password": "...", "threshold_hours": 7}

Usage:
    python tools/garmin_sync.py                 # current month -> publish
    python tools/garmin_sync.py --days 60
    python tools/garmin_sync.py --include-hours  # also publish durations
    python tools/garmin_sync.py --no-push        # write the file only
    python tools/garmin_sync.py --threshold 7.5
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
OUT_FILE = APP_DIR / "garmin-sleep.json"
CONFIG_FILE = Path.home() / ".hermes" / "garmin.json"
TOKEN_DIR = Path.home() / ".hermes" / "garmin_tokens"


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        sys.exit(
            "No Garmin config found.\n"
            "Create %s with:\n"
            '  {"email": "you@example.com", "password": "…", "threshold_hours": 7}\n'
            % CONFIG_FILE
        )
    try:
        cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        sys.exit("Config %s is not valid JSON: %s" % (CONFIG_FILE, exc))
    if not cfg.get("email") or not cfg.get("password"):
        sys.exit("Config %s needs both 'email' and 'password'." % CONFIG_FILE)
    return cfg


def connect(cfg: dict):
    """Log in, reusing saved tokens so MFA is only needed once."""
    from garminconnect import Garmin

    def ask_mfa() -> str:
        if not sys.stdin.isatty():
            sys.exit(
                "Garmin asked for an MFA code but this run is not interactive.\n"
                "Run the sync once from a terminal to store a token."
            )
        return input("Garmin MFA code: ").strip()

    client = Garmin(cfg["email"], cfg["password"], prompt_mfa=ask_mfa)
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    needs_mfa, state = client.login(tokenstore=str(TOKEN_DIR))
    if needs_mfa:
        client.resume_login(state, ask_mfa())
    return client


def sleep_seconds(client, cdate: str) -> int | None:
    """Total sleep for the night that ended on ``cdate`` (local wall date)."""
    try:
        data = client.get_sleep_data(cdate)
    except Exception as exc:  # noqa: BLE001 - a missing night must not abort the run
        print("  %s: request failed (%s)" % (cdate, type(exc).__name__))
        return None
    if not isinstance(data, dict):
        return None
    dto = data.get("dailySleepDTO") or {}
    seconds = dto.get("sleepTimeSeconds")
    if not seconds:
        # Fall back to summing the stages when the summary field is absent.
        stages = [
            dto.get("deepSleepSeconds"), dto.get("lightSleepSeconds"),
            dto.get("remSleepSeconds"),
        ]
        if any(isinstance(s, (int, float)) and s > 0 for s in stages):
            seconds = sum(s or 0 for s in stages)
    return int(seconds) if seconds else None


def build_payload(client, days: int, threshold: float, include_hours: bool) -> dict:
    today = dt.date.today()
    start = today - dt.timedelta(days=days - 1)
    flags: dict[str, bool] = {}
    hours: dict[str, float] = {}

    print("Fetching sleep %s -> %s" % (start.isoformat(), today.isoformat()))
    night = start
    while night <= today:
        key = night.isoformat()
        seconds = sleep_seconds(client, key)
        if seconds:
            hrs = round(seconds / 3600, 2)
            flags[key] = hrs >= threshold
            hours[key] = hrs
            print("  %s  %4.1fh  %s" % (key, hrs, "met" if flags[key] else "short"))
        else:
            print("  %s  no sleep record" % key)
        night += dt.timedelta(days=1)

    payload = {
        "generated": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "threshold_hours": threshold,
        "days": flags,
    }
    if include_hours:
        payload["hours"] = hours
    return payload


def publish(payload: dict, push: bool) -> None:
    OUT_FILE.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    met = sum(1 for v in payload["days"].values() if v)
    print("Wrote %s (%d nights, %d met the %sh target)"
          % (OUT_FILE.name, len(payload["days"]), met, payload["threshold_hours"]))
    if not push:
        return
    stamp = dt.date.today().isoformat()
    try:
        subprocess.run(["git", "-C", str(APP_DIR), "add", OUT_FILE.name], check=True)
        subprocess.run(
            ["git", "-C", str(APP_DIR), "commit", "-q", "-m",
             "chore(garmin): sleep sync %s" % stamp],
            check=True, capture_output=True,
        )
        subprocess.run(["git", "-C", str(APP_DIR), "push", "-q", "origin", "HEAD:main"], check=True)
        print("Pushed to origin/main — Pages will rebuild in ~1 minute.")
    except subprocess.CalledProcessError as exc:
        print("Git publish failed (%s). The JSON is written locally." % exc.returncode)


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync Garmin sleep into the habit tracker.")
    parser.add_argument("--days", type=int, default=dt.date.today().day,
                        help="how many days back to fetch (default: this month so far)")
    parser.add_argument("--threshold", type=float, default=None,
                        help="hours of sleep that count as a tick (default: config or 7)")
    parser.add_argument("--include-hours", action="store_true",
                        help="also publish per-night durations (public file!)")
    parser.add_argument("--no-push", action="store_true", help="write the JSON but don't git push")
    args = parser.parse_args()

    cfg = load_config()
    threshold = args.threshold or float(cfg.get("threshold_hours", 7))
    client = connect(cfg)
    payload = build_payload(client, max(args.days, 1), threshold, args.include_hours)
    if not payload["days"]:
        sys.exit("No sleep data returned — nothing written.")
    publish(payload, push=not args.no_push)


if __name__ == "__main__":
    main()
