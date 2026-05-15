#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$ServiceName = "cloudflared-t3code"
$DisplayName = "cloudflared t3code-local"
$CloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$ConfigPath = "$env:USERPROFILE\.cloudflared\config.yml"
$TunnelName = "t3code-local"
$PublicUrl = "https://t3.olumbe.com/"
$OldScheduledTaskName = "t3code-tunnel"

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

Write-Step "Checking cloudflared binary and tunnel config"
Assert-FileExists -Path $CloudflaredPath -Description "cloudflared.exe"
Assert-FileExists -Path $ConfigPath -Description "cloudflared config.yml"

& $CloudflaredPath --version

$ConfigText = Get-Content -LiteralPath $ConfigPath -Raw
if ($ConfigText -match "service:\s*http://localhost:3773") {
  Write-Host "Rewriting tunnel service from localhost to 127.0.0.1 to avoid IPv6/dev-server ambiguity"
  $ConfigText = $ConfigText -replace "service:\s*http://localhost:3773", "service: http://127.0.0.1:3773"
  Set-Content -LiteralPath $ConfigPath -Value $ConfigText -NoNewline
}

$BinPath = "`"$CloudflaredPath`" --config `"$ConfigPath`" tunnel run $TunnelName"

Write-Step "Stopping existing $ServiceName service if present"
$ExistingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($ExistingService) {
  if ($ExistingService.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force -ErrorAction Stop
    Start-Sleep -Seconds 2
  }

  Write-Step "Deleting existing $ServiceName service"
  sc.exe delete $ServiceName | Write-Host
  Start-Sleep -Seconds 3
}

Write-Step "Creating $ServiceName Windows service"
New-Service `
  -Name $ServiceName `
  -BinaryPathName $BinPath `
  -DisplayName $DisplayName `
  -StartupType Automatic | Out-Null

Write-Step "Configuring service restart on failure"
sc.exe failure $ServiceName reset= 60 actions= restart/5000/restart/5000/restart/5000 | Write-Host
sc.exe failureflag $ServiceName 1 | Write-Host

Write-Step "Starting $ServiceName"
Start-Service -Name $ServiceName
Start-Sleep -Seconds 8

$Service = Get-Service -Name $ServiceName
Write-Host "Service status: $($Service.Status)"
if ($Service.Status -ne "Running") {
  throw "$ServiceName did not reach Running status."
}

Write-Step "Verifying public tunnel URL"
$Response = Invoke-WebRequest -Method Head -Uri $PublicUrl -TimeoutSec 15 -MaximumRedirection 0 -ErrorAction Stop
Write-Host "$PublicUrl -> HTTP $($Response.StatusCode)"
if ($Response.StatusCode -lt 200 -or $Response.StatusCode -ge 400) {
  throw "$PublicUrl returned HTTP $($Response.StatusCode)"
}

Write-Step "Disabling old scheduled tunnel task if present"
$OldTask = Get-ScheduledTask -TaskName $OldScheduledTaskName -ErrorAction SilentlyContinue
if ($OldTask) {
  Disable-ScheduledTask -TaskName $OldScheduledTaskName | Out-Null
  Write-Host "Disabled scheduled task: $OldScheduledTaskName"
} else {
  Write-Host "Old scheduled task not found: $OldScheduledTaskName"
}

Write-Step "Done"
Get-Service -Name $ServiceName | Format-Table -AutoSize
