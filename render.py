#!/usr/bin/env python3
"""Render brief.json into the work panel and keep the run history.

Usage: render.py <brief.json> [inputs.json]   -> prints the panel path (work and review_requests come from the inputs)
       render.py --syncing        repaint the last result as "syncing" (run.sh, when a run starts)
       render.py --idle           repaint the last result without it (run.sh, when a run failed)

Writes:
  <output_dir>/index.html          the panel (fixed path; the open page reloads itself when stamp.js changes)
  <output_dir>/stamp.js            what the panel is showing, in one line - polled by the open page
  <output_dir>/runs/<stamp>.json   this run, with `new` flags - the next run's baseline (kept 14 days)
  <output_dir>/.last-run           this run's time, the start of the next window
"""
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

# Sections whose items get a "+NEW" flag when they weren't in the previous run ("done": closed since the last run)
TRACKED = ["queue", "waiting", "highlights", "done"]

here = Path(__file__).parent
config = json.loads((here / "config.json").read_text())
out_dir = Path(config["output_dir"]).expanduser()
runs = out_dir / "runs"
runs.mkdir(parents=True, exist_ok=True)

# Outlook folder paths -> names, so the panel can say which folder a mail link opens (only Inbox mail opens itself)
mail = config.get("mail", {})
MAIL_FOLDERS = {urlparse(u).path.rstrip("/"): n for n, u in
                [(f["name"], f["url"]) for f in mail.get("received_folders", [])]
                + [("Sent", mail.get("sent", "")), ("Deleted", mail.get("deleted", ""))] if u}


def write_panel(data):
    data = {**data, "mail_folders": MAIL_FOLDERS}
    template = (here / "template.html").read_text()
    # The open page polls stamp.js once a minute and reloads only when it changes: new data, the
    # syncing flag, or a new template. Written after index.html, so a reload always gets the new page.
    stamp = hashlib.sha1((template + json.dumps(data, ensure_ascii=False)).encode()).hexdigest()[:12]
    # "</" inside the JSON would close the <script> tag early
    payload = json.dumps({**data, "stamp": stamp}, ensure_ascii=False).replace("</", "<\\/")
    (out_dir / "index.html").write_text(template.replace("__BRIEF_DATA__", payload))
    (out_dir / "stamp.js").write_text(f"window.towerStamp = '{stamp}';\n")


if sys.argv[1] in ("--syncing", "--idle"):
    # Repaint the last result with or without the "syncing" flag. No history, no notification.
    last = sorted(runs.glob("*.json"))
    if last:
        write_panel({**json.loads(last[-1].read_text()), "syncing": sys.argv[1] == "--syncing"})
    sys.exit(0)

brief = json.loads(Path(sys.argv[1]).read_text())
# The run doesn't copy GitHub's "my work" and review requests into the brief; they come straight from the collector.
if len(sys.argv) > 2:
    inputs = json.loads(Path(sys.argv[2]).read_text())
    github = inputs.get("github") or {}
    brief.setdefault("work", github.get("work", []))
    brief.setdefault("review_requests", github.get("review_requests", []))
    # The panel's "Synced" time, .last-run (the next window's start) and the "updated" flags all hang on this.
    # A model guesses the time; the collector knows when it read everything.
    if inputs.get("collected_at"):
        brief["generated_at"] = inputs["collected_at"][:19] + "Z"


def key(item):
    # The wording is rewritten every run; an explicit id (mail conversation) or the link is what stays put.
    return item.get("id") or item.get("url") or item.get("title") or item.get("what")


previous = sorted(runs.glob("*.json"))
brief["first_run"] = not previous   # nothing to diff against: the page skips "since last run"
if previous:
    prev = json.loads(previous[-1].read_text())
    for section in TRACKED:
        seen = {key(i) for i in prev.get(section, [])}
        for item in brief.get(section, []):
            item["new"] = key(item) not in seen
            # Already on the panel, but something happened on it since (a nudge, a reply that
            # didn't close it). Without this, an item that moved looks exactly like one that didn't.
            item["updated"] = (not item["new"]
                               and item.get("last_activity", "") > prev.get("generated_at", ""))

# The panel is pull; push only what can't wait - a new high-urgency item.
urgent = [q for q in brief.get("queue", []) if q.get("new") and q.get("urgency") == "high"]
if urgent:
    title = urgent[0]["title"] if len(urgent) == 1 else f"{len(urgent)} new urgent items"
    subprocess.run(["osascript", "-e", "on run argv", "-e",
                    "display notification (item 2 of argv) with title (item 1 of argv) sound name \"Glass\"",
                    "-e", "end run", "Meta-Nav", title], check=False)

stamp = datetime.now().strftime("%Y%m%d-%H%M")
(runs / f"{stamp}.json").write_text(json.dumps(brief, ensure_ascii=False, indent=1))
# Only the latest run is ever read back; two weeks is plenty for looking into a bad call.
cutoff = (datetime.now() - timedelta(days=14)).strftime("%Y%m%d")
for old in runs.glob("*.json"):
    if old.stem[:8] < cutoff:
        old.unlink()

write_panel(brief)
out = out_dir / "index.html"
(out_dir / ".last-run").write_text(brief["generated_at"])
print(out)
