# Launch T3 Code so it actually appears on the desktop, and prove that it did.
#
# Two things make this harder than "start the exe". A process started over SSH lands in session 0,
# the services session, which has no desktop -- Electron starts there quite happily, so the refresh
# reported a successful launch while the machine's screen showed nothing. And a shell in session 0
# cannot see session 1's windows either, so it cannot tell the difference: MainWindowTitle comes
# back empty for a window that is on screen in front of the user.
#
# So both halves run as a scheduled task against the logged-on user: the app is started in their
# interactive session, and the check for a real window runs there too, leaving its answer in a file
# this side can read.
param(
  # Left empty by callers: the installed path holds a space, and a quoted argument does not survive
  # the trip from an SSH command line through cmd into PowerShell -- it arrives cut at the space.
  # Finding it here is one fewer thing that can be mangled in transit.
  [string]$ExePath = "",
  [string]$TaskName = "T3CodePersonalLaunch",
  [int]$WaitSeconds = 45,
  # Set only by the task this script registers for itself. Everything under it runs in the user's
  # session rather than in the SSH one.
  [switch]$InSession,
  [string]$ResultPath = ""
)

$ErrorActionPreference = "Stop"
function Log($m) { Write-Output ("[{0}] {1}" -f (Get-Date -Format o), $m) }

function Find-T3Exe {
  $found = @("$env:LOCALAPPDATA\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}") |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    ForEach-Object {
      # Windows PowerShell 5.1 ignores -Include under -LiteralPath and returns every file, so the
      # newest file anywhere (an updater log, once) got "launched". Filter the names explicitly.
      Get-ChildItem -LiteralPath $_ -File -Recurse -Depth 3 -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "T3 Code*.exe" -or $_.Name -like "MT Code*.exe" }
    } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $found) { throw "no installed T3 Code was found" }
  return $found.FullName
}

if (-not $ExePath) { $ExePath = Find-T3Exe }
if (-not (Test-Path -LiteralPath $ExePath)) { throw "not found: $ExePath" }
$processName = [IO.Path]::GetFileNameWithoutExtension($ExePath)

# ---- the half that runs in the user's own session ----
if ($InSession) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class T3Windows {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static List<string> Visible(List<uint> pids) {
    var found = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && IsWindowVisible(h)) {
        int len = GetWindowTextLength(h);
        var sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        var title = sb.ToString();
        if (title.Length > 0) { found.Add(title); }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
  Start-Process -FilePath $ExePath | Out-Null
  $titles = @()
  for ($i = 0; $i -lt $WaitSeconds; $i++) {
    Start-Sleep -Seconds 1
    $ids = New-Object 'System.Collections.Generic.List[uint32]'
    Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $ids.Add([uint32]$_.Id) }
    if ($ids.Count -eq 0) { continue }
    $titles = [T3Windows]::Visible($ids)
    if ($titles.Count -gt 0) { break }
  }
  if ($titles.Count -gt 0) {
    Set-Content -LiteralPath $ResultPath -Value ("GUI_VISIBLE " + $titles[0]) -Encoding ASCII
  } else {
    Set-Content -LiteralPath $ResultPath -Value "GUI_NOT_VISIBLE no visible titled window appeared" -Encoding ASCII
  }
  exit 0
}

# ---- the half that runs over SSH ----
# Anything already running from this install is either in session 0 (invisible, and the reason for
# this script) or a copy of the build being replaced. Ask it to close, then force-stop what is left
# so the task starts the app rather than handing focus to an instance nobody can see.
$installDir = (Split-Path -Parent $ExePath) + "\"
function Get-InstalledAppProcess {
  # Path re-reads MainModule on every access, so a process exiting mid-filter turns a second read
  # into $null; read it once and treat any failure as "not ours".
  Get-Process | Where-Object {
    $path = try { $_.Path } catch { $null }
    $path -and $path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase)
  }
}
Get-InstalledAppProcess | ForEach-Object { [void]$_.CloseMainWindow() }
for ($i = 0; $i -lt 10 -and (Get-InstalledAppProcess); $i++) { Start-Sleep -Milliseconds 500 }
Get-InstalledAppProcess | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$resultFile = Join-Path $env:TEMP "t3-launch-result.txt"
Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue
$self = $MyInvocation.MyCommand.Path
$arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -InSession -ExePath "{1}" -ResultPath "{2}" -WaitSeconds {3}' -f $self, $ExePath, $resultFile, $WaitSeconds
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments

# The account is named by whatever Windows will actually map. USERDOMAIN\USERNAME from an SSH
# session is not always one of those (0x80070534, "no mapping between account names and security
# IDs"), so the identity of the running process is asked for its own name first, and its SID --
# which needs no mapping at all -- is the fallback.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$registered = $false
foreach ($userId in @($identity.Name, $identity.User.Value, $env:USERNAME)) {
  if (-not $userId) { continue }
  try {
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Force | Out-Null
    Log "registered as $userId"
    $registered = $true
    break
  } catch {
    Log ("could not register as {0}: {1}" -f $userId, $_.Exception.Message)
  }
}
if (-not $registered) { throw "could not register a task for any form of this account" }

Start-ScheduledTask -TaskName $TaskName
Log "launching $ExePath in the desktop session"

$result = ""
for ($i = 0; $i -lt ($WaitSeconds + 20); $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path -LiteralPath $resultFile) {
    $result = (Get-Content -LiteralPath $resultFile -Raw).Trim()
    if ($result) { break }
  }
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

if ($result -and $result.StartsWith("GUI_VISIBLE")) {
  Log $result
} elseif ($result) {
  Log $result
  exit 1
} else {
  Log "GUI_UNKNOWN the task left no answer -- is anyone logged on?"
  exit 1
}
