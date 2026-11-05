# Installs a T3 Learn release with its one-line installer on a Windows runner
# and checks that it runs next to (or without) T3 Code:
#   t3-learn-install-test.ps1 <fresh|next-to-t3-code> <version>
# Screenshots and logs land in $env:ARTIFACTS.
param([string] $Scenario, [string] $Version)
$ErrorActionPreference = "Stop"
$repo = if ($env:GITHUB_REPOSITORY) { $env:GITHUB_REPOSITORY } else { "aabdel0181/t3-learn" }
$artifacts = if ($env:ARTIFACTS) { $env:ARTIFACTS } else { Join-Path $PWD "install-test" }
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }

function Log([string] $message) { Write-Host "`n== $message" }
function Fail([string] $message) { throw "FAIL: $message" }

function Screenshot([string] $name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save((Join-Path $artifacts "$name.png"))
    $graphics.Dispose(); $bitmap.Dispose()
  } catch {
    Write-Host "screenshot failed: $_"
  }
}

# Waits for the desktop app's server under a T3 home and returns its version.
function Wait-Server([string] $t3Home, [string] $ExpectedVersion = "") {
  $state = Join-Path $t3Home "userdata\server-runtime.json"
  for ($i = 0; $i -lt 180; $i++) {
    if (Test-Path $state) {
      try {
        $runtime = Get-Content -Raw $state | ConvertFrom-Json
        Invoke-WebRequest -UseBasicParsing "$($runtime.origin)/.well-known/t3/environment" | Out-Null
        if (-not $ExpectedVersion -or $runtime.serverVersion -eq $ExpectedVersion) { return $runtime.serverVersion }
      } catch {}
    }
    Start-Sleep -Seconds 1
  }
  Get-ChildItem -Recurse -Force $t3Home -ErrorAction SilentlyContinue |
    Out-File (Join-Path $artifacts "$(Split-Path -Leaf $t3Home)-tree.txt")
  Fail "no server answered under $t3Home"
}

$t3CodeVersion = $null
if ($Scenario -eq "next-to-t3-code") {
  Log "Installing upstream T3 Code"
  gh release download -R pingdotgg/t3code --pattern "T3-Code-*-$arch.exe" --dir $env:RUNNER_TEMP
  $installer = Get-ChildItem (Join-Path $env:RUNNER_TEMP "T3-Code-*-$arch.exe") | Select-Object -First 1
  $process = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait -PassThru
  if ($process.ExitCode -ne 0) { Fail "T3 Code's installer exited with $($process.ExitCode)" }
  $t3CodeDir = Join-Path $env:LOCALAPPDATA "Programs\t3code"
  $t3CodeExe = Get-ChildItem $t3CodeDir -Filter "*.exe" | Where-Object { $_.Name -notlike "Uninstall*" } | Select-Object -First 1
  Start-Process -FilePath $t3CodeExe.FullName
  $t3CodeVersion = Wait-Server (Join-Path $HOME ".t3")
  Log "T3 Code $t3CodeVersion is running"
  Screenshot "t3-code"
}

if ($Scenario -eq "fresh") {
  $previous = (gh release view -R $repo --json tagName -q .tagName 2>$null | ForEach-Object { $_ -replace '^v', '' })
  if ($previous -and $previous -ne $Version) {
    Log "Installing OminaX $previous (previous release)"
    $env:T3LEARN_VERSION = $previous
    $previousCommand = "irm https://github.com/$repo/releases/download/v$previous/install.ps1 | iex"
    powershell -NoProfile -Command $previousCommand
    if ($LASTEXITCODE -ne 0) { Fail "the previous installer failed" }
    $previousRunning = Wait-Server (Join-Path $HOME ".t3-learn") $previous
    Log "OminaX $previousRunning is running"
    $knowledge = Join-Path $HOME ".t3-learn\userdata\knowledge.json"
    '[{"topic":"install test","explanation":"kept across updates","buildsOn":[],"doneAt":"2026-11-05T00:00:00.000Z","threadId":"install-test"}]' | Set-Content $knowledge
    Copy-Item $knowledge (Join-Path $artifacts "knowledge.json")
  } else {
    Log "No distinct previous promoted release; installing OminaX $Version fresh"
  }
}

Log "Installing OminaX $Version"
$env:T3LEARN_VERSION = $Version
$installCommand = "irm https://github.com/$repo/releases/download/v$Version/install.ps1 | iex"
# A fresh PowerShell, like a user's, keeps the installer's variables out of this script.
powershell -NoProfile -Command $installCommand
if ($LASTEXITCODE -ne 0) { Fail "the installer failed" }

$learnVersion = Wait-Server (Join-Path $HOME ".t3-learn") $Version
Log "OminaX $learnVersion is running"
Start-Sleep -Seconds 5
Screenshot "t3-learn"

$learnDir = Join-Path $env:LOCALAPPDATA "Programs\t3learn"
if (-not (Test-Path (Join-Path $learnDir "OminaX.exe"))) { Fail "OminaX.exe is missing" }
$knowledge = Join-Path $HOME ".t3-learn\userdata\knowledge.json"
if (-not (Test-Path $knowledge)) {
  '[{"topic":"install test","explanation":"kept across updates","buildsOn":[],"doneAt":"2026-11-05T00:00:00.000Z","threadId":"install-test"}]' | Set-Content $knowledge
  Copy-Item $knowledge (Join-Path $artifacts "knowledge.json")
}
$uninstallKeys = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" |
  ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like "OminaX*" }
if (-not $uninstallKeys) { Fail "OminaX has no entry in Installed apps" }

if ($Scenario -eq "next-to-t3-code") {
  Log "Checking that T3 Code is untouched"
  if ((Wait-Server (Join-Path $HOME ".t3") $t3CodeVersion) -ne $t3CodeVersion) { Fail "T3 Code's server changed" }
  if (-not (Test-Path $t3CodeExe.FullName)) { Fail "T3 Code's app is gone" }
  $codeKeys = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like "T3 Code*" }
  if (-not $codeKeys) { Fail "T3 Code's entry in Installed apps is gone" }
  $handler = (Get-ItemProperty "HKCU:\Software\Classes\t3code\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
  if ($handler -and $handler -like "*\t3learn\*") { Fail "OminaX took over t3code:// links" }
}

Log "Uninstalling OminaX"
$env:T3LEARN_UNINSTALL = "1"
powershell -NoProfile -Command $installCommand
if ($LASTEXITCODE -ne 0) { Fail "the uninstaller failed" }
Remove-Item Env:T3LEARN_UNINSTALL
if (Test-Path (Join-Path $learnDir "OminaX.exe")) { Fail "OminaX is still installed" }
if (-not (Test-Path (Join-Path $HOME ".t3-learn\userdata"))) { Fail "uninstall removed OminaX's data" }
if ($Scenario -eq "next-to-t3-code") {
  if ((Wait-Server (Join-Path $HOME ".t3") $t3CodeVersion) -ne $t3CodeVersion) { Fail "T3 Code stopped after uninstalling OminaX" }
}
Log "PASS"
