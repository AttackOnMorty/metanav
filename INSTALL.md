# Installing Meta-Nav

Meta-Nav is a skill for Claude Code or Codex, on macOS or Windows. It builds a live "what should I do now" page from Outlook, Teams and GitHub (and Azure DevOps, if you use it), and refreshes it hourly on weekdays.

You're reading this because the user asked you to install Meta-Nav. Work through these steps in order. Confirm each one before you move on. Stop and tell the user if anything fails. Where a step differs, follow the **macOS** or the **Windows** part, whichever the user is on (on Windows, run the commands in PowerShell).

Below, `<SKILL>` is the skill's folder in your own skills folder — `~/.claude/skills/metanav` if you are Claude Code, `~/.agents/skills/metanav` if you are Codex (on Windows, `~` is `%USERPROFILE%`) — and `<OUT>` is the output folder, `~/metanav` expanded (`/Users/<name>/metanav`, or `C:\Users\<name>\metanav`). Use full paths everywhere below: background jobs don't expand `~`.

1. **Get the files.** If `<SKILL>` doesn't exist yet, clone the repo this file came from into it — for `https://raw.githubusercontent.com/<owner>/metanav/main/INSTALL.md` that's `git clone https://github.com/<owner>/metanav <SKILL>`. The folder must be named exactly `metanav`: the skill, its background jobs and the paths in this guide are named after it. If `<SKILL>` already exists and isn't this repo, stop and ask. `<SKILL>/SKILL.md` should then exist. Read `README.md`, `docs/HOW-IT-WORKS.md` and `SKILL.md` so you know what you're installing.

2. **Check prerequisites.** Report anything missing, with the exact fix:
   - The agent that will judge each run is signed in: `claude` for Claude Code (a short `claude -p "say ok"` answers), or `codex login status` for Codex.
   - `node` (18 or later) and `npm` are on the user's PATH.
   - **Windows:** Git for Windows is installed — Claude Code on Windows needs its Git Bash. With Codex, note that its sandbox on Windows is still experimental: if the first run's log shows a sandbox error, use Claude Code (`judge.agent: "claude"`).
   - Google Chrome is installed (macOS: in `/Applications`; Windows: under `Program Files` or `%LOCALAPPDATA%`, in `Google\Chrome\Application\chrome.exe`).
   - `gh auth status` succeeds, and its token scopes include `read:project`. If not, the user runs `gh auth refresh -h github.com -s read:project` themselves — it's interactive.
   - Nothing is listening on port 47615. macOS: `lsof -nP -iTCP:47615 -sTCP:LISTEN` prints nothing. Windows: `Get-NetTCPConnection -LocalPort 47615 -State Listen` finds nothing.
   - **macOS:** `<SKILL>` is **not** under `~/Desktop`, `~/Documents`, `~/Downloads` or iCloud, and your skills folder is not a symlink into one of them. macOS guards those folders, and background jobs then stop on permission prompts.

3. **Install the collector's one dependency.** Run `npm ci` in `<SKILL>`. It installs `playwright-core`, which drives the installed Chrome; no browser is downloaded.

4. **Write `config.json`.** Copy `config.example.json` to `config.json` and ask the user for each value:
   - `user.name`, and `user.short_name`, which is how the user appears in chats.
   - `github.org`: the GitHub organisation the user's work lives in.
   - `mail.received_folders`: Inbox (already filled in), plus every Inbox subfolder the user's rules file work mail into. For each subfolder, ask the user to open it in Outlook on the web and paste the address bar's URL; use the folder name exactly as Outlook shows it.
   - `teams.skip_chats`: bot or reminder chats to skip, by their name in Teams (e.g. `Workflows`).
   - `schedule`: when syncs run by themselves, on weekdays — `every_minutes` (60), between `start_hour` (9) and `end_hour` (18).
   - `judge.agent`: `"claude"` if you are Claude Code, `"codex"` if you are Codex — the agent each run calls to judge.
   - `judge.model`: for Claude, `"opus"` (`"sonnet"` is cheaper and faster but follows the rules less reliably). For Codex, leave it `""` for Codex's default model, or name one.
   - `azure_devops.orgs`: the Azure DevOps organisations to read, by name; leave it `[]` if the user's work isn't in Azure DevOps. If `az` is installed and signed in (`az account show`), list the organisations their account belongs to and ask which to keep — `ID=$(az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 --url "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1" --query id -o tsv)`, then `az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 --url "https://app.vssps.visualstudio.com/_apis/accounts?memberId=$ID&api-version=7.1" --query "value[].accountName" -o tsv` (in PowerShell, `$ID` is set the same way). Meta-Nav reads their work items, reviews, pull requests and @mentions in each.

