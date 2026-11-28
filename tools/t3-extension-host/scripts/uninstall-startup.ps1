$ErrorActionPreference = 'Stop'

$launcher = Join-Path ([Environment]::GetFolderPath('Startup')) 'T3 Extension Host.vbs'
$srcDir = (Resolve-Path (Join-Path $PSScriptRoot '..\src')).Path

if (Test-Path $launcher) {
  Remove-Item $launcher
  Write-Host "Removed $launcher"
}

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($srcDir) } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Host "Stopped process $($_.ProcessId)"
  }
