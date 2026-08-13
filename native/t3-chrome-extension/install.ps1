# Register the native messaging host so Chrome can reach the desktop server.
#
# The Windows counterpart to install.sh. Chrome finds hosts through the registry
# here rather than a directory of manifests, and it runs the host with no
# arguments, so the manifest points at a small .cmd that re-execs the server in
# host mode.
#
# The extension id is pinned by the "key" in manifest.json, which is why this
# can be registered before the extension is ever loaded.

$ErrorActionPreference = 'Stop'

$ExtensionId = 'kgdolgnijopbghhomnblabjkmjhnoage'
$HostName = 'com.t3tools.t3code.desktop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$binary = $env:T3CODE_DESKTOP_MCP_PATH
if (-not $binary) {
  $binary = Join-Path $here '..\t3-desktop-mcp-rs\target\release\t3-desktop-mcp.exe'
}
if (-not (Test-Path $binary)) {
  Write-Error "desktop server binary not found at: $binary`nbuild it first:  cargo build --release --manifest-path native/t3-desktop-mcp-rs/Cargo.toml"
}
$binary = (Resolve-Path $binary).Path

$support = Join-Path $env:LOCALAPPDATA 't3-desktop-mcp'
New-Item -ItemType Directory -Force -Path $support | Out-Null

# Chrome passes no arguments to a host, so the wrapper supplies the mode.
$wrapper = Join-Path $support 'native-host.cmd'
"@echo off`r`n`"$binary`" native-host" | Set-Content -Path $wrapper -Encoding ASCII

$manifestPath = Join-Path $support "$HostName.json"
$manifest = [ordered]@{
  name            = $HostName
  description     = 'T3 Code desktop control bridge'
  path            = $wrapper
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

# Chrome and Chromium read separate registry trees; register wherever the
# browser is actually installed.
$installed = 0
foreach ($vendor in @('Google\Chrome', 'Google\Chrome Beta', 'Chromium')) {
  $key = "HKCU:\Software\$vendor\NativeMessagingHosts\$HostName"
  try {
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
    Write-Host "registered host in: HKCU\Software\$vendor"
    $installed++
  } catch {
    # A browser that is not installed simply has no tree; not an error.
  }
}

if ($installed -eq 0) {
  Write-Error 'no Chrome registry location could be written'
}

Write-Host ''
Write-Host 'Next, load the extension once:'
Write-Host '  1. open  chrome://extensions'
Write-Host '  2. turn on Developer mode'
Write-Host "  3. Load unpacked  ->  $here"
Write-Host ''
Write-Host "It should appear with id $ExtensionId."
