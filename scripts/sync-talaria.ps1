<#
.SYNOPSIS
    Bring Talaria up to date on a Windows machine.

.DESCRIPTION
    1. Pulls hermes-talaria into Documents\Github Repos\hermes-talaria, or clones it there if missing
       (an older checkout at Documents\Github Repos\hermes\talaria is used if that is there).
       Stops if that folder has changes that are not committed, so nothing of yours is overwritten.
    2. Copies the device half (talaria\desktop\plugin.js) into Hermes Desktop's plugin folder,
       <Hermes home>\desktop-plugins\talaria, when it changed. Press Rescan in Desktop afterwards.
    3. On the machine that hosts Hermes (it has the "Hermes Dashboard" scheduled task), restarts the
       dashboard so the server half reloads. The server half is linked to the checkout, so the pull
       already updated its files. A laptop without that task skips this step.
    4. If the background helper is installed, refreshes its copy and restarts it.

    -Install also copies this script to $HOME\bin and puts that folder on your PATH, so
    "sync-talaria" works from any PowerShell window opened afterwards, along with a
    "talaria-helper" command for the background helper.

.EXAMPLE
    .\sync-talaria.ps1 -Install
.EXAMPLE
    sync-talaria
.EXAMPLE
    sync-talaria -Branch claude/project-thread-ekvwk9
    A branch that is not merged yet, to try it before merging.
#>
param(
    [string]$Branch = "main",
    [switch]$Install,
    [switch]$NoRestart    # on the server, leave the dashboard running
)

$ErrorActionPreference = "Stop"

$url = "https://github.com/Kaylachuuu/hermes-talaria.git"
$repos = if ($env:GITHUB_REPOS) { $env:GITHUB_REPOS } else { Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Github Repos" }
# Github Repos\hermes-talaria, or an older checkout at Github Repos\hermes\talaria if that is there.
$project = Join-Path $repos "hermes-talaria"
$older = Join-Path (Join-Path $repos "hermes") "talaria"
if (-not (Test-Path $project) -and (Test-Path (Join-Path $older ".git"))) { $project = $older }
$hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA "hermes" }
$target = Join-Path (Join-Path $hermesHome "desktop-plugins") "talaria"
$task = "Hermes Dashboard"

function Fail($message) { Write-Host "Stopped: $message" -ForegroundColor Red; exit 1 }
function RunGit { & git @args; if ($LASTEXITCODE -ne 0) { Fail "git $($args -join ' ') failed" } }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git is not installed or not on PATH" }
if (-not (Test-Path $repos)) { Fail "no folder at $repos" }

if ($Install) {
    $bin = Join-Path $HOME "bin"
    New-Item -ItemType Directory -Force $bin | Out-Null
    Copy-Item $PSCommandPath (Join-Path $bin "sync-talaria.ps1") -Force
    $userPath = [string][Environment]::GetEnvironmentVariable("Path", "User")
    if (-not (($userPath -split ";") -contains $bin)) {
        [Environment]::SetEnvironmentVariable("Path", (($userPath.TrimEnd(";"), $bin) -join ";").TrimStart(";"), "User")
        Write-Host "Added $bin to your PATH. Open a new PowerShell window to use sync-talaria."
    }
    Write-Host "Installed as $(Join-Path $bin 'sync-talaria.ps1')"
    # A talaria-helper command too, running the helper from the checkout (for setup, status and so on).
    $helperScript = [IO.Path]::Combine($project, "helper", "talaria-helper.mjs")
    Set-Content -Path (Join-Path $bin "talaria-helper.cmd") -Value "@node `"$helperScript`" %*" -Encoding ASCII
    Write-Host "Installed as $(Join-Path $bin 'talaria-helper.cmd')"
}

# 1. The checkout
Write-Host "== talaria ($Branch)"
if (Test-Path (Join-Path $project ".git")) {
    if (& git -c core.filemode=false -C $project status --porcelain) {
        Fail "$project has changes that are not committed. Commit or put them aside first."
    }
    RunGit -C $project fetch -q origin $Branch
    RunGit -C $project checkout -q $Branch
    RunGit -C $project merge --ff-only -q "origin/$Branch"
} elseif (Test-Path $project) {
    Fail "$project exists but is not a git checkout. Rename it and run this again to clone a fresh one."
} else {
    New-Item -ItemType Directory -Force (Split-Path $project) | Out-Null
    RunGit clone -q --branch $Branch $url $project
}
$version = (Select-String -Path ([IO.Path]::Combine($project, "talaria", "plugin.yaml")) -Pattern '^version:\s*(.+)$' |
    Select-Object -First 1).Matches.Groups[1].Value
Write-Host "talaria $version at $(& git -C $project log -1 --format='%h %s')"

# 2. The device half
$source = [IO.Path]::Combine($project, "talaria", "desktop", "plugin.js")
$installed = Join-Path $target "plugin.js"
if (-not (Test-Path $source)) { Fail "$source is missing" }
if ((Test-Path $installed) -and ((Get-FileHash $source).Hash -eq (Get-FileHash $installed).Hash)) {
    Write-Host "Desktop plugin already current in $target."
} else {
    New-Item -ItemType Directory -Force $target | Out-Null
    Copy-Item $source $installed -Force
    Write-Host "Desktop plugin updated in $target."
    Write-Host "In Hermes Desktop, press Rescan in Capabilities > Plugins (or restart the app) to load it." -ForegroundColor Yellow
}

# 3. The server half, only where the dashboard runs as a scheduled task
if ((Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) -and
    (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)) {
    if ($NoRestart) {
        Write-Host "Left the dashboard running; restart it to load the new server half."
    } else {
        Stop-ScheduledTask -TaskName $task
        Start-ScheduledTask -TaskName $task
        Write-Host "Restarted the dashboard so the server half reloads."
    }
}

# 4. The background helper, if it was installed: it runs from its own copy, so refresh and restart it.
$helperSource = [IO.Path]::Combine($project, "helper", "talaria-helper.mjs")
$helperHome = if ($env:TALARIA_HELPER_HOME) { $env:TALARIA_HELPER_HOME } else { Join-Path ([string]$env:APPDATA) "Talaria" }
$helperCopy = Join-Path $helperHome "talaria-helper.mjs"
if ((Test-Path $helperCopy) -and (Test-Path $helperSource) -and
    ((Get-FileHash $helperSource).Hash -ne (Get-FileHash $helperCopy).Hash)) {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "Skipped the background helper: node is not on PATH in this window. If Node was just installed, open a new PowerShell window and run sync-talaria again." -ForegroundColor Yellow
    } else {
        & node $helperSource install | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "could not update the background helper (node `"$helperSource`" install)" }
        Write-Host "Background helper updated and restarted."
    }
}
