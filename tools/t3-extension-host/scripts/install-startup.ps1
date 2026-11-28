$ErrorActionPreference = 'Stop'

$launch = (Resolve-Path (Join-Path $PSScriptRoot 'launch.vbs')).Path
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'T3 Extension Host.vbs'
$taskName = 'T3 Extension Host Watchdog'

$vbsString = '"wscript.exe ""' + $launch + '"""'
Set-Content -Path $startup -Value ('CreateObject("WScript.Shell").Run ' + $vbsString + ', 0, False') -Encoding Unicode
Write-Host "Installed $startup"

# Restarts the host if it stopped; a second instance exits at once, so repeating this is cheap.
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $launch + '"')
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Restarts T3 Extension Host if it is not running.' -Force | Out-Null
Write-Host "Installed scheduled task '$taskName' (checks every 10 minutes)"

Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $launch + '"')
Write-Host 'T3 Extension Host is running and will start at login.'
