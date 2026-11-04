# Refresh Blade to latest MT Code.
# Clone remote "origin" here is github.com/munimtechnologies/mtcode (main branch).
# Uses T3CODE_DESKTOP_VERSION (single version, no nightly prerelease).
# The fleet ships the MT Code brand on every machine, same as the Mac.
param(
  [string]$DesktopVersion = "",
  [string]$ForceRebuild = "",
  # A Windows installer that already exists on this machine (the publish just
  # built it). Installs that file and skips the fetch and rebuild entirely.
  [string]$InstallerPath = "",
  # Commit the installer was built from, recorded so the scheduled refresh does
  # not rebuild the same commit.
  [string]$BuiltSha = ""
)

$ErrorActionPreference = "Stop"
if ($DesktopVersion) { $env:T3CODE_DESKTOP_VERSION = $DesktopVersion }
if ($ForceRebuild) { $env:T3_FORCE_REBUILD = $ForceRebuild }
$env:T3CODE_DESKTOP_DISTRO = "munim"

$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
  [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" +
  "$env:USERPROFILE\.vite-plus\bin;" +
  "$env:USERPROFILE\.cargo\bin"

$repo = Join-Path $env:USERPROFILE "dev\t3code-personal"
$logDir = Join-Path $env:USERPROFILE "dev\t3-personal-logs"
$stateFile = Join-Path $logDir "last-built-sha"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("refresh-{0:yyyyMMdd}.log" -f (Get-Date))
function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format o), $msg
  Add-Content -Path $log -Value $line -Encoding ascii
  Write-Output $line
}

function Install-MtCode {
  param([Parameter(Mandatory = $true)][string]$InstallerPath)
Log "stopping MT Code"
# Ask the app to close, then force-stop whatever still runs from the MT/T3 Code
# install folders. CloseMainWindow alone never reaches the server sidecar or a
# session-0 window over SSH, and a survivor made Dell keep the old build.
$installDirs = @("mtcode", "t3code") | ForEach-Object { (Join-Path $env:LOCALAPPDATA "Programs\$_") + "\" }
function Get-InstalledAppProcess {
  Get-Process | Where-Object { $p = $_.Path; $p -and ($installDirs | Where-Object { $p.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }) }
}
Get-InstalledAppProcess | ForEach-Object { [void]$_.CloseMainWindow() }
for ($i = 0; $i -lt 20 -and (Get-InstalledAppProcess); $i++) { Start-Sleep -Milliseconds 500 }
Get-InstalledAppProcess | Stop-Process -Force -ErrorAction SilentlyContinue

Log "uninstalling previous installs if present"
try {
  winget uninstall --id T3Tools.T3Code --silent --disable-interactivity 2>&1 | Out-String | ForEach-Object { Log $_ }
} catch {}
# Both brands: the fleet used to ship the plain T3 Code identity, so its uninstaller
# lingers on machines that have not been wiped since the MT Code switch.
foreach ($entry in @(
  @{ Dir = "t3code"; Name = "Uninstall T3 Code (Nightly).exe" },
  @{ Dir = "t3code"; Name = "Uninstall T3 Code (Alpha).exe" },
  @{ Dir = "t3code"; Name = "Uninstall T3 Code.exe" },
  @{ Dir = "mtcode"; Name = "Uninstall MT Code.exe" }
)) {
  $uninst = Join-Path $env:LOCALAPPDATA ("Programs\{0}\{1}" -f $entry.Dir, $entry.Name)
  if (Test-Path $uninst) {
    Start-Process -FilePath $uninst -ArgumentList "/S" -Wait
  }
}

Log "installing $InstallerPath"
Start-Process -FilePath $InstallerPath -ArgumentList "/S" -Wait
Start-Sleep 2
$exe = Get-ChildItem (Join-Path $env:LOCALAPPDATA "Programs\mtcode\MT Code*.exe") |
  Where-Object { $_.Name -notlike "Uninstall*" } |
  Select-Object -First 1
if ($exe) {
  Log "launching $($exe.Name)"
  # Not Start-Process: this script runs over SSH, in session 0, which has no desktop -- the app
  # started there and the machine's screen stayed empty. The launcher runs it in the logged-on
  # user's session instead and reports whether a window actually appeared.
  $launcher = Join-Path $PSScriptRoot "personal-launch-gui.ps1"
  if (Test-Path $launcher) {
    # Under "Stop", PowerShell 5.1 turns any stderr line of a 2>&1 native call into a terminating
    # error; a failed GUI check must not fail an install the caller verifies by version anyway.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -ExePath $exe.FullName 2>&1 |
      ForEach-Object { Log $_ }
    if ($LASTEXITCODE -ne 0) { Log "the GUI could not be shown -- is anyone logged on?" }
    $ErrorActionPreference = $prevEap
  } else {
    Log "no launcher beside this script; falling back to a session 0 start"
    Start-Process $exe.FullName
  }
}
}

Log "refresh start"
Log ("args DesktopVersion=$DesktopVersion ForceRebuild=$ForceRebuild InstallerPath=$InstallerPath envVersion=$($env:T3CODE_DESKTOP_VERSION) envForce=$($env:T3_FORCE_REBUILD)")

$staged = Join-Path $env:USERPROFILE "dev\MT-Code-x64.exe"
if ($InstallerPath) {
  if (-not (Test-Path $InstallerPath)) {
    Log "installer not found: $InstallerPath"
    exit 1
  }
  Log "installing prebuilt $InstallerPath (no rebuild)"
  Copy-Item $InstallerPath $staged -Force
  Log "staged installer $staged"
  Install-MtCode -InstallerPath $InstallerPath
  if ($BuiltSha) { Set-Content -Path $stateFile -Value $BuiltSha -Encoding ascii }
  Log "refresh done"
  exit 0
}

$productRepoUrl = "https://github.com/munimtechnologies/mtcode.git"
if (-not (Test-Path $repo)) {
  git clone --branch main --single-branch $productRepoUrl $repo
}
Set-Location $repo

# A checkout made before the repo moved still points at the old remote, where
# "main" does not resolve. Left alone, the fetch fails, rev-parse errors, and
# the build silently ships whatever commit this machine happened to be sitting
# on - which is how Blade and Dell ended up a day behind while reporting the
# new version number.
$currentRemote = (git remote get-url origin 2>$null)
if ($LASTEXITCODE -ne 0) {
  git remote add origin $productRepoUrl
} elseif ($currentRemote.Trim() -ne $productRepoUrl) {
  Log "origin was $currentRemote - repointing at $productRepoUrl"
  git remote set-url origin $productRepoUrl
}

# A single-branch clone from the old repo carries a refspec that no longer
# writes refs/remotes/origin/main, so a bare `git fetch origin main` only
# updates FETCH_HEAD and origin/main stays missing. Restate the refspec so the
# tracking ref exists on every machine, however its clone was made.
git config remote.origin.fetch "+refs/heads/main:refs/remotes/origin/main"
git fetch origin main
if ($LASTEXITCODE -ne 0) {
  Log "fetch from origin failed - refusing to build a stale checkout"
  exit 1
}
$new = (git rev-parse origin/main 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($new)) {
  # Fall back to what the fetch just brought down rather than building
  # whatever this machine was sitting on.
  $new = (git rev-parse FETCH_HEAD 2>$null)
}
if ([string]::IsNullOrWhiteSpace($new)) {
  Log "could not resolve the product branch - refusing to build a stale checkout"
  exit 1
}
$new = $new.Trim()
$old = ""
if (Test-Path $stateFile) {
  $old = (Get-Content $stateFile -Raw).Trim()
}
Log "origin/main=$new previously=$old"

$force = [string]$env:T3_FORCE_REBUILD
if (($new -eq $old) -and ($force -ne "1")) {
  if (Test-Path $staged) {
    Log "no changes - skipping rebuild"
    exit 0
  }
  Log "no changes but staged installer missing - rebuilding"
}

git checkout -B main $new
git reset --hard $new

# Bake Connect public client config into desktop artifacts (gitignored .env).
# Without this, hasCloudPublicConfig() is false and Connect UI is omitted.
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Log "created .env from .env.example for T3 Connect"
}

