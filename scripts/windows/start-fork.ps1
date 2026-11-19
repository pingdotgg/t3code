[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [string]$Distro = 'Ubuntu',
    [string]$DesktopExecutable = "$env:LOCALAPPDATA\Programs\t3code\T3 Code (Beta).exe",
    [ValidateRange(1024, 65535)][int]$WebPort = 5743,
    [ValidateRange(1024, 65535)][int]$ServerPort = 13843,
    [ValidateRange(0, 65535)][int]$DebugPort = 0,
    [switch]$InstallShortcut,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
if ($Repository -notmatch '^/[A-Za-z0-9_./ -]+$' -or $Repository.Contains('..')) {
    throw 'Use an absolute Linux repository path without shell metacharacters or parent traversal.'
}
if ($Distro -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid WSL distribution name.' }
if (!(Test-Path -LiteralPath $DesktopExecutable -PathType Leaf)) {
    throw "T3 Code desktop was not found at $DesktopExecutable. Pass -DesktopExecutable with its Windows path."
}
$forkRoot = Join-Path $env:LOCALAPPDATA 'T3-Parade'
$logRoot = Join-Path $forkRoot 'logs'
$scriptLinux = "$Repository/scripts/windows/start-fork-web.sh"
$origin = "http://127.0.0.1:$WebPort"
& wsl.exe -d $Distro --exec test -f "$Repository/apps/web/vite.config.ts"
if ($LASTEXITCODE -ne 0) { throw "The clone is not available at $Repository in $Distro." }
if ($ValidateOnly) {
    [pscustomobject]@{ Desktop = $DesktopExecutable; Repository = $Repository; Distro = $Distro; Origin = $origin; Profile = $forkRoot }
    exit 0
}
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
if ($InstallShortcut) {
    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'T3 Parade.lnk'
    $wslScriptPath = "\\wsl.localhost\$Distro$($Repository.Replace('/', '\'))\scripts\windows\start-fork.ps1"
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wslScriptPath`" -Repository `"$Repository`" -Distro `"$Distro`" -DesktopExecutable `"$DesktopExecutable`" -WebPort $WebPort -ServerPort $ServerPort"
    $shortcut.IconLocation = "$DesktopExecutable,0"
    $shortcut.Description = 'T3 Parade - custom layout from the WSL clone'
    $shortcut.Save()
    Write-Output "Shortcut installed: $shortcutPath"
    exit 0
}
$mutex = New-Object System.Threading.Mutex($false, 'Local\T3ParadeLauncher')
$ownsMutex = $mutex.WaitOne(0)
if (!$ownsMutex) { $mutex.Dispose(); exit 0 }
$web = $null
$app = $null
try {
    $settingsDir = Join-Path $forkRoot 'data\userdata'
    New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
    $settingsFile = Join-Path $settingsDir 'desktop-settings.json'
    if (!(Test-Path -LiteralPath $settingsFile)) {
        @{ wslBackendEnabled = $true; wslOnly = $true; wslDistro = $Distro } |
            ConvertTo-Json | Set-Content -LiteralPath $settingsFile -Encoding UTF8
    }
    # Both the Electron profile and desktop state are private to this launcher.
    $env:APPDATA = Join-Path $forkRoot 'roaming'
    $env:T3CODE_HOME = Join-Path $forkRoot 'data'
    $env:T3CODE_DISABLE_AUTO_UPDATE = '1'
    $env:T3CODE_DESKTOP_APP_USER_MODEL_ID = 'local.T3Parade'
    $env:VITE_DEV_SERVER_URL = $origin
    $env:T3CODE_PORT = [string]$ServerPort
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    # Do not forward the Windows profile into Linux subprocesses.
    $env:WSLENV = (($env:WSLENV -split ':') | Where-Object { ($_ -split '/')[0] -notin @('APPDATA', 'T3CODE_HOME', 'VITE_DEV_SERVER_URL') }) -join ':'
    $web = Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '--exec', '/bin/bash', "`"$scriptLinux`"", "`"$Repository`"", $WebPort, $ServerPort) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot 'web.stdout.log') -RedirectStandardError (Join-Path $logRoot 'web.stderr.log')
    $ready = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while ([DateTime]::UtcNow -lt $deadline) {
        $web.Refresh()
        if ($web.HasExited) { throw "The WSL frontend stopped. See $logRoot\web.stderr.log" }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "$origin/@vite/client" -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (!$ready) { throw "Frontend startup timed out. See $logRoot" }
    $appArguments = @()
    if ($DebugPort -gt 0) { $appArguments += "--remote-debugging-port=$DebugPort" }
    if ($appArguments.Count) {
        $app = Start-Process -FilePath $DesktopExecutable -ArgumentList $appArguments -PassThru
    } else {
        $app = Start-Process -FilePath $DesktopExecutable -PassThru
    }
    Write-Output "Opened T3 Parade: app PID $($app.Id), frontend PID $($web.Id), $origin"
    Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ParadeWindows {
    public delegate bool Visitor(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor visitor, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
}
'@
    $toolsDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $script:paradeClosedTools = $false
        $script:paradeAppPid = $app.Id
        [ParadeWindows]::EnumWindows({
            param($handle, $parameter)
            [uint32]$windowProcessId = 0
            [ParadeWindows]::GetWindowThreadProcessId($handle, [ref]$windowProcessId) | Out-Null
            if ($windowProcessId -eq $script:paradeAppPid) {
                $title = New-Object System.Text.StringBuilder 512
                [ParadeWindows]::GetWindowText($handle, $title, 512) | Out-Null
                if ($title.ToString().StartsWith('Developer Tools - ')) {
                    [ParadeWindows]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
                    $script:paradeClosedTools = $true
                }
            }
            return $true
        }, [IntPtr]::Zero) | Out-Null
        if ($script:paradeClosedTools -or $app.HasExited) { break }
        Start-Sleep -Milliseconds 500
        $app.Refresh()
    } while ([DateTime]::UtcNow -lt $toolsDeadline)
    $app.WaitForExit()
} catch {
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $logRoot 'launcher-error.log')
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("$($_.Exception.Message)`n`nLogs: $logRoot", 'T3 Parade') | Out-Null
    throw
} finally {
    if ($web) {
        & wsl.exe -d $Distro --exec /bin/bash "$scriptLinux" "$Repository" $WebPort $ServerPort stop
        $web.Refresh()
        if (!$web.HasExited) { Stop-Process -Id $web.Id -ErrorAction SilentlyContinue }
    }
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
