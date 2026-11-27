import { cliReleaseDownloadBaseUrl } from "@t3tools/shared/cliRelease";

import type { SshCommandError } from "./errors.ts";

export type RemoteHostKind = "posix" | "windows";

export interface WindowsRemoteRunnerOptions {
  readonly nodeScriptPath?: string | null;
  readonly archiveVersion?: string | null;
  readonly releaseBaseUrl?: string | null;
}

export interface WindowsRemoteLaunchScriptOptions {
  readonly stateKey: string;
  readonly launcherId: string | null;
  readonly runner?: WindowsRemoteRunnerOptions;
  readonly defaultRemotePort: number;
  readonly remotePortScanWindow: number;
  readonly readyTimeoutMs: number;
  readonly reuseReadyTimeoutMs: number;
  readonly readyProbeTimeoutMs: number;
  readonly archiveChecksumsSeconds: number;
  readonly archiveDownloadSeconds: number;
  readonly archiveLockWaitSeconds: number;
  readonly launchLockWaitSeconds: number;
  readonly updateMarkerFile: string;
  readonly updateTtlMs: number;
  readonly runtimeRecordWaitSeconds: number;
}

export function psSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildPowerShellEncodedCommandArgs(script: string): ReadonlyArray<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return [
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ];
}

export const WINDOWS_POWERSHELL_STDIN_ARGS: ReadonlyArray<string> =
  buildPowerShellEncodedCommandArgs(
    "& ([scriptblock]::Create([Console]::In.ReadToEnd())); if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  );

export const WINDOWS_CONTROL_MASTER_KEEPALIVE_ARGS: ReadonlyArray<string> =
  buildPowerShellEncodedCommandArgs("[Console]::In.ReadToEnd() | Out-Null");

const WINDOWS_SHELL_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  // cmd.exe when `sh` is missing or when `|` inside `sh -c '...'` is split by cmd.exe
  /is not recognized as an internal or external command/i,
  /operable program or batch file/i,
  // Localized Chinese Windows cmd.exe
  /不是内部或外部命令/u,
  // PowerShell / pwsh when `sh` is missing
  /The term ['"]?sh['"]? is not recognized/i,
  /CommandNotFoundException/i,
  /无法将.*sh.*项识别为/u,
];

/**
 * Returns true when a POSIX `sh` SSH invocation failed because the remote host
 * runs a Windows OpenSSH default shell (`cmd.exe` or `powershell.exe`/`pwsh.exe`)
 * that cannot execute the POSIX shell entrypoint.
 */
export function isWindowsRemoteShellError(error: SshCommandError): boolean {
  if (error.exitCode === null || error.exitCode === 0) {
    return false;
  }
  const combined = `${error.stderr}\n${error.stdout ?? ""}\n${error.message}`;
  return WINDOWS_SHELL_ERROR_PATTERNS.some((pattern) => pattern.test(combined));
}

function buildWindowsResolveRunnerSnippet(runner?: WindowsRemoteRunnerOptions): string {
  const nodeScriptPath = runner?.nodeScriptPath?.trim() || "";
  const archiveVersion = runner?.archiveVersion?.trim() || "";
  const releaseBaseUrl = cliReleaseDownloadBaseUrl("", runner?.releaseBaseUrl ?? undefined).replace(
    /\/v$/u,
    "",
  );

  return `
$T3NodeScriptPath = ${psSingleQuote(nodeScriptPath)}
$T3ArchiveVersion = ${psSingleQuote(archiveVersion)}
$T3ReleaseBaseUrl = ${psSingleQuote(releaseBaseUrl)}

function Acquire-LockFile([string]$LockPath, [int]$MaxWaitSeconds) {
  $lockDir = Split-Path -Parent $LockPath
  if (-not (Test-Path $lockDir)) {
    New-Item -ItemType Directory -Force -Path $lockDir | Out-Null
  }
  $waited = 0
  $unowned = 0
  while ($true) {
    try {
      $fs = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
      try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("$PID\`n")
        $fs.Write($bytes, 0, $bytes.Length)
      } finally {
        $fs.Dispose()
      }
      return
    } catch [System.IO.IOException] {
      $ownerRaw = ""
      try { $ownerRaw = (Get-Content -Path $LockPath -ErrorAction SilentlyContinue | Select-Object -First 1) } catch {}
      $ownerPid = 0
      if ([int]::TryParse(($ownerRaw -as [string]).Trim(), [ref]$ownerPid) -and $ownerPid -gt 0) {
        $unowned = 0
        $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
        if (-not $proc) {
          Remove-Item -Force -Path $LockPath -ErrorAction SilentlyContinue
          continue
        }
      } else {
        $unowned++
        if ($unowned -ge 5) {
          Remove-Item -Force -Path $LockPath -ErrorAction SilentlyContinue
          continue
        }
      }
      if ($waited -ge $MaxWaitSeconds) {
        throw "Lock $LockPath has been held for too long."
      }
      Start-Sleep -Seconds 1
      $waited++
    }
  }
}

function Release-LockFile([string]$LockPath) {
  try {
    $ownerRaw = (Get-Content -Path $LockPath -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (($ownerRaw -as [string]).Trim() -eq "$PID") {
      Remove-Item -Force -Path $LockPath -ErrorAction SilentlyContinue
    }
  } catch {}
}

function Resolve-T3Command([string]$T3Home, [int]$LockWaitSeconds, [int]$ChecksumsSeconds, [int]$DownloadSeconds) {
  if ($T3NodeScriptPath -ne "") {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
      throw "Remote host is missing node on PATH."
    }
    return @{ FilePath = $nodeCmd.Source; PrefixArgs = @($T3NodeScriptPath); IsNode = $true }
  }
  if ($T3ArchiveVersion -eq "") {
    throw "No t3 release version was provided for the remote runtime."
  }
  $sysCmd = Get-Command t3 -ErrorAction SilentlyContinue
  if ($sysCmd) {
    try {
      $sysVer = (& $sysCmd.Source --version 2>$null | Select-Object -First 1).Trim()
      if ($sysVer -eq "t3 v$T3ArchiveVersion") {
        return @{ FilePath = $sysCmd.Source; PrefixArgs = @(); IsNode = $false }
      }
    } catch {}
  }

  $versionsDir = Join-Path $T3Home "runtime\\versions"
  $runtimeDir = Join-Path $versionsDir $T3ArchiveVersion
  $runtimeExe = Join-Path $runtimeDir "t3.exe"
  $completeMarker = Join-Path $runtimeDir ".install-complete"

  function Test-RuntimeReady {
    if (-not (Test-Path $runtimeExe) -or -not (Test-Path $completeMarker)) { return $false }
    $markerVal = (Get-Content -Path $completeMarker -ErrorAction SilentlyContinue | Select-Object -First 1)
    return (($markerVal -as [string]).Trim() -eq $T3ArchiveVersion)
  }

  if (-not (Test-RuntimeReady)) {
    New-Item -ItemType Directory -Force -Path $versionsDir | Out-Null
    $installLock = Join-Path $versionsDir ".$T3ArchiveVersion.install.lock"
    Acquire-LockFile $installLock $LockWaitSeconds
    $stagingDir = $null
    try {
      if (-not (Test-RuntimeReady)) {
        $arch = $env:PROCESSOR_ARCHITECTURE
        if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
        switch ($arch.ToUpperInvariant()) {
          "ARM64" { $platformKey = "win32-arm64" }
          "AMD64" { $platformKey = "win32-x64" }
          default { throw "Remote host Windows $arch has no t3 release archive." }
        }
        $archiveName = "t3-$T3ArchiveVersion-$platformKey.zip"
        $stagingDir = Join-Path $versionsDir (".staging-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
        New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null

        $curlExe = Join-Path $env:SystemRoot "System32\\curl.exe"
        if (-not (Test-Path $curlExe)) {
          $curlCmd = Get-Command curl.exe -ErrorAction SilentlyContinue
          if ($curlCmd) { $curlExe = $curlCmd.Source } else { $curlExe = $null }
        }

        $checksumsUrl = "$T3ReleaseBaseUrl/v$T3ArchiveVersion/SHA256SUMS"
        $archiveUrl = "$T3ReleaseBaseUrl/v$T3ArchiveVersion/$archiveName"
        $checksumsPath = Join-Path $stagingDir "SHA256SUMS"
        $archivePath = Join-Path $stagingDir $archiveName

        function Fetch-File([string]$Url, [string]$OutFile, [int]$MaxTime) {
          if ($curlExe) {
            & $curlExe -fsSL --connect-timeout 30 --max-time $MaxTime $Url -o $OutFile
            if ($LASTEXITCODE -ne 0) {
              throw "Could not download t3 $T3ArchiveVersion from $Url."
            }
          } else {
            Invoke-WebRequest -UseBasicParsing -TimeoutSec $MaxTime -Uri $Url -OutFile $OutFile
          }
        }

        Fetch-File $checksumsUrl $checksumsPath $ChecksumsSeconds
        Fetch-File $archiveUrl $archivePath $DownloadSeconds

        $expectedHash = ""
        foreach ($line in (Get-Content -Path $checksumsPath)) {
          if ($line -match ("^([0-9a-fA-F]{64})\\s+\\*?" + [regex]::Escape($archiveName) + "$")) {
            $expectedHash = $Matches[1].ToLowerInvariant()
            break
          }
        }
        $actualHash = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expectedHash -eq "" -or $actualHash -ne $expectedHash) {
          throw "Checksum mismatch for $archiveName."
        }

        $tarExe = Join-Path $env:SystemRoot "System32\\tar.exe"
        if (Test-Path $tarExe) {
          & $tarExe -xf $archivePath -C $stagingDir --strip-components=1
          if ($LASTEXITCODE -ne 0) {
            throw "Failed to extract $archiveName using tar.exe."
          }
        } else {
          $extractTmp = Join-Path $stagingDir ".extract"
          Expand-Archive -Path $archivePath -DestinationPath $extractTmp -Force
          $inner = Get-ChildItem -Path $extractTmp -Directory | Select-Object -First 1
          $srcDir = if ($inner) { $inner.FullName } else { $extractTmp }
          Get-ChildItem -Path $srcDir -Force | Move-Item -Destination $stagingDir -Force
          Remove-Item -Recurse -Force -Path $extractTmp -ErrorAction SilentlyContinue
        }

        Remove-Item -Force -Path $archivePath, $checksumsPath -ErrorAction SilentlyContinue
        $stagedExe = Join-Path $stagingDir "t3.exe"
        if (-not (Test-Path $stagedExe)) {
          throw "The t3 $T3ArchiveVersion archive did not contain t3.exe."
        }
        & $stagedExe --version *> $null
        if ($LASTEXITCODE -ne 0) {
          throw "The t3 $T3ArchiveVersion executable does not run on this host."
        }
        [System.IO.File]::WriteAllText((Join-Path $stagingDir ".install-complete"), "$T3ArchiveVersion\`n")
        if (Test-Path $runtimeDir) {
          Remove-Item -Recurse -Force -Path $runtimeDir
        }
        Move-Item -Path $stagingDir -Destination $runtimeDir
        $stagingDir = $null
      }
    } finally {
      if ($stagingDir -and (Test-Path $stagingDir)) {
        Remove-Item -Recurse -Force -Path $stagingDir -ErrorAction SilentlyContinue
      }
      Release-LockFile $installLock
    }
  }

  return @{ FilePath = $runtimeExe; PrefixArgs = @(); IsNode = $false }
}
`;
}

export function buildWindowsRemoteLaunchScript(options: WindowsRemoteLaunchScriptOptions): string {
  const resolveSnippet = buildWindowsResolveRunnerSnippet(options.runner);
  return `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
${resolveSnippet}
$StateKey = ${psSingleQuote(options.stateKey)}
$LauncherId = ${psSingleQuote(options.launcherId ?? "")}
$HomeDir = [Environment]::GetFolderPath("UserProfile")
$T3Home = Join-Path $HomeDir ".t3"
$StateDir = Join-Path $T3Home "ssh-launch\\$StateKey"
$DefaultRuntimeFile = Join-Path $T3Home "userdata\\server-runtime.json"
$PortFile = Join-Path $StateDir "port"
$PidFile = Join-Path $StateDir "pid"
$ManagedFile = Join-Path $StateDir "managed"
$LauncherFile = Join-Path $StateDir "launcher"
$LogFile = Join-Path $StateDir "server.log"
$ErrLogFile = Join-Path $StateDir "server.err.log"
$LaunchLock = Join-Path $T3Home "ssh-launch\\.launch.lock"

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

$t3 = Resolve-T3Command $T3Home ${options.archiveLockWaitSeconds} ${options.archiveChecksumsSeconds} ${options.archiveDownloadSeconds}
$t3Exe = $t3.FilePath
$t3Prefix = $t3.PrefixArgs

function Invoke-T3([string[]]$CmdArgs) {
  $all = @($t3Prefix) + $CmdArgs
  & $t3Exe @all
}

function Read-Trimmed([string]$Path) {
  if (-not (Test-Path $Path)) { return "" }
  $v = Get-Content -Path $Path -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $v) { return "" }
  return ($v -as [string]).Trim()
}

function Write-Line([string]$Path, [string]$Value) {
  [System.IO.File]::WriteAllText($Path, "$Value\`n")
}

function Test-PidAlive([string]$PidStr) {
  $p = 0
  if (-not [int]::TryParse($PidStr, [ref]$p) -or $p -le 0) { return $false }
  return $null -ne (Get-Process -Id $p -ErrorAction SilentlyContinue)
}

function Wait-Ready([string]$Port, [int]$TimeoutMs) {
  Invoke-T3 @("__ssh-helper", "wait-ready", $Port, "$TimeoutMs", "${options.readyProbeTimeoutMs}") *> $null
  return $LASTEXITCODE
}

function Resolve-DefaultRuntimePort {
  $out = Invoke-T3 @("__ssh-helper", "runtime-port", $DefaultRuntimeFile) 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  $line = (($out | Select-Object -First 1) -as [string]).Trim()
  $parts = $line -split "\\s+"
  if ($parts.Length -ge 2) {
    return @{ Pid = $parts[0]; Port = $parts[1] }
  }
  return $null
}

Acquire-LockFile $LaunchLock ${options.launchLockWaitSeconds}
try {
  $remotePid = Read-Trimmed $PidFile
  $remotePort = Read-Trimmed $PortFile
  $remoteManaged = Read-Trimmed $ManagedFile
  $recordedLauncher = Read-Trimmed $LauncherFile
  $foreignLauncher = ($LauncherId -ne "" -and $recordedLauncher -ne "" -and $recordedLauncher -ne $LauncherId)
  if (-not $foreignLauncher -and $LauncherId -ne "") {
    Write-Line $LauncherFile $LauncherId
  }

  $defaultRuntime = Resolve-DefaultRuntimePort
  if ($defaultRuntime -and $remoteManaged -eq "managed" -and $defaultRuntime.Pid -eq $remotePid) {
    $remotePort = $defaultRuntime.Port
    Write-Line $PortFile $remotePort
  } elseif ($defaultRuntime) {
    if ((Wait-Ready $defaultRuntime.Port ${options.reuseReadyTimeoutMs}) -eq 0) {
      if ($remoteManaged -eq "managed" -and (Test-PidAlive $remotePid)) {
        Stop-Process -Id ([int]$remotePid) -Force -ErrorAction SilentlyContinue
      }
      $remotePid = ""
      $remotePort = $defaultRuntime.Port
      $remoteManaged = "external"
      Remove-Item -Force -Path $PidFile -ErrorAction SilentlyContinue
      Write-Line $PortFile $remotePort
      Write-Line $ManagedFile "external"
    }
  }

  if ($remoteManaged -eq "external") {
    if ($remotePort -eq "" -or (Wait-Ready $remotePort ${options.reuseReadyTimeoutMs}) -ne 0) {
      $remotePid = ""
      $remotePort = ""
      $remoteManaged = ""
    }
  } elseif ($remotePort -ne "" -and (Test-PidAlive $remotePid)) {
    if ((Wait-Ready $remotePort ${options.readyTimeoutMs}) -ne 0) {
      throw "Remote T3 server is still running but did not become ready. Retry the connection; the server was left running."
    }
    if ($foreignLauncher) {
      $remoteManaged = "external"
    }
  } else {
    $remotePid = ""
    $remotePort = ""
    $remoteManaged = ""
  }

  if ($remotePort -eq "") {
    $picked = Invoke-T3 @("__ssh-helper", "pick-port", $PortFile, "${options.defaultRemotePort}", "${options.remotePortScanWindow}") 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $picked) {
      throw "Failed to find an available port on the remote host."
    }
    $remotePort = (($picked | Select-Object -First 1) -as [string]).Trim()
    Remove-Item -Force -Path $LogFile, $ErrLogFile -ErrorAction SilentlyContinue

    $prevNoBrowser = $env:T3CODE_NO_BROWSER
    $env:T3CODE_NO_BROWSER = "1"
    try {
      $serveArgs = @($t3Prefix) + @("serve", "--host", "127.0.0.1", "--port", $remotePort, "--base-dir", $T3Home)
      $proc = Start-Process -FilePath $t3Exe -ArgumentList $serveArgs -WindowStyle Hidden -RedirectStandardOutput $LogFile -RedirectStandardError $ErrLogFile -PassThru
    } finally {
      if ($null -eq $prevNoBrowser) { Remove-Item Env:T3CODE_NO_BROWSER -ErrorAction SilentlyContinue } else { $env:T3CODE_NO_BROWSER = $prevNoBrowser }
    }

    $remotePid = "$($proc.Id)"
    $remoteManaged = "managed"
    Write-Line $PidFile $remotePid
    Write-Line $PortFile $remotePort
    Write-Line $ManagedFile "managed"
    if ($LauncherId -ne "") {
      Write-Line $LauncherFile $LauncherId
    } else {
      Remove-Item -Force -Path $LauncherFile -ErrorAction SilentlyContinue
    }

    if ((Wait-Ready $remotePort ${options.readyTimeoutMs}) -ne 0) {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      Remove-Item -Force -Path $PidFile, $PortFile, $ManagedFile -ErrorAction SilentlyContinue
      $tail = ""
      if (Test-Path $ErrLogFile) { $tail += (Get-Content -Path $ErrLogFile -Tail 40 -ErrorAction SilentlyContinue) -join "\`n" }
      if (Test-Path $LogFile) { $tail += "\`n" + ((Get-Content -Path $LogFile -Tail 40 -ErrorAction SilentlyContinue) -join "\`n") }
      if ($tail.Trim() -ne "") { [Console]::Error.WriteLine($tail.Trim()) }
      throw "Remote T3 server did not become ready on 127.0.0.1:$remotePort."
    }

    $deadline = (Get-Date).AddSeconds(${options.runtimeRecordWaitSeconds})
    while ((Get-Date) -lt $deadline) {
      $rt = Resolve-DefaultRuntimePort
      if ($rt -and $rt.Port -eq $remotePort) {
        if ($rt.Pid -ne $remotePid) {
          $remotePid = $rt.Pid
          Write-Line $PidFile $remotePid
        }
        break
      }
      Start-Sleep -Milliseconds 100
    }
  }

  $kind = if ($remoteManaged -ne "") { $remoteManaged } else { "managed" }
  Write-Output ("{\`"remotePort\`":$remotePort,\`"serverKind\`":\`"$kind\`"}")
} finally {
  Release-LockFile $LaunchLock
}
`;
}

export function buildWindowsRemotePairingScript(options: {
  readonly stateKey: string;
  readonly runner?: WindowsRemoteRunnerOptions;
  readonly archiveChecksumsSeconds: number;
  readonly archiveDownloadSeconds: number;
  readonly archiveLockWaitSeconds: number;
}): string {
  const resolveSnippet = buildWindowsResolveRunnerSnippet(options.runner);
  return `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
${resolveSnippet}
$HomeDir = [Environment]::GetFolderPath("UserProfile")
$T3Home = Join-Path $HomeDir ".t3"
$t3 = Resolve-T3Command $T3Home ${options.archiveLockWaitSeconds} ${options.archiveChecksumsSeconds} ${options.archiveDownloadSeconds}
$all = @($t3.PrefixArgs) + @("auth", "pairing", "create", "--base-dir", $T3Home, "--json")
& $t3.FilePath @all
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`;
}

export function buildWindowsRemoteStopScript(options: {
  readonly stateKey: string;
  readonly launcherId: string | null;
}): string {
  return `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$StateKey = ${psSingleQuote(options.stateKey)}
$LauncherId = ${psSingleQuote(options.launcherId ?? "")}
$HomeDir = [Environment]::GetFolderPath("UserProfile")
$StateDir = Join-Path $HomeDir ".t3\\ssh-launch\\$StateKey"
$PidFile = Join-Path $StateDir "pid"
$PortFile = Join-Path $StateDir "port"
$ManagedFile = Join-Path $StateDir "managed"
$LauncherFile = Join-Path $StateDir "launcher"

function Read-Trimmed([string]$Path) {
  if (-not (Test-Path $Path)) { return "" }
  $v = Get-Content -Path $Path -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $v) { return "" }
  return ($v -as [string]).Trim()
}

$recordedLauncher = Read-Trimmed $LauncherFile
if ($LauncherId -ne "" -and $recordedLauncher -ne "" -and $recordedLauncher -ne $LauncherId) {
  Write-Output '{"stopped":false}'
  exit 0
}
$remoteManaged = Read-Trimmed $ManagedFile
$remotePidStr = Read-Trimmed $PidFile
$remotePid = 0
if ($remoteManaged -ne "external" -and [int]::TryParse($remotePidStr, [ref]$remotePid) -and $remotePid -gt 0) {
  $proc = Get-Process -Id $remotePid -ErrorAction SilentlyContinue
  if ($proc) {
    Stop-Process -Id $remotePid -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20; $i++) {
      if (-not (Get-Process -Id $remotePid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 100
    }
    if (Get-Process -Id $remotePid -ErrorAction SilentlyContinue) {
      throw "Remote T3 server with PID $remotePid did not stop within 2 seconds. Its ownership files were kept."
    }
  }
}
Remove-Item -Force -Path $PidFile, $PortFile, $ManagedFile -ErrorAction SilentlyContinue
Write-Output '{"stopped":true}'
`;
}

export function buildWindowsRemoteLogTailScript(stateKey: string): string {
  return `$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"
$HomeDir = [Environment]::GetFolderPath("UserProfile")
$StateDir = Join-Path $HomeDir ".t3\\ssh-launch\\${stateKey}"
$LogFile = Join-Path $StateDir "server.log"
$ErrLogFile = Join-Path $StateDir "server.err.log"
if (Test-Path $LogFile) { Get-Content -Path $LogFile -Tail 80 }
if (Test-Path $ErrLogFile) { Get-Content -Path $ErrLogFile -Tail 80 }
`;
}
