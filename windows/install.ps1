# Meta-Nav on Windows: checks the prerequisites, installs the collector's dependency, registers the two Task Scheduler
# tasks (the Windows twin of the two launchd jobs) and adds the `metanav` command to your PowerShell profile.
# Run it from a PowerShell prompt, after config.json exists:   powershell -ExecutionPolicy Bypass -File windows\install.ps1
# Remove everything again with:                                 powershell -ExecutionPolicy Bypass -File windows\install.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$Skill = Split-Path -Parent $PSScriptRoot
$Name  = Split-Path -Leaf $Skill
$StateTask = "$Name-state"
$Marker = '# metanav (added by windows/install.ps1)'

function Expand-OutDir {
    $cfg = Get-Content (Join-Path $Skill 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $o = if ($cfg.output_dir) { $cfg.output_dir } else { '~/metanav' }
    if ($o -like '~*') { $o = Join-Path $HOME $o.Substring(1).TrimStart('/', '\') }
    return $o
}

if ($Uninstall) {
    foreach ($t in $Name, $StateTask) { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
    if (Test-Path $PROFILE) {
        $keep = (Get-Content $PROFILE) | Where-Object { $_ -notmatch [regex]::Escape($Marker) }
        Set-Content $PROFILE $keep -Encoding UTF8
    }
    Write-Host "Tasks and profile line removed. To finish, delete: $Skill, $(Expand-OutDir), $env:LOCALAPPDATA\metanav"
    exit 0
}

# ---- prerequisites: report every problem at once, with the fix ----
$problems = @()
function Need($ok, $msg) { if (-not $ok) { $script:problems += $msg } }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Need (Test-Path (Join-Path $Skill 'config.json')) 'config.json is missing: copy config.example.json to config.json and fill it in.'
Need ((Has node) -and ([int](node -p 'process.versions.node.split(".")[0]') -ge 18)) 'Node.js 18 or later: winget install OpenJS.NodeJS.LTS'
Need (Has npm) 'npm (comes with Node.js).'
Need (Has jq) 'jq: winget install jqlang.jq'
Need (Has gh) 'GitHub CLI: winget install GitHub.cli'
if (Has gh) {
    gh auth status *> $null
    Need ($LASTEXITCODE -eq 0) 'gh is not signed in: gh auth login'
    if ($LASTEXITCODE -eq 0) {
        Need ((gh auth status 2>&1 | Out-String) -match 'read:project') 'gh token lacks read:project (you run this, it is interactive): gh auth refresh -h github.com -s read:project'
    }
}
Need (Has claude) 'Claude Code: https://claude.com/claude-code'
$python = @('python3', 'python') | Where-Object { $c = Get-Command $_ -ErrorAction SilentlyContinue; $c -and $c.Source -notlike '*\WindowsApps\*' } | Select-Object -First 1
Need ([bool]$python) 'Python 3 (not the Microsoft Store stub): winget install Python.Python.3.12'
$gitBash = @($env:CLAUDE_CODE_GIT_BASH_PATH) + @('ProgramFiles', 'ProgramFiles(x86)', 'LocalAppData' | ForEach-Object { Join-Path ([Environment]::GetEnvironmentVariable($_)) 'Git\bin\bash.exe' }) |
    Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
Need ([bool]$gitBash) 'Git for Windows (fetch.sh runs in Git Bash): winget install Git.Git'
$chrome = 'ProgramFiles', 'ProgramFiles(x86)', 'LocalAppData' | ForEach-Object { Join-Path ([Environment]::GetEnvironmentVariable($_)) 'Google\Chrome\Application\chrome.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
Need ([bool]$chrome) 'Google Chrome: winget install Google.Chrome'
Need (-not (Get-NetTCPConnection -LocalPort 47615 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -ne 0 } | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").CommandLine -notmatch 'state\.py' })) 'Port 47615 is used by another program (the panel needs it).'

if ($problems) {
    Write-Host 'Fix these first:' -ForegroundColor Yellow
    $problems | ForEach-Object { Write-Host "  - $_" }
    exit 1
}

# ---- the collector's one dependency ----
Push-Location $Skill; npm ci; Pop-Location
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }

# ---- tasks ----
$out = Expand-OutDir
New-Item -ItemType Directory -Force (Join-Path $out 'logs') | Out-Null
$pythonExe = (Get-Command $python).Source
$ps = (Get-Command powershell).Source

# 1. the run: on the hour, every hour; run.ps1 itself keeps to weekdays within config.hours. StartWhenAvailable is
#    launchd's "runs when the Mac wakes": a run missed while the PC was off or asleep starts when it is back.
$runAction  = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Skill\windows\run.ps1`""
$runTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date) -RepetitionInterval (New-TimeSpan -Hours 1)
$runSet     = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName $Name -Action $runAction -Trigger $runTrigger -Settings $runSet -Force -Description 'Meta-Nav hourly refresh' | Out-Null

# 2. the click store (state.py): up from logon, restarted if it stops
$cmd = "`$env:PYTHONUTF8='1'; & '$pythonExe' '$Skill\state.py' *>> '$out\logs\state.log'"
$stAction  = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`""
$stTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$stSet     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $StateTask -Action $stAction -Trigger $stTrigger -Settings $stSet -Force -Description 'Meta-Nav click store' | Out-Null
Start-ScheduledTask -TaskName $StateTask

# ---- the `metanav` command (a function in the profile; metanav-sync if the name is taken) ----
$fn = if (Get-Command metanav -ErrorAction SilentlyContinue | Where-Object { $_.CommandType -ne 'Function' }) { 'metanav-sync' } else { 'metanav' }
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Force $PROFILE | Out-Null }
if (-not (Select-String -Path $PROFILE -SimpleMatch $Marker -Quiet)) {
    Add-Content $PROFILE "function $fn { New-Item -ItemType File -Force '$out\.manual' | Out-Null; schtasks /run /tn $Name | Out-Null; 'metanav: refreshing, about 3 minutes' } $Marker"
}

Write-Host "Installed. Task '$Name' (hourly) and '$StateTask' (at logon) are registered; open a new PowerShell and run '$fn' to refresh."
Write-Host 'Next: sign in to Microsoft 365 (see INSTALL-WINDOWS.md, step 5).'
