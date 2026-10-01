# Installing Meta-Nav on Windows

This is the Windows twin of `INSTALL.md` (macOS). The skill is the same. Only the scheduling differs: Task Scheduler replaces `launchd`, and `windows/run.ps1` replaces `run.sh`.

Claude: you're reading this because the user asked you to install Meta-Nav on Windows. Work through these steps in order. Confirm each one before you move on. Stop and tell the user if anything fails. Below, `<SKILL>` is `~/.claude/skills/metanav` and `<OUT>` is the expanded `output_dir` from `config.json` (`~/metanav` → `C:\Users\<name>\metanav`).

1. **Get the files.** If `<SKILL>` doesn't exist yet, clone the repo the user gave you into it: `git clone <url> ~/.claude/skills/metanav`. The folder must be named exactly `metanav`. If it already exists and isn't this repo, stop and ask. Read `README.md`, `HOW-IT-WORKS.md` and `SKILL.md`.

2. **Check prerequisites.** `windows\install.ps1` (step 5) checks all of these and lists what is missing, so you can run it early to find out. They are:
   - Windows 10 or 11 with PowerShell.
   - `node` 18+, `npm`, `jq`, Python 3 (the real one: not the Microsoft Store stub), `gh`, `claude`, Google Chrome, and **Git for Windows** (`fetch.sh` runs in Git Bash; Claude Code needs it on Windows anyway). `winget` installs each: `OpenJS.NodeJS.LTS`, `jqlang.jq`, `Python.Python.3.12`, `GitHub.cli`, `Git.Git`, `Google.Chrome`.
   - `gh auth status` succeeds and its scopes include `read:project`. If not, the user runs `gh auth refresh -h github.com -s read:project` themselves: it's interactive.
   - Nothing else listens on port 47615.

3. **Write `config.json`.** Copy `config.example.json` to `config.json` and fill it in exactly as step 4 of `INSTALL.md` describes (name, projects, `github_owner`, mail folders, skipped chats and events, hours, optional `ado`). `output_dir` stays `~/metanav`.

4. **Check Outlook's settings.** In Outlook on the web → Settings → General → Language and time: the language is English, the date format is day/month/year, and the time format is 12-hour. Meta-Nav reads dates as Outlook shows them.

5. **Install.** From a PowerShell prompt in `<SKILL>`:
   ```powershell
   powershell -ExecutionPolicy Bypass -File windows\install.ps1
   ```
   It runs `npm ci`, registers two Task Scheduler tasks (`metanav`, hourly, and `metanav-state`, at logon), starts the click store, and adds a `metanav` function to your PowerShell profile (`metanav-sync` if the name is taken). Check the click store answers:
   ```powershell
   curl.exe -s -X POST -H "Origin: null" -d "{\"key\":\"tower:read\",\"value\":{}}" http://127.0.0.1:47615/state
   ```
   It prints JSON with `"rev"`.

6. **Sign in to Microsoft 365, and the first run.** This part needs the user. Tell them a Chrome window is about to open on Outlook and Teams and that they sign in there. Then open it:
   ```powershell
   curl.exe -s -X POST -H "Origin: null" -d "{\"source\":\"Outlook\"}" http://127.0.0.1:47615/signin
   ```
   The window closes by itself once both have loaded, and the first run starts. It reads 30 days and takes about 8 minutes. When `<OUT>\.running` is gone, check the newest file in `<OUT>\logs`: `result` names any source that failed. Then open `<OUT>\index.html` and keep that tab open.

7. **Finish.** Summarise what was installed and where. Remind the user: SYNC NOW or `metanav` refreshes on demand; each run costs roughly $0.40–1.20 of usage with Opus, 10 runs a working day; `HOW-IT-WORKS.md` explains the page.

## Windows notes

- Scheduled runs start when the PC wakes after a missed hour (`StartWhenAvailable`), like `launchd`. They need you signed in: the tasks run as you, only while you are logged on.
- Meta-Nav's own Chrome profile (your Microsoft sign-in) is in `%LOCALAPPDATA%\metanav\`.
- Notifications for new urgent items are Windows toasts.
- The tasks open a console window very briefly when they start.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File windows\install.ps1 -Uninstall
```

It removes both tasks and the profile line. Then delete `~\.claude\skills\metanav`, `~\metanav` and `%LOCALAPPDATA%\metanav`.
