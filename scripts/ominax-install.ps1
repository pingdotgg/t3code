# Installs the T3 Learn desktop app on Windows from the fork's latest GitHub
# Release. Needs only PowerShell 5.1+.
#
#   irm https://github.com/aabdel0181/t3-learn/releases/latest/download/install.ps1 | iex
#
# T3 Learn installs next to T3 Code and keeps its own data in ~\.t3-learn, so an
# existing T3 Code install, its threads and its `t3` command stay as they are.
#
# Environment:
#   T3LEARN_VERSION           exact version to install (default: the latest release)
#   T3LEARN_NO_LAUNCH         set to 1 to install without opening the app
#   T3LEARN_UNINSTALL         set to 1 to remove T3 Learn (its data stays)
#   T3LEARN_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)

# `irm | iex` runs in the caller's session; the block keeps this script's
# variables and preferences out of it, and `exit` would close the window.
& {
  $ErrorActionPreference = "Stop"
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = "aabdel0181/t3-learn"
  $baseUrl = if ($env:T3LEARN_RELEASE_BASE_URL) { $env:T3LEARN_RELEASE_BASE_URL.TrimEnd("/") } else { "https://github.com/$repo/releases/download" }
  $installDir = Join-Path $env:LOCALAPPDATA "Programs\t3learn"
  $appExe = Join-Path $installDir "OminaX.exe"
  $oldAppExe = Join-Path $installDir "T3 Learn.exe"
  $uninstaller = Join-Path $installDir "Uninstall OminaX.exe"
  $oldUninstaller = Join-Path $installDir "Uninstall T3 Learn.exe"
  $dataDir = Join-Path $HOME ".t3-learn"

  function Fail([string] $message) { throw "t3-learn install: $message" }
  function Say([string] $message) { [Console]::Error.WriteLine("  $message") }

  function Stop-T3Learn {
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase)
      })
    if ($running.Count -eq 0) { return }
    Say "Closing OminaX to update it..."
    $running | ForEach-Object { [void]$_.CloseMainWindow() }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and ($running | Where-Object { -not $_.HasExited })) {
      Start-Sleep -Milliseconds 250
    }
    $running | Where-Object { -not $_.HasExited } | Stop-Process -Force -ErrorAction SilentlyContinue
  }

  if ($env:T3LEARN_UNINSTALL -eq "1") {
    $uninstallerPath = if (Test-Path $uninstaller) { $uninstaller } elseif (Test-Path $oldUninstaller) { $oldUninstaller } else { $null }
    if ($uninstallerPath) {
      Stop-T3Learn
      $process = Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait -PassThru
      if ($process.ExitCode -ne 0) { Fail "the uninstaller exited with code $($process.ExitCode)" }
      Say "Removed OminaX."
    } else {
      Say "OminaX is not installed."
    }
    Say "Your OminaX projects and settings are still in $dataDir; delete that folder to remove them too."
    return
  }

  # PROCESSOR_ARCHITEW6432 bypasses WOW64 emulation.
  $rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $arch = switch ($rawArch) {
    "AMD64" { "x64" }
    "ARM64" { "arm64" }
    default { Fail "unsupported architecture $rawArch" }
  }

  [Console]::Error.WriteLine("`n  OminaX installer`n")
  Say "Finding the latest release..."
  $work = Join-Path ([IO.Path]::GetTempPath()) ("t3-learn-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    $sumsUrl = if ($env:T3LEARN_VERSION) {
      "$baseUrl/v$($env:T3LEARN_VERSION.TrimStart('v'))/SHA256SUMS"
    } elseif ($env:T3LEARN_RELEASE_BASE_URL) {
      "$baseUrl/latest/SHA256SUMS"
    } else {
      "https://github.com/$repo/releases/latest/download/SHA256SUMS"
    }
    $sumsPath = Join-Path $work "SHA256SUMS"
    try {
      Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsPath -UseBasicParsing
    } catch {
      Fail "could not find an OminaX release at $sumsUrl"
    }

    # sha256sum writes "<hash>  <file>", or "<hash> *<file>" in binary mode.
    $pattern = "^([0-9a-f]{64}) [ *]((?:OminaX|T3-Learn)-(.+)-$arch\.exe)$"
    $match = Get-Content $sumsPath | ForEach-Object { [regex]::Match($_.Trim(), $pattern) } |
      Where-Object { $_.Success } | Select-Object -First 1
    if (-not $match) { Fail "this release has no build for Windows $arch" }
    $expected = $match.Groups[1].Value
    $asset = $match.Groups[2].Value
    $version = $match.Groups[3].Value

    $t3Code = (Test-Path (Join-Path $env:LOCALAPPDATA "Programs\t3code")) -or (Test-Path (Join-Path $HOME ".t3"))
    if ($t3Code) { Say "Found T3 Code. It stays installed with its own data; OminaX installs next to it." }
    Say "Installing OminaX $version"

    $installer = Join-Path $work $asset
    $previousProgress = $ProgressPreference
    # Invoke-WebRequest's progress bar slows downloads in Windows PowerShell by an order of magnitude.
    $ProgressPreference = "SilentlyContinue"
    try {
      Invoke-WebRequest -Uri "$baseUrl/v$version/$asset" -OutFile $installer -UseBasicParsing
    } catch {
      Fail "could not download $asset"
    } finally {
      $ProgressPreference = $previousProgress
    }

    Say "Verifying the download..."
    $actual = (Get-FileHash -Algorithm SHA256 -Path $installer).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { Fail "checksum mismatch for $asset; try again" }

    Stop-T3Learn
    Say "Installing to $installDir..."
    $process = Start-Process -FilePath $installer -ArgumentList "/S" -Wait -PassThru
    if ($process.ExitCode -ne 0) { Fail "the installer exited with code $($process.ExitCode)" }
    if (-not (Test-Path $appExe) -and -not (Test-Path $oldAppExe)) { Fail "the installer finished but no OminaX executable is present" }
    if (-not (Test-Path $appExe)) { $appExe = $oldAppExe }

    if ($env:T3LEARN_NO_LAUNCH -ne "1") { Start-Process -FilePath $appExe }
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }

  [Console]::Error.WriteLine("`n  Installed OminaX $version")
  Say "Open it from the Start menu. It updates itself."
  Say "Projects and settings live in $dataDir."
  [Console]::Error.WriteLine()
}
