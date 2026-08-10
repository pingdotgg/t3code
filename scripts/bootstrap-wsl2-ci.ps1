param(
  [string[]]$Distros = @("Ubuntu-24.04", "Debian")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-WslChecked {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$Description = "wsl.exe command"
  )

  & wsl.exe @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code ${LASTEXITCODE}: wsl.exe $($Arguments -join ' ')"
  }
}

function Get-InstalledWslDistros {
  $output = & wsl.exe --list --quiet
  if ($LASTEXITCODE -ne 0) {
    throw "wsl.exe --list --quiet failed with exit code $LASTEXITCODE"
  }
  return @($output | ForEach-Object { $_.Trim().Trim([char]0) } | Where-Object { $_ })
}

Write-Host "=== WSL runtime ==="
Invoke-WslChecked -Arguments @("--version") -Description "WSL version probe"
Invoke-WslChecked -Arguments @("--set-default-version", "2") -Description "WSL2 default selection"

foreach ($distro in $Distros) {
  $installed = Get-InstalledWslDistros
  if ($installed -notcontains $distro) {
    Write-Host "Installing $distro as a real WSL2 integration target..."
    Invoke-WslChecked -Arguments @(
      "--install",
      "--distribution", $distro,
      "--no-launch",
      "--web-download"
    ) -Description "WSL distro install ($distro)"
  }

  # Initialize the distro as root to avoid interactive first-user setup on CI.
  Invoke-WslChecked -Arguments @(
    "--distribution", $distro,
    "--user", "root",
    "--",
    "/bin/sh", "-lc", "true"
  ) -Description "WSL distro initialization ($distro)"

  Invoke-WslChecked -Arguments @("--set-version", $distro, "2") -Description "WSL2 enforcement ($distro)"

  # The cross-distro native smoke uses readelf for diagnostics. Install only
  # that CI inspection tool; deliberately do not install Node.js or compilers.
  Invoke-WslChecked -Arguments @(
    "--distribution", $distro,
    "--user", "root",
    "--",
    "/bin/sh", "-lc",
    "apt-get update >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y binutils >/dev/null"
  ) -Description "WSL CI inspection tooling ($distro)"

  # Exercise the same non-root cache and process semantics as a normal desktop
  # user. Store-installed CI distros are initialized as root above to avoid an
  # interactive OOBE, so explicitly create and pin a normal default user.
  Invoke-WslChecked -Arguments @(
    "--distribution", $distro,
    "--user", "root",
    "--",
    "/bin/sh", "-lc",
    'id -u t3ci >/dev/null 2>&1 || useradd -m -s /bin/bash t3ci; printf "[user]\ndefault=t3ci\n" > /etc/wsl.conf'
  ) -Description "WSL non-root CI user setup ($distro)"
  Invoke-WslChecked -Arguments @("--terminate", $distro) -Description "WSL distro restart ($distro)"
  $defaultUser = (& wsl.exe --distribution $distro -- /bin/sh -lc "id -un" | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $defaultUser -ne "t3ci") {
    throw "Expected $distro to restart as non-root user t3ci, got '$defaultUser'"
  }

  Write-Host "=== $distro runtime identity ==="
  Invoke-WslChecked -Arguments @(
    "--distribution", $distro,
    "--user", "root",
    "--",
    "/bin/sh", "-lc", 'printf "distro=%s\n" "$(. /etc/os-release && printf "%s %s" "$ID" "$VERSION_ID")"; printf "arch=%s\n" "$(uname -m)"; printf "libc=%s\n" "$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"'
  ) -Description "WSL distro identity probe ($distro)"
}

# Deliberately make the second distro the Windows default. The integration test
# still targets each concrete distro explicitly, catching regressions where
# `wsl:default` is accidentally re-resolved after backend selection.
if ($Distros.Count -gt 1) {
  Invoke-WslChecked -Arguments @("--set-default", $Distros[1]) -Description "WSL default-distro drift setup"
}

Write-Host "=== Installed WSL distros ==="
Invoke-WslChecked -Arguments @("--list", "--verbose") -Description "WSL distro inventory"

if ($env:GITHUB_ENV) {
  "T3CODE_WSL_INTEGRATION=1" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  "T3CODE_WSL_TEST_DISTROS=$($Distros -join ',')" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  if ($Distros.Count -gt 1) {
    "T3CODE_WSL_EXPECTED_DEFAULT_DISTRO=$($Distros[1])" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  }
}
