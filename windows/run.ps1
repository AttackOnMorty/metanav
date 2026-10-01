# Refresh Meta-Nav on Windows. Task Scheduler fires this on the hour (windows/install.ps1 registers the task) and it works
# on weekdays within config.hours; `metanav` (a function in your PowerShell profile) and the panel's SYNC NOW button fire it
# on demand, at any hour. This is the Windows twin of run.sh.
$ErrorActionPreference = 'Stop'

$Skill = Split-Path -Parent $PSScriptRoot
$Name  = Split-Path -Leaf $Skill          # the skill is called after its folder: /metanav
$Cfg   = Get-Content (Join-Path $Skill 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json

$Out = if ($Cfg.output_dir) { $Cfg.output_dir } else { '~/metanav' }
if ($Out -like '~*') { $Out = Join-Path $HOME $Out.Substring(1).TrimStart('/', '\') }
$Start = if ($null -ne $Cfg.hours.start) { [int]$Cfg.hours.start } else { 9 }
$End   = if ($null -ne $Cfg.hours.end)   { [int]$Cfg.hours.end }   else { 18 }
$Model = if ($Cfg.judge_model) { $Cfg.judge_model } else { 'sonnet' }

# Python in the scripts reads and writes UTF-8 whatever the Windows code page is
$env:PYTHONUTF8 = '1'
$Python = @('python3', 'python') | Where-Object {
    $c = Get-Command $_ -ErrorAction SilentlyContinue
    $c -and $c.Source -notlike '*\WindowsApps\*'   # the Microsoft Store stub is not a Python
} | Select-Object -First 1
if (-not $Python) { throw 'Python 3 is not on PATH (install it from python.org, not the Store stub)' }

# `metanav` drops a .manual flag first: a run the user asked for ignores the hours
$Manual = Join-Path $Out '.manual'
if (Test-Path $Manual) {
    Remove-Item $Manual -Force
} else {
    $now = Get-Date
    if ($now.DayOfWeek -in 'Saturday', 'Sunday' -or $now.Hour -lt $Start -or $now.Hour -gt $End) { exit 0 }
}

New-Item -ItemType Directory -Force (Join-Path $Out 'logs') | Out-Null
Set-Location $Out

# One run at a time. A lock older than 20 minutes is left over from a run that died (sleep, power off): clear it.
$Lock = Join-Path $Out '.running'
if ((Test-Path $Lock) -and ((Get-Item $Lock).LastWriteTime -lt (Get-Date).AddMinutes(-20))) { Remove-Item $Lock -Force -Recurse }
try { New-Item -ItemType Directory $Lock -ErrorAction Stop | Out-Null } catch { exit 0 }

try {
    # Show "Syncing..." on the open panel until this run rewrites it
    & $Python (Join-Path $Skill 'render.py') --syncing

    # Nobody reads this run while it works, so it never stops to ask (SKILL.md, "unattended"). It only judges:
    # collect.mjs does the reading in a headless Chrome of its own, so no MCP server is needed.
    $log = Join-Path $Out ('logs\' + (Get-Date -Format 'yyyyMMdd-HHmm') + '.json')
    & claude -p "/$Name unattended" --model $Model --strict-mcp-config --permission-mode auto `
        --allowedTools 'Skill' 'Read' 'Write' --output-format json 2>&1 | Out-File -FilePath $log -Encoding utf8

    # A run that failed never re-rendered: take the "syncing" flag back off
    $panel = Join-Path $Out 'index.html'
    if ((Test-Path $panel) -and (Select-String -Path $panel -SimpleMatch '"syncing": true' -Quiet)) {
        & $Python (Join-Path $Skill 'render.py') --idle
    }
} finally {
    # The collector's inputs hold private chats and mail: deleted here so it happens even after a failed run
    Remove-Item (Join-Path $Out '.inputs') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $Lock -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem (Join-Path $Out 'logs') -Filter '*.json' | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7) | Remove-Item -Force
}
