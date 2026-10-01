# Installing Meta-Nav

Meta-Nav is a Claude Code skill. It builds a live "what should I do now" page from Outlook, Teams and GitHub, and refreshes it hourly on weekdays.

Claude: you're reading this because the user asked you to install Meta-Nav. Work through these steps in order. Confirm each one before you move on. Stop and tell the user if anything fails. Below, `<SKILL>` is `~/.claude/skills/metanav` and `<OUT>` is the expanded `output_dir` from `config.json` (`~/metanav` → `/Users/<name>/metanav`).

1. **Get the files.** If `<SKILL>` doesn't exist yet, clone the repo the user gave you into it: `git clone <url> ~/.claude/skills/metanav`. The folder must be named exactly `metanav`: the skill's command (`/metanav`), its background jobs and the paths in this guide are named after it. If `~/.claude/skills/metanav` already exists and isn't this repo, stop and ask. `<SKILL>/SKILL.md` should then exist. Read `README.md`, `HOW-IT-WORKS.md` and `SKILL.md` so you know what you're installing.

2. **Check prerequisites.** Report anything missing, with the exact fix:
   - The OS is macOS.
   - `node` (18 or later), `npm`, `jq` and `python3` are on the user's PATH, and `/usr/bin/python3` exists (the click store runs with it; `xcode-select --install` provides it).
   - Google Chrome is at `/Applications/Google Chrome.app`.
   - `gh auth status` succeeds, and its token scopes include `read:project`. If not, the user runs `gh auth refresh -h github.com -s read:project` themselves — it's interactive.
   - `<SKILL>` is **not** under `~/Desktop`, `~/Documents`, `~/Downloads` or iCloud, and `~/.claude/skills` is not a symlink into one of them. macOS guards those folders, and background jobs then stop on permission prompts.
   - Nothing is listening on port 47615: `lsof -nP -iTCP:47615 -sTCP:LISTEN` prints nothing.

3. **Install the collector's one dependency.** Run `npm ci` in `<SKILL>`. It installs `playwright-core`, which drives the installed Chrome; no browser is downloaded.

4. **Write `config.json`.** Copy `config.example.json` to `config.json` and ask the user for each value:
   - `user.name`, and `user.short_name`, which is how the user appears in chats.
   - `projects`: the projects the user cares about. News about them counts as "worth knowing".
   - `schedule` (optional): if the user works on one project per weekday, map the days to project names, e.g. `{ "Mon": "Project A", "Tue": "Project B" }`. Work for another day's project then ranks lower. Leave it `{}` otherwise.
   - `github_owner`: the GitHub org the user's work lives in.
   - `mail.received_folders`: Inbox (already filled in), plus every Inbox subfolder the user's rules file work mail into. For each subfolder, ask the user to open it in Outlook on the web and paste the address bar's URL; use the folder name exactly as Outlook shows it.
   - `mail.skipped_folders`: notification folders that are never read, like `GitHub`.
   - `teams.skip_chats`: bot or reminder chats to skip, by their name in Teams (e.g. `Workflows`).
   - `calendar.skip_events`: personal calendar blocks that aren't meetings, like "Lunch".
   - `hours`: when scheduled runs happen, weekdays, on the hour. The default is 9 to 18.
   - `ado`: leave it `null` unless the user wants one Azure DevOps release pipeline watched. If they do, set it to `{ "base_url": "https://dev.azure.com/<org>/<project>", "release_definition": <id> }`, then check `az` is installed and signed in, and that `az extension show --name azure-devops` succeeds (else `az extension add --name azure-devops`).
   - Keep `output_dir` (`~/metanav`), `lookback_days` (30) and `judge_model` (`opus`) unless the user says otherwise.

5. **Set up the two background jobs.**
   - Create `<OUT>/logs`.
   - In `run.sh`, replace `__PATH__` with a PATH for launchd: the directories holding `claude`, `node`, `jq`, `gh` (and `az` if `ado` is set), then `/usr/bin:/bin:/usr/sbin:/sbin`, without duplicates. For `claude`, use the real binary's directory (usually `~/.local/bin`), not a terminal's wrapper under `/var/folders` — `type -a claude` lists them all. Then `chmod +x run.sh fetch.sh`.
   - In `metanav.plist` and `metanav-state.plist`, replace `__HOME__` with the user's home directory and `__OUT__` with `<OUT>`. Copy them to `~/Library/LaunchAgents/local.metanav.plist` and `~/Library/LaunchAgents/local.metanav-state.plist`.
   - Load both: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.metanav-state.plist`, then the same for `local.metanav.plist`.
   - Check the click store answers: `curl -s -X POST -H 'Origin: null' -d '{"key":"tower:read","value":{}}' http://127.0.0.1:47615/state` prints JSON with `"rev"`.

6. **Add the `metanav` command.** Check that `metanav` isn't already a command (`type metanav`). If it is, use `metanav-sync` instead. Append this alias to `~/.zshrc`, with `<OUT>` replaced by the expanded output dir:
   ```
   alias metanav='touch <OUT>/.manual && launchctl kickstart gui/$(id -u)/local.metanav && echo "metanav: refreshing, about 3 minutes"'
   ```

7. **Sign in to Microsoft 365, and the first run.** This part needs the user.
   - Tell the user a Chrome window is about to open on Outlook and Teams, and that they should sign in there (and let it stay signed in; Teams may ask them to pick the account once). Then open it: `curl -s -X POST -H 'Origin: null' -d '{"source":"Outlook"}' http://127.0.0.1:47615/signin`.
   - The window closes by itself a few seconds after both Outlook's mail page and Teams have loaded, and the first run starts on its own. It reads the last 30 days, so it takes about 8 minutes.
   - While it runs, ask the user to check Outlook on the web → Settings → General → Language and time: the language is English, the date format is day/month/year (e.g. `30/09/2026`), and the time format is 12-hour (`1:01 PM`). Meta-Nav reads dates as Outlook shows them.
   - When `<OUT>/.running` is gone, check the newest log in `<OUT>/logs/`: `jq '{is_error, result}'` on it. The result names any source that failed. If Outlook or Teams says "sign-in needed", run the sign-in again.
   - Open the panel: `open <OUT>/index.html`. Tell the user to keep that tab open — it reloads itself.

8. **Finish.** Summarise what was installed and where. Remind the user:
   - SYNC NOW on the panel, or `metanav` in a new terminal, refreshes on demand;
   - each run costs roughly $0.40–1.20 of usage with Opus, 10 runs a working day;
   - `HOW-IT-WORKS.md` explains what the page shows and how it ranks;
   - how to uninstall, from the README.