5. **Set up the background service** (`scripts/state.mjs`): it starts the scheduled runs, and keeps the panel's clicks. Create `<OUT>/logs` first. Updating an install from before `scripts/` (the service ran `<SKILL>/state.mjs`)? Do this step again.

   **macOS** (launchd):
   - In `assets/metanav.plist`, replace `__PATH__` with a PATH for launchd: the directories holding `node`, the agent's CLI (`claude` or `codex`), `gh` (and `az` if `ado` is set), then `/usr/bin:/bin:/usr/sbin:/sbin`, without duplicates. Use each real binary's directory (for `claude` usually `~/.local/bin`), not a terminal's wrapper under `/var/folders` — `type -a claude` lists them all.
   - Replace `__SKILL__` with `<SKILL>` and `__OUT__` with `<OUT>`, save it as `~/Library/LaunchAgents/local.metanav.plist`, and load it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.metanav.plist` (one already loaded: `launchctl bootout gui/$(id -u)/local.metanav` first).

   **Windows** (Task Scheduler). Run this with `<SKILL>` filled in. `conhost --headless` keeps a console window from showing:
   ```powershell
   $skill = '<SKILL>'
   $node = (Get-Command node).Source
   $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
   $service = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$node`" `"$skill\scripts\state.mjs`""
   Register-ScheduledTask -TaskName 'Meta-Nav' -Action $service -Settings $settings -Trigger (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME") -Force
   Start-ScheduledTask -TaskName 'Meta-Nav'
   ```
   The task runs as the user, with their PATH, so `claude` or `codex`, `gh` and `az` are found as in their terminal.

   Then check the service answers, with a request it turns down (it changes nothing): macOS `curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' http://127.0.0.1:47615/state` prints `400`; Windows `try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:47615/state -Body '{}' } catch { $_.Exception.Response.StatusCode.value__ }` prints `400`. Nothing answering means it isn't running.

6. **Add the `metanav` command** (a refresh now). Check that `metanav` isn't already a command; if it is, use `metanav-sync` instead.
   - **macOS:** append to `~/.zshrc`: `alias metanav='curl -s -X POST -d "{}" http://127.0.0.1:47615/refresh >/dev/null && echo "metanav: refreshing, about 3 minutes"'`
   - **Windows:** append to the PowerShell profile (`$PROFILE`; create it if missing): `function metanav { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:47615/refresh -Body '{}' | Out-Null; 'metanav: refreshing, about 3 minutes' }`

7. **Sign in to Microsoft 365, and the first run.** This part needs the user.
   - Tell the user a Chrome window is about to open on Outlook and Teams, and that they should sign in there (and let it stay signed in; Teams may ask them to pick the account once). Then open it — macOS: `curl -s -X POST -d '{"source":"microsoft"}' http://127.0.0.1:47615/signin` (it answers `{"status":"started"}`); Windows: `Invoke-RestMethod -Method Post -Uri http://127.0.0.1:47615/signin -Body '{"source":"microsoft"}'`.
   - The window closes by itself a few seconds after both Outlook's mail page and Teams have loaded, and the first run starts on its own. It reads the last 30 days, so it takes about 8 minutes.
   - While it runs, ask the user to check Outlook on the web → Settings → General → Language and time: the language is English, the date format is day/month/year (e.g. `30/09/2026`), and the time format is 12-hour (`1:01 PM`). Meta-Nav reads dates as Outlook shows them.
   - When `<OUT>/.running` is gone, check the newest log in `<OUT>/logs/`: its `agent`, `is_error` and `result`. The result names any source that failed. If Outlook or Teams says "sign-in needed", run the sign-in again.
   - Open the panel — macOS: `open <OUT>/index.html`; Windows: `Start-Process <OUT>\index.html`. Tell the user to keep that tab open — it reloads itself.

8. **Finish.** Summarise what was installed and where. Remind the user:
   - SYNC NOW on the panel, or `metanav` in a new terminal, refreshes on demand;
   - TACTICS on the panel takes what only they know, a sentence each — their projects, which days belong to which, whose asks come first, calendar blocks that aren't meetings — and every run judges by it;
   - what a run costs (README, "Cost");
   - `docs/HOW-IT-WORKS.md` explains what the page shows and how it ranks;
   - how to uninstall (the end of this file).

## Uninstall

macOS:
```bash
launchctl bootout gui/$(id -u)/local.metanav
rm ~/Library/LaunchAgents/local.metanav.plist
rm -rf ~/.claude/skills/metanav ~/.agents/skills/metanav ~/metanav ~/Library/Caches/metanav
# then remove the `metanav` alias from ~/.zshrc
```

Windows (PowerShell):
```powershell
Stop-ScheduledTask -TaskName 'Meta-Nav'; Unregister-ScheduledTask -TaskName 'Meta-Nav' -Confirm:$false
Remove-Item -Recurse -Force "$HOME\.claude\skills\metanav", "$HOME\.agents\skills\metanav", "$HOME\metanav", "$env:LOCALAPPDATA\metanav" -ErrorAction SilentlyContinue
# then remove the `metanav` function from $PROFILE
```
