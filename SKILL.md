---
name: metanav
description: Refresh Meta-Nav, the user's live work panel - built from Outlook mail and calendar, Teams, GitHub and (optionally) Azure DevOps, with AI-judged priorities, open loops and drafted nudges. Use when asked to refresh or update Meta-Nav or the work panel, for the morning brief, "what do I need to know", "what am I waiting on", or when the user runs /metanav.
---

# Meta-Nav

The panel refreshes itself: `run.mjs`, beside this file, runs on the hour on weekdays. It collects, has an agent judge with `JUDGE.md`, and renders the page. Don't judge anything yourself here. Its output folder is `~/metanav` (`output_dir` in `config.json` beside this file, if set).

**A refresh now** (the user asks for one, or runs `/metanav`):
1. Start a run, the same as the panel's SYNC NOW: POST `{}` to `http://127.0.0.1:47615/refresh` — `curl -s -X POST -d '{}' http://127.0.0.1:47615/refresh` on macOS, `Invoke-RestMethod -Method Post -Uri http://127.0.0.1:47615/refresh -Body '{}'` on Windows. If nothing answers, create `<output_dir>/.manual` and run `node run.mjs` from this folder instead.
2. Wait until `<output_dir>/.running` is gone: 2–4 minutes, up to 10 on a first run.
3. Read the newest file in `<output_dir>/logs/` and pass on its `result`, the judge's summary. If `is_error` is true, say what failed.

**"What do I need to know?" / "What am I waiting on?"** without a refresh: read the newest `<output_dir>/runs/*.json` and answer from its `queue`, `waiting` and `highlights`.

Never open the panel: the user keeps it open in a browser tab, and it reloads itself.