if (-not $env:T3CODE_DESKTOP_VERSION) {
  # Avoid jq regex on Windows; parse JSON in PowerShell.
  $releases = ConvertFrom-Json -InputObject (gh api "repos/pingdotgg/t3code/releases" --paginate)
  $nightly = $releases |
    Where-Object { $_.prerelease -eq $true -and $_.tag_name -match "nightly" } |
    Sort-Object { [datetime]$_.published_at } -Descending |
    Select-Object -First 1
  if (-not $nightly -or -not $nightly.tag_name) {
    $env:T3CODE_DESKTOP_VERSION = (node -p "require('./apps/desktop/package.json').version.replace(/-nightly\\.[0-9.]+$/, '')")
  } else {
    $env:T3CODE_DESKTOP_VERSION = ([string]$nightly.tag_name).TrimStart("v")
  }
}
$env:T3CODE_DESKTOP_VERSION = $env:T3CODE_DESKTOP_VERSION -replace '-nightly\.\d{8}\.\d+$', ''
Log "T3CODE_DESKTOP_VERSION=$($env:T3CODE_DESKTOP_VERSION)"

Log ("HEAD=" + (git rev-parse --short HEAD) + " " + (git log -1 --oneline))
# pnpm writes progress to stderr; with Stop that becomes a terminating error.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
# The stamp script imports workspace packages, so a clone without node_modules
# (cleaned to free disk) must install before it, not only inside the build.
& pnpm install --frozen-lockfile *>> $log
if ($LASTEXITCODE -ne 0) {
  Log "dependency install failed exit=$LASTEXITCODE"
  exit $LASTEXITCODE
}
# Align package versions like upstream's release workflow, so the bundled
# server and web report this version instead of the stale package.json one.
& node scripts/update-release-package-versions.ts $env:T3CODE_DESKTOP_VERSION *>> $log
if ($LASTEXITCODE -ne 0) {
  Log "version stamp failed exit=$LASTEXITCODE"
  exit $LASTEXITCODE
}
& pnpm dist:desktop:win:x64 *>> $log
$buildExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($buildExit -ne 0) {
  Log "build failed exit=$buildExit"
  exit $buildExit
}
# The stamp is build input only; keep the clone clean.
git checkout -- apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json

$installerPath = Get-ChildItem (Join-Path $repo "release\MT-Code-*-x64.exe") |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName
Copy-Item $installerPath $staged -Force
Log "staged installer $staged"
Install-MtCode -InstallerPath $installerPath
Set-Content -Path $stateFile -Value $new -Encoding ascii
Log "refresh done"
exit 0
