#!/usr/bin/env python3
"""Meta-Nav's click store: the panel's "done", "resolved" and "Got it" clicks, kept in one file that every
browser and every run share.

A page opened from disk can read files beside it but can't write any, so this small service writes for it.
It listens on 127.0.0.1 only; launchd starts it at login and restarts it if it stops (metanav-state.plist; on Windows, a Task Scheduler task).

  POST /state   {"key": "tower:dismissed" | "tower:read", "value": {...}}   -> the whole state, as JSON
  POST /signin  {"source": "Azure DevOps" | "Outlook" | "Teams"}          -> {"status": "started" | "busy"}
                The banner's SIGN IN button. It runs outside the terminal, so the sign-in page can open (see sign_in).
  POST /refresh {}                                                         -> {"status": "started" | "busy"}
                The panel's SYNC button: a run now, whatever the hour (busy if one is running, or a sign-in window is open).

Writes:
  <output_dir>/state.json   read by each run (SKILL.md, step 5)
  <output_dir>/state.js     the same, loaded by the page with a <script> tag (a page on disk can't fetch files)
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

PORT = 47615
KEYS = ("tower:dismissed", "tower:read")

here = Path(__file__).parent
out_dir = Path(json.loads((here / "config.json").read_text(encoding="utf-8"))["output_dir"]).expanduser()
STATE = out_dir / "state.json"

WINDOWS = sys.platform == "win32"
if WINDOWS:
    # Task Scheduler runs this as the user, so the PATH is already the user's
    ENV = dict(os.environ)
    CHROME = next((c for c in (os.path.join(os.environ.get(v, ""), "Google", "Chrome", "Application", "chrome.exe")
                               for v in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")) if os.path.exists(c)),
                  shutil.which("chrome") or "chrome")
    CACHE = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "metanav"
else:
    # launchd gives a bare PATH; az lives in Homebrew. BROWSER=open: Python's default way to open a browser is
    # AppleScript, which macOS stops when it comes from a terminal app - `open` always works.
    ENV = {**os.environ, "BROWSER": "open",
           "PATH": f"{Path.home()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}
    CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    CACHE = Path.home() / "Library/Caches/metanav"
# The scheduled runs' own browser profile, as collect.mjs opens it (named after the output dir)
PROFILE = CACHE / f"chrome-{hashlib.sha256(str(out_dir.resolve()).encode()).hexdigest()[:7]}"
# The scheduled job that runs Meta-Nav (launchd's metanav.plist, or the Task Scheduler task), named after the skill's folder
JOB = f"local.{here.name}" if not WINDOWS else here.name
signing = {}   # what's being signed in to right now, so a second click doesn't open a second window


def load():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {"rev": 0}


def write(path, text):
    # write-then-rename, so a run or a page never reads half a file
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def save(state):
    write(STATE, json.dumps(state, ensure_ascii=False, indent=1))
    write(out_dir / "state.js", "window.towerState = " + json.dumps(state, ensure_ascii=False).replace("</", "<\\/") + ";\n")


def refresh():
    # the same as `metanav` in ~/.zshrc: a run now, whatever the hour, so the banner goes as soon as the sign-in works
    (out_dir / ".manual").touch()
    cmd = ["schtasks", "/run", "/tn", JOB] if WINDOWS else ["launchctl", "kickstart", f"gui/{os.getuid()}/{JOB}"]
    subprocess.run(cmd, env=ENV, capture_output=True)


def signed_in(port):
    # Outlook's mail page is titled "Mail - <name> - Outlook", and Teams "<view> | Microsoft Teams", only once you're
    # past the sign-in (Teams' own loading page is just "Microsoft Teams")
    try:
        pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2))
    except OSError:
        return False
    titles = [p.get("title", "") for p in pages if p.get("type") == "page"]
    return any(t.startswith("Mail - ") for t in titles) and any(t.endswith("| Microsoft Teams") for t in titles)


def sign_in_microsoft():
    # A visible window on the runs' own profile, at Outlook and Teams: a new profile may have to pick the account
    # for Teams once, which a headless run can't. Once both have loaded, give the cookies a moment, close the
    # window - the next run needs the profile - and refresh.
    PROFILE.mkdir(parents=True, exist_ok=True)
    (PROFILE / "DevToolsActivePort").unlink(missing_ok=True)
    chrome = subprocess.Popen([CHROME, f"--user-data-dir={PROFILE}", "--remote-debugging-port=0", "--no-first-run",
                               "--no-default-browser-check", "https://outlook.office.com/mail/", "https://teams.microsoft.com/v2/"],
                              env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok, deadline = False, time.time() + 600
    while chrome.poll() is None and time.time() < deadline:
        time.sleep(2)
        port_file = PROFILE / "DevToolsActivePort"
        if port_file.exists() and signed_in(port_file.read_text(encoding="utf-8").split()[0]):
            ok = True
            time.sleep(4)
            break
    if chrome.poll() is None:
        if WINDOWS:   # take Chrome's helper processes down with it, or they keep the profile locked
            subprocess.run(["taskkill", "/PID", str(chrome.pid), "/T", "/F"], capture_output=True)
        else:
            chrome.terminate()
        chrome.wait(timeout=15)
    return ok


def sign_in_azure():
    tenant = subprocess.run(["az", "account", "show", "--query", "tenantId", "-o", "tsv"],
                            env=ENV, capture_output=True, text=True).stdout.strip()
    return subprocess.run(["az", "login", "--output", "none"] + (["--tenant", tenant] if tenant else []),
                          env=ENV, capture_output=True, timeout=600).returncode == 0


def sign_in(source):
    what = "azure" if source == "Azure DevOps" else "microsoft"
    # a run holds the browser profile while it reads Outlook and Teams
    if what in signing or (what == "microsoft" and (out_dir / ".running").exists()):
        return "busy"
    signing[what] = True

    def work():
        try:
            if (sign_in_azure if what == "azure" else sign_in_microsoft)():
                refresh()
        finally:
            signing.pop(what, None)
    threading.Thread(target=work, daemon=True).start()
    return "started"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # Only the panel itself may call in: a page on disk sends Origin "null"; a website open in the same
        # browser sends its own origin. The Host check keeps out DNS-rebinding tricks.
        if (self.path not in ("/state", "/signin", "/refresh") or self.headers.get("Origin", "null") != "null"
                or self.headers.get("Host") not in (f"127.0.0.1:{PORT}", f"localhost:{PORT}")):
            return self.send_error(403)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            if self.path == "/signin":
                if body["source"] not in ("Azure DevOps", "Outlook", "Teams"):
                    raise ValueError(body["source"])
            elif self.path == "/refresh":
                pass
            else:
                key, value = body["key"], body["value"]
                if key not in KEYS or not isinstance(value, dict):
                    raise ValueError(key)
        except (ValueError, KeyError, TypeError):
            return self.send_error(400)
        if self.path == "/signin":
            return self.reply({"status": sign_in(body["source"])})
        if self.path == "/refresh":
            # one run at a time, and not while a sign-in window holds the browser profile
            busy = (out_dir / ".running").exists() or "microsoft" in signing
            if not busy:
                refresh()
            return self.reply({"status": "busy" if busy else "started"})
        state = load()
        state[key] = value
        state["rev"] = state.get("rev", 0) + 1   # lets an open page tell that another browser changed something
        save(state)
        self.reply(state)

    def reply(self, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "null")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    out_dir.mkdir(parents=True, exist_ok=True)
    save(load())   # state.js always exists once the service is up, so the page knows to use it
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
