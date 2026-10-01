# Meta-Nav

**One page that tells you what to do next.** Every hour on weekdays, a Claude Code skill reads your Outlook mail and calendar, your Teams chats and GitHub (and, if you like, one Azure DevOps release pipeline). It works out what you have to do, ranks it by cost of delay — who's blocked on you, what's due, who's been waiting longest — and writes a local HTML page in a Persona 5 style:

- **Target**: the one most important thing, why it's first, and a button to start it.
- **Requests**: the rest of your to-dos, ranked, with the reason for each, how long each has been yours, and a difficulty letter (D minutes … A a day or more). What you finished today stays at the bottom, stamped `DONE!`.
- **Waiting On**: what other people owe you. Open one to see the conversation and a drafted nudge — edit it, then copy it and jump to the chat. The ones worth chasing now are tagged `CHASE`.
- **Phan-Site**: things worth knowing about your projects, no action needed.

![Meta-Nav with sample data](docs/screenshot.png)

Tick an item's circle to mark it done; if something new happens on it later, it comes back. Deleting an email in Outlook also counts as done.

## How it works

| Source | How it's read |
| --- | --- |
| Outlook mail and calendar | Outlook on the web in a headless Chrome, reading the list views only. **Nothing is opened, so nothing gets marked read.** |
| Teams | Teams on the web keeps recent chats in its own local cache (IndexedDB). Meta-Nav reads that cache — direct, group and meeting chats; channels aren't read. No API calls, no tokens, nothing marked read. |
| GitHub | `gh`: your open PRs, review requests, the issues assigned to you on the current sprint board, and where someone @mentioned you. |
| Azure DevOps (optional) | `az`: the latest release of one pipeline. |

A script collects everything in about 25 seconds; then Claude (Opus by default) judges it. Each run is incremental: it starts from the previous run's judgement, re-checks what was still open, and judges only what's new. A whole run takes 2–4 minutes.

**`HOW-IT-WORKS.md`** walks through the whole flow: when it refreshes, what each source gives, how the AI decides what's yours and how it ranks it, and what every part of the page means.

## What you need

- **macOS.** Scheduling uses `launchd`.
- **Claude Code**, signed in. Scheduled runs use auto permission mode, so they run unattended.
- **Google Chrome** in `/Applications`, **Node.js** 18+, `jq`, and `python3`.
- **`gh`**, signed in with the `read:project` scope (for sprint board status). `az` only if you want an Azure DevOps pipeline.
- A Microsoft 365 account you can use in Outlook and Teams on the web. You sign in once, in a Chrome window Meta-Nav opens for you.
- Outlook on the web in **English**, with a **day/month/year** date format and a **12-hour** clock (the English (Australia) defaults). Meta-Nav reads dates and times as Outlook displays them.
- The **Teams desktop app**. Teams links open there.

## Install

Clone it (or your fork) into Claude Code's skills folder, then let Claude Code set it up:

```bash
git clone https://github.com/AttackOnMorty/metanav ~/.claude/skills/metanav
```

In Claude Code: *"Install Meta-Nav by following ~/.claude/skills/metanav/INSTALL.md"*. It checks what you need, asks for your settings, sets up the two background jobs, and opens a Chrome window for your Microsoft sign-in.

## Cost

Each run makes one `claude -p` call with Opus: roughly **$0.40–1.20 of usage per run**, 2–4 minutes each; the first run, which reads 30 days, about $2.50 and 8 minutes. Hourly from 9:00 to 18:00 on weekdays is 10 runs a day. To run less often, narrow `hours` in `config.json`. `judge_model: "sonnet"` costs about a third and runs twice as fast, but follows the rules less reliably — it tends to copy the last run's items instead of re-judging them.

## Privacy

Everything stays on your Mac:
- The panel is `~/metanav/index.html`.
- Run history (14 days) is in `~/metanav/runs/`, logs (7 days) in `~/metanav/logs/`.
- Your clicks are in `~/metanav/state.json`, written by a small service that listens on `127.0.0.1` only.
- Meta-Nav's own Chrome profile (your Microsoft sign-in) is in `~/Library/Caches/metanav/`.

The collected mail and chats are deleted at the end of every run.

## Everyday use

- Open `~/metanav/index.html` once and keep the tab open (pin it). It reloads itself when a run writes something new.
- **SYNC NOW** on the panel, or `metanav` in a terminal, refreshes now — at any hour. Scheduled runs only happen on weekdays within `hours`.
- If a source needs signing in again, the panel shows a red banner with a **SIGN IN** button: it opens a Chrome window on Outlook and Teams, closes it once you're in, and refreshes. Your organisation may ask for this every so often.
- Change what's read or skipped in `~/.claude/skills/metanav/config.json`.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/local.metanav
launchctl bootout gui/$(id -u)/local.metanav-state
rm ~/Library/LaunchAgents/local.metanav.plist ~/Library/LaunchAgents/local.metanav-state.plist
rm -rf ~/.claude/skills/metanav ~/metanav ~/Library/Caches/metanav
# then remove the `metanav` alias from ~/.zshrc
```
