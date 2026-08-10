param(
  [Parameter(Mandatory = $true)][string]$RuntimeDir,
  [string[]]$Distros = @("Ubuntu-24.04", "Debian")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeRoot = (Resolve-Path $RuntimeDir).Path
$nodeWindowsPath = (Resolve-Path (Join-Path $runtimeRoot "node")).Path
$ptyWindowsPath = (Resolve-Path (Join-Path $runtimeRoot "pty.node")).Path
$manifestWindowsPath = (Resolve-Path (Join-Path $runtimeRoot "wsl-native-abi.json")).Path
$smokeWindowsPath = (Resolve-Path (Join-Path $repoRoot "scripts/smoke-wsl-native-runtime.mjs")).Path

function Convert-ToWslPath {
  param([Parameter(Mandatory = $true)][string]$Distro, [Parameter(Mandatory = $true)][string]$WindowsPath)
  $normalized = $WindowsPath.Replace('\', '/')
  $output = & wsl.exe --distribution $Distro -- wslpath -u $normalized
  if ($LASTEXITCODE -ne 0) {
    throw "wslpath failed for '$WindowsPath' in $Distro"
  }
  $value = ($output | Out-String).Trim()
  if (-not $value.StartsWith("/")) {
    throw "wslpath returned a non-absolute path for '$WindowsPath' in ${Distro}: $value"
  }
  return $value
}

foreach ($distro in $Distros) {
  $nodeWslPath = Convert-ToWslPath -Distro $distro -WindowsPath $nodeWindowsPath
  $ptyWslPath = Convert-ToWslPath -Distro $distro -WindowsPath $ptyWindowsPath
  $manifestWslPath = Convert-ToWslPath -Distro $distro -WindowsPath $manifestWindowsPath
  $smokeWslPath = Convert-ToWslPath -Distro $distro -WindowsPath $smokeWindowsPath
  $repoWslPath = Convert-ToWslPath -Distro $distro -WindowsPath $repoRoot
  $cachedNode = "/tmp/t3code-wsl-ci/node"

  Write-Host "=== Native runtime smoke inside $distro ==="
  & wsl.exe --distribution $distro -- /bin/sh -c @'
set -eu
source_node="$1"
target_node="$2"
smoke_script="$3"
repo_root="$4"
pty_path="$5"
manifest_path="$6"
mkdir -p "$(dirname "$target_node")"
cp "$source_node" "$target_node"
chmod 0755 "$target_node"
"$target_node" "$smoke_script" \
  --server-root "$repo_root/apps/server" \
  --arch x64 \
  --node-pty "$pty_path" \
  --node-runtime "$target_node" \
  --manifest "$manifest_path"
'@ sh $nodeWslPath $cachedNode $smokeWslPath $repoWslPath $ptyWslPath $manifestWslPath
  if ($LASTEXITCODE -ne 0) {
    throw "Native runtime smoke failed inside $distro with exit code $LASTEXITCODE"
  }
}

if ($env:GITHUB_ENV) {
  "T3CODE_WSL_TEST_BUNDLED_NODE_WINDOWS_PATH=$nodeWindowsPath" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}
