#Requires -RunAsAdministrator

param(
  [int]$IntervalMinutes = 5
)

$ErrorActionPreference = "Stop"

$TaskName = "t3code-orchestrator-health"
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$MonitorScript = Join-Path $RepoRoot "scripts\run-orchestrator-health-monitor.cmd"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

if (-not (Test-Path -LiteralPath $MonitorScript)) {
  throw "Monitor script not found: $MonitorScript"
}

Write-Step "Creating $TaskName scheduled task"
$action = New-ScheduledTaskAction -Execute "$env:ComSpec" -Argument "/c `"$MonitorScript`"" -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 3)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Checks local T3, Cloudflare, Convex, and posts Slack ops alerts on failure." `
  -Force | Out-Null

Write-Host "Installed scheduled task: $TaskName"
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
