$ErrorActionPreference = 'Stop'

$node = (Get-Command node -ErrorAction Stop).Source
$main = (Resolve-Path (Join-Path $PSScriptRoot '..\src\main.js')).Path
$launcher = Join-Path ([Environment]::GetFolderPath('Startup')) 'T3 Extension Host.vbs'

$command = '"' + $node + '" --no-warnings "' + $main + '"'
$vbsString = '"' + $command.Replace('"', '""') + '"'
Set-Content -Path $launcher -Value ('CreateObject("WScript.Shell").Run ' + $vbsString + ', 0, False') -Encoding Unicode

Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $launcher + '"')
Write-Host "Installed $launcher"
Write-Host 'T3 Extension Host is running and will start at login.'
