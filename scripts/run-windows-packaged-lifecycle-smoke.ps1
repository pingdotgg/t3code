param(
  [Parameter(Mandatory = $true)][string]$ArtifactDir,
  [Parameter(Mandatory = $true)][string]$Distro,
  [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Assert-ProcessGone {
  param([Nullable[int]]$ProcessId, [string]$Label)
  if ($null -eq $ProcessId -or $ProcessId -le 0) { return }
  $existing = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    throw "$Label process $ProcessId survived packaged lifecycle shutdown ($($existing.ProcessName))."
  }
}

function Assert-PortBindable {
  param([int]$Port)
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  try {
    $listener.Start()
  } catch {
    throw "Windows backend port $Port remained unavailable after packaged lifecycle shutdown: $($_.Exception.Message)"
  } finally {
    try { $listener.Stop() } catch {}
  }
}

function Write-SmokeLogs {
  param([string]$StdoutPath, [string]$StderrPath)
  if (Test-Path $StdoutPath) {
    Write-Host "=== packaged smoke stdout ==="
    Get-Content $StdoutPath
  }
  if (Test-Path $StderrPath) {
    Write-Host "=== packaged smoke stderr ==="
    Get-Content $StderrPath
  }
}

$resolvedArtifactDir = (Resolve-Path $ArtifactDir).Path
$artifacts = @(Get-ChildItem -Path $resolvedArtifactDir -Filter "T3-Code-*.exe" -File)
if ($artifacts.Count -ne 1) {
  throw "Expected exactly one portable T3 Code executable under '$resolvedArtifactDir', found $($artifacts.Count)."
}

$smokeRoot = Join-Path $env:RUNNER_TEMP "T3 Code José QA\packaged lifecycle"
if (Test-Path $smokeRoot) {
  Remove-Item -Recurse -Force $smokeRoot
}
$artifactRunDir = Join-Path $smokeRoot "artifact üñíçødé path"
$stateDir = Join-Path $smokeRoot "state home Ω"
$receiptPath = Join-Path $smokeRoot "receipt lifecycle.json"
$stdoutPath = Join-Path $smokeRoot "packaged stdout.log"
$stderrPath = Join-Path $smokeRoot "packaged stderr.log"
New-Item -ItemType Directory -Force -Path $artifactRunDir, $stateDir | Out-Null
$executablePath = Join-Path $artifactRunDir $artifacts[0].Name
Copy-Item -Force $artifacts[0].FullName $executablePath

$port = Get-FreeTcpPort
$environmentNames = @(
  "T3CODE_DESKTOP_PACKAGED_SMOKE",
  "T3CODE_DESKTOP_PACKAGED_SMOKE_RECEIPT",
  "T3CODE_DESKTOP_PACKAGED_SMOKE_WSL_DISTRO",
  "T3CODE_HOME",
  "T3CODE_PORT",
  "T3CODE_DISABLE_AUTO_UPDATE"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

try {
  $env:T3CODE_DESKTOP_PACKAGED_SMOKE = "1"
  $env:T3CODE_DESKTOP_PACKAGED_SMOKE_RECEIPT = $receiptPath
  $env:T3CODE_DESKTOP_PACKAGED_SMOKE_WSL_DISTRO = $Distro
  $env:T3CODE_HOME = $stateDir
  $env:T3CODE_PORT = [string]$port
  $env:T3CODE_DISABLE_AUTO_UPDATE = "true"

  Write-Host "Launching packaged artifact from: $executablePath"
  Write-Host "Smoke state path: $stateDir"
  Write-Host "Requested Windows backend port: $port"
  Write-Host "Requested WSL distro: $Distro"

  $startArgs = @{
    FilePath = $executablePath
    WorkingDirectory = $artifactRunDir
    RedirectStandardOutput = $stdoutPath
    RedirectStandardError = $stderrPath
    PassThru = $true
  }
  $process = Start-Process @startArgs

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $wrapperExitedAt = $null
  while (-not (Test-Path $receiptPath)) {
    $process.Refresh()
    if ($process.HasExited) {
      if ($process.ExitCode -ne 0) {
        Write-SmokeLogs -StdoutPath $stdoutPath -StderrPath $stderrPath
        throw "Packaged portable wrapper exited with code $($process.ExitCode) before producing a lifecycle receipt."
      }
      if ($null -eq $wrapperExitedAt) {
        # electron-builder's portable wrapper may hand off to the extracted app.
        # Give the real Electron child a bounded window to publish its receipt.
        $wrapperExitedAt = [DateTime]::UtcNow
      } elseif ([DateTime]::UtcNow -ge $wrapperExitedAt.AddSeconds(30)) {
        Write-SmokeLogs -StdoutPath $stdoutPath -StderrPath $stderrPath
        throw "Portable wrapper exited successfully, but no packaged lifecycle receipt appeared within 30 seconds."
      }
    }
    if ([DateTime]::UtcNow -ge $deadline) {
      if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null }
      Write-SmokeLogs -StdoutPath $stdoutPath -StderrPath $stderrPath
      throw "Timed out after $TimeoutSeconds seconds waiting for packaged lifecycle receipt."
    }
    Start-Sleep -Milliseconds 500
  }

  $receipt = Get-Content -Raw $receiptPath | ConvertFrom-Json -Depth 20
  if ($receipt.status -ne "success") { throw "Packaged lifecycle receipt status was '$($receipt.status)'." }
  if ($receipt.schemaVersion -ne 1) { throw "Unexpected packaged lifecycle receipt schema $($receipt.schemaVersion)." }
  if ($receipt.app.isPackaged -ne $true) { throw "Smoke did not execute from a packaged Electron artifact." }
  if ($receipt.app.platform -ne "win32") { throw "Smoke platform was '$($receipt.app.platform)', expected win32." }
  if ($receipt.requestedWslDistro -ne $Distro) { throw "Receipt WSL distro mismatch." }
  if ($receipt.windowsBackend.snapshot.ready -ne $true) { throw "Windows backend never reached ready state." }
  if ($null -eq $receipt.windowsBackend.pid) { throw "Windows backend receipt is missing its PID." }
  if (-not ([string]$receipt.app.appRoot).EndsWith("app.asar", [StringComparison]::OrdinalIgnoreCase)) { throw "Packaged app root was not app.asar: $($receipt.app.appRoot)" }
  if ([string]$receipt.app.stateDir -notlike "*state home Ω*") { throw "Packaged state directory did not preserve the Unicode/spaces smoke path." }
  if ([string]$receipt.windowsBackend.entryPath -notlike "*app.asar*apps*server*dist*bin.mjs") { throw "Windows backend did not launch through app.asar: $($receipt.windowsBackend.entryPath)" }
  if ($null -eq $receipt.wslBackend) { throw "WSL backend receipt is missing." }
  if ($receipt.wslBackend.snapshot.ready -ne $true) { throw "WSL backend never reached ready state." }
  if ($receipt.wslBackend.runningDistro -ne $Distro) { throw "WSL backend ran in '$($receipt.wslBackend.runningDistro)', expected '$Distro'." }
  if ([string]$receipt.wslBackend.entryPath -notlike "*app.asar.unpacked*apps*server*dist*bin.mjs") { throw "WSL backend did not launch through app.asar.unpacked: $($receipt.wslBackend.entryPath)" }
  if ([string]::IsNullOrWhiteSpace([string]$receipt.wslBackend.wslNodePath)) { throw "WSL backend did not report the bundled Linux Node path." }
  if ([string]$receipt.wslBackend.wslNodePath -like "/mnt/*") { throw "WSL backend executed Node from a Windows mount instead of its Linux cache: $($receipt.wslBackend.wslNodePath)" }
  if ($receipt.restartCycle.windowsBackend.snapshot.ready -ne $true) { throw "Windows backend failed packaged restart verification." }
  if ($null -eq $receipt.restartCycle.wslBackend -or $receipt.restartCycle.wslBackend.snapshot.ready -ne $true) { throw "WSL backend failed packaged restart verification." }
  if ($receipt.restartCycle.wslBackend.runningDistro -ne $Distro) { throw "Restarted WSL backend changed distro unexpectedly." }

  foreach ($entry in @($receipt.afterFirstStop)) {
    if ($entry.snapshot.ready -eq $true -or $entry.snapshot.desiredRunning -eq $true -or $null -ne $entry.snapshot.activePid) {
      throw "Backend '$($entry.id)' remained active after first stop: $($entry.snapshot | ConvertTo-Json -Compress)"
    }
  }
  foreach ($entry in @($receipt.afterStop)) {
    if ($entry.snapshot.ready -eq $true -or $entry.snapshot.desiredRunning -eq $true -or $null -ne $entry.snapshot.activePid) {
      throw "Backend '$($entry.id)' remained active after stop: $($entry.snapshot | ConvertTo-Json -Compress)"
    }
  }

  # The receipt is written immediately before app.quit(). Use the actual Electron
  # PID from that receipt as the authority; a portable NSIS wrapper may be a
  # different process and may already have handed off.
  $appExitDeadline = [DateTime]::UtcNow.AddSeconds(30)
  while ($null -ne (Get-Process -Id $receipt.app.pid -ErrorAction SilentlyContinue)) {
    if ([DateTime]::UtcNow -ge $appExitDeadline) {
      & taskkill.exe /PID $receipt.app.pid /T /F 2>$null | Out-Null
      throw "Packaged Electron process $($receipt.app.pid) did not exit within 30 seconds after the lifecycle receipt."
    }
    Start-Sleep -Milliseconds 250
  }

  $process.Refresh()
  if (-not $process.HasExited) {
    if (-not $process.WaitForExit(30000)) {
      & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
      throw "Packaged portable wrapper did not exit within 30 seconds after Electron shutdown."
    }
  }
  if ($process.ExitCode -ne 0) {
    Write-SmokeLogs -StdoutPath $stdoutPath -StderrPath $stderrPath
    throw "Packaged portable wrapper exited with code $($process.ExitCode)."
  }

  Assert-ProcessGone -ProcessId $receipt.app.pid -Label "Electron"
  Assert-ProcessGone -ProcessId $receipt.windowsBackend.pid -Label "Windows backend first cycle"
  Assert-ProcessGone -ProcessId $receipt.wslBackend.pid -Label "WSL launcher first cycle"
  Assert-ProcessGone -ProcessId $receipt.restartCycle.windowsBackend.pid -Label "Windows backend restart cycle"
  Assert-ProcessGone -ProcessId $receipt.restartCycle.wslBackend.pid -Label "WSL launcher restart cycle"
  Assert-PortBindable -Port ([int]$receipt.windowsBackend.port)

  $wslUri = [Uri]$receipt.wslBackend.httpBaseUrl
  $tcp = [System.Net.Sockets.TcpClient]::new()
  try {
    $connect = $tcp.ConnectAsync($wslUri.Host, $wslUri.Port)
    if ($connect.Wait(2000) -and $tcp.Connected) {
      throw "WSL backend TCP endpoint remained reachable after shutdown: $($receipt.wslBackend.httpBaseUrl)"
    }
  } catch {
    if ($_.Exception.Message -like "WSL backend TCP endpoint remained reachable*") { throw }
  } finally {
    $tcp.Dispose()
  }

  Write-SmokeLogs -StdoutPath $stdoutPath -StderrPath $stderrPath
  Write-Host "=== packaged lifecycle receipt ==="
  Get-Content $receiptPath
  Write-Host "Packaged Windows + WSL lifecycle smoke passed."
} finally {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
  }
}
