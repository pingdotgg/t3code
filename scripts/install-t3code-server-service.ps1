#Requires -RunAsAdministrator

param(
  [switch]$StopExistingPortOwner
)

$ErrorActionPreference = "Stop"

$ServiceName = "t3code-server"
$DisplayName = "t3code server"
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$StartScript = Join-Path $RepoRoot "scripts\start-t3code-server.cmd"
$LogDir = Join-Path $RepoRoot "logs"
$NssmCommand = Get-Command nssm.exe -ErrorAction SilentlyContinue
$Nssm = if ($NssmCommand) { $NssmCommand.Source } else { $null }
$OldScheduledTaskName = "t3code-server"
$LocalUrl = "http://127.0.0.1:3773/"
$PublicUrl = "https://t3.olumbe.com/"
$BridgeStatusUrl = "https://t3.olumbe.com/api/execution/runs/status"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-FileExists {
  param(
    [string]$Path,
    [string]$Description
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Description not found at: $Path"
  }
}

function Get-PortOwner {
  $connection = Get-NetTCPConnection -LocalPort 3773 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $connection) {
    return $null
  }
  Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)"
}

function Get-HttpStatus {
  param(
    [string]$Method,
    [string]$Url
  )
  $status = & curl.exe -sS -o NUL -w "%{http_code}" -X $Method --max-time 15 $Url
  if ($LASTEXITCODE -ne 0) {
    throw "curl failed for $Method $Url"
  }
  [int]$status
}

Write-Step "Checking prerequisites"
Assert-FileExists -Path $StartScript -Description "T3 server start script"
if (-not $Nssm) {
  throw "nssm.exe was not found on PATH. Install it with: winget install NSSM.NSSM"
}
if (-not (Test-Path -LiteralPath $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}
Write-Host "Repo root: $RepoRoot"
Write-Host "NSSM: $Nssm"

Write-Step "Stopping existing $ServiceName service if present"
$ExistingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($ExistingService) {
  if ($ExistingService.Status -ne "Stopped") {
    & $Nssm stop $ServiceName | Write-Host
    Start-Sleep -Seconds 3
  }

  Write-Step "Removing existing $ServiceName service"
  & $Nssm remove $ServiceName confirm | Write-Host
  Start-Sleep -Seconds 3
}

Write-Step "Stopping old scheduled task if present"
$OldTask = Get-ScheduledTask -TaskName $OldScheduledTaskName -ErrorAction SilentlyContinue
if ($OldTask) {
  Stop-ScheduledTask -TaskName $OldScheduledTaskName -ErrorAction SilentlyContinue
}

$PortOwner = Get-PortOwner
if ($PortOwner) {
  Write-Host "Port 3773 is currently owned by PID $($PortOwner.ProcessId): $($PortOwner.CommandLine)"
  if ($StopExistingPortOwner) {
    Write-Step "Stopping existing port owner"
    Stop-Process -Id $PortOwner.ProcessId -Force
    Start-Sleep -Seconds 3
  } else {
    throw "Port 3773 is already in use. Stop the current dev/server process, or rerun this script with -StopExistingPortOwner."
  }
}

Write-Step "Creating $ServiceName service with NSSM"
& $Nssm install $ServiceName "$env:ComSpec" "/c `"$StartScript`"" | Write-Host
& $Nssm set $ServiceName DisplayName $DisplayName | Write-Host
& $Nssm set $ServiceName AppDirectory $RepoRoot | Write-Host
& $Nssm set $ServiceName Start SERVICE_AUTO_START | Write-Host
& $Nssm set $ServiceName AppExit Default Restart | Write-Host
& $Nssm set $ServiceName AppRestartDelay 5000 | Write-Host
& $Nssm set $ServiceName AppStdout (Join-Path $LogDir "t3code-server-service.out.log") | Write-Host
& $Nssm set $ServiceName AppStderr (Join-Path $LogDir "t3code-server-service.err.log") | Write-Host
& $Nssm set $ServiceName AppRotateFiles 1 | Write-Host
& $Nssm set $ServiceName AppRotateOnline 1 | Write-Host
& $Nssm set $ServiceName AppRotateBytes 10485760 | Write-Host
& $Nssm set $ServiceName AppStopMethodConsole 15000 | Write-Host
& $Nssm set $ServiceName AppStopMethodWindow 15000 | Write-Host

Write-Step "Starting $ServiceName"
& $Nssm start $ServiceName | Write-Host
Start-Sleep -Seconds 10

$Service = Get-Service -Name $ServiceName
Write-Host "Service status: $($Service.Status)"
if ($Service.Status -ne "Running") {
  throw "$ServiceName did not reach Running status. Check logs\t3code-server.log and logs\t3code-server-service.err.log."
}

Write-Step "Verifying local server"
$LocalStatus = Get-HttpStatus -Method "HEAD" -Url $LocalUrl
Write-Host "$LocalUrl -> HTTP $LocalStatus"
if ($LocalStatus -lt 200 -or $LocalStatus -ge 400) {
  throw "$LocalUrl returned HTTP $LocalStatus"
}

Write-Step "Verifying public tunnel"
$PublicStatus = Get-HttpStatus -Method "HEAD" -Url $PublicUrl
Write-Host "$PublicUrl -> HTTP $PublicStatus"
if ($PublicStatus -lt 200 -or $PublicStatus -ge 400) {
  throw "$PublicUrl returned HTTP $PublicStatus"
}

Write-Step "Verifying unauthenticated bridge route"
$BridgeStatus = Get-HttpStatus -Method "POST" -Url $BridgeStatusUrl
Write-Host "$BridgeStatusUrl -> HTTP $BridgeStatus"
if ($BridgeStatus -ne 401) {
  throw "Expected bridge status route to return 401 without auth, got HTTP $BridgeStatus."
}

Write-Step "Disabling old scheduled server task if present"
if ($OldTask) {
  Disable-ScheduledTask -TaskName $OldScheduledTaskName | Out-Null
  Write-Host "Disabled scheduled task: $OldScheduledTaskName"
} else {
  Write-Host "Old scheduled task not found: $OldScheduledTaskName"
}

Write-Step "Done"
Get-Service -Name $ServiceName | Format-Table -AutoSize
