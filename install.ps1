#Requires -Version 5.1
<#
.SYNOPSIS
    One-shot installer & updater for T3 Code desktop app.

.DESCRIPTION
    Downloads and installs (or updates) the latest T3 Code MSI, plus all
    required dependencies (Node.js, Git, GitHub CLI, provider CLIs) via
    winget or Chocolatey.

    Run the same command for both install and update — it auto-detects.

.EXAMPLE
    # Fresh install or update:
    iex (irm https://raw.githubusercontent.com/hlsitechio/t3code/main/install.ps1)
#>

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

$repo    = "hlsitechio/t3code"
$appName = "T3 Code"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

function Write-Step($msg) { Write-Host "  > $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  + $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "  - $msg" -ForegroundColor DarkGray }
function Write-Err($msg)  { Write-Host "  x $msg" -ForegroundColor Red }
function Write-Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# Detect existing T3 Code installation
# ---------------------------------------------------------------------------

function Get-InstalledT3Version {
    # Check registry for MSI-installed version
    $paths = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    foreach ($path in $paths) {
        try {
            $entry = Get-ItemProperty $path -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -match "T3.?Code" } |
                Select-Object -First 1
            if ($entry) {
                return $entry.DisplayVersion
            }
        } catch {}
    }
    return $null
}

$installedVersion = Get-InstalledT3Version
$isUpdate = $null -ne $installedVersion

Write-Host ""
Write-Host "  ========================================" -ForegroundColor White
if ($isUpdate) {
    Write-Host "       T3 Code Updater (v$installedVersion)      " -ForegroundColor White
} else {
    Write-Host "           T3 Code Installer              " -ForegroundColor White
}
Write-Host "  ========================================" -ForegroundColor White
Write-Host ""

# ---------------------------------------------------------------------------
# Package manager detection
# ---------------------------------------------------------------------------

function Test-Command($cmd) {
    try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true }
    catch { return $false }
}

$hasWinget = Test-Command "winget"
$hasChoco  = Test-Command "choco"

if ($hasWinget) {
    Write-Ok "winget detected (primary package manager)"
} elseif ($hasChoco) {
    Write-Ok "Chocolatey detected (package manager)"
} else {
    Write-Warn "No package manager found (winget or Chocolatey)"
    Write-Step "Installing Chocolatey..."
    try {
        Set-ExecutionPolicy Bypass -Scope Process -Force
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
        Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
        $hasChoco = $true
        Write-Ok "Chocolatey installed"
    } catch {
        Write-Err "Could not install Chocolatey: $_"
    }
}

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# ---------------------------------------------------------------------------
# Universal package installer/updater (winget > choco > manual)
# ---------------------------------------------------------------------------

function Install-Dep {
    param(
        [string]$Name,
        [string]$WingetId,
        [string]$ChocoId,
        [string]$ManualUrl,
        [switch]$ForceUpgrade
    )

    # Try winget first
    if ($hasWinget) {
        $action = if ($ForceUpgrade) { "upgrade" } else { "install" }
        Write-Step "$( if ($ForceUpgrade) { 'Updating' } else { 'Installing' } ) $Name via winget..."
        $result = winget $action --id $WingetId --accept-package-agreements --accept-source-agreements --disable-interactivity --silent 2>&1
        $resultStr = "$result"
        $wingetOk = ($LASTEXITCODE -eq 0) -or ($resultStr -match "already installed|No available upgrade|No installed package|No newer package|No applicable update|no applicable|is running")
        if ($wingetOk) {
            Write-Ok "$Name up to date (winget)"
            Refresh-Path
            return
        }
        # If upgrade failed, try install (handles version mismatch)
        if ($ForceUpgrade) {
            $result2 = winget install --id $WingetId --accept-package-agreements --accept-source-agreements --disable-interactivity --silent 2>&1
            if ($LASTEXITCODE -eq 0 -or "$result2" -match "already installed") {
                Write-Ok "$Name up to date (winget)"
                Refresh-Path
                return
            }
        }
    }

    # Fallback to Chocolatey
    if ($hasChoco) {
        try {
            $action = if ($ForceUpgrade) { "upgrade" } else { "install" }
            Write-Step "$( if ($ForceUpgrade) { 'Updating' } else { 'Installing' } ) $Name via Chocolatey..."
            choco $action $ChocoId -y --no-progress 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Ok "$Name up to date (Chocolatey)"
                Refresh-Path
                return
            }
        } catch {
            # Chocolatey binary missing or broken — skip silently
        }
    }

    Write-Err "Could not install $Name automatically"
    Write-Warn "Install manually: $ManualUrl"
}

# ---------------------------------------------------------------------------
# 1. Core dependencies
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  [1/4] Core Dependencies" -ForegroundColor White
Write-Host "  -----------------------" -ForegroundColor DarkGray

# Node.js
if (Test-Command "node") {
    $nodeVer = & node --version 2>$null
    Write-Ok "Node.js $nodeVer (installed)"
    if ($isUpdate) { Install-Dep -Name "Node.js LTS" -WingetId "OpenJS.NodeJS.LTS" -ChocoId "nodejs-lts" -ManualUrl "https://nodejs.org" -ForceUpgrade }
} else {
    Install-Dep -Name "Node.js LTS" -WingetId "OpenJS.NodeJS.LTS" -ChocoId "nodejs-lts" -ManualUrl "https://nodejs.org"
}

# Git
if (Test-Command "git") {
    $gitVer = & git --version 2>$null
    Write-Ok "$gitVer (installed)"
    if ($isUpdate) { Install-Dep -Name "Git" -WingetId "Git.Git" -ChocoId "git" -ManualUrl "https://git-scm.com" -ForceUpgrade }
} else {
    Install-Dep -Name "Git" -WingetId "Git.Git" -ChocoId "git" -ManualUrl "https://git-scm.com"
}

# GitHub CLI
if (Test-Command "gh") {
    $ghVer = & gh --version 2>$null | Select-Object -First 1
    Write-Ok "$ghVer (installed)"
    if ($isUpdate) { Install-Dep -Name "GitHub CLI" -WingetId "GitHub.cli" -ChocoId "gh" -ManualUrl "https://cli.github.com" -ForceUpgrade }
} else {
    Install-Dep -Name "GitHub CLI" -WingetId "GitHub.cli" -ChocoId "gh" -ManualUrl "https://cli.github.com"
}

# ---------------------------------------------------------------------------
# 2. Provider CLI tools (via npm)
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  [2/4] Provider CLI Tools" -ForegroundColor White
Write-Host "  ------------------------" -ForegroundColor DarkGray

if (Test-Command "npm") {
    $npmPkgs = @(
        @{ Cmd = "codex";  Pkg = "@openai/codex";            Name = "Codex CLI (OpenAI)" },
        @{ Cmd = "claude"; Pkg = "@anthropic-ai/claude-code"; Name = "Claude Code (Anthropic)" },
        @{ Cmd = "gemini"; Pkg = "@google/gemini-cli";        Name = "Gemini CLI (Google)" }
    )

    foreach ($tool in $npmPkgs) {
        if (Test-Command $tool.Cmd) {
            if ($isUpdate) {
                Write-Step "Updating $($tool.Name)..."
                npm update -g $tool.Pkg 2>$null
                if ($LASTEXITCODE -eq 0) {
                    Write-Ok "$($tool.Name) updated"
                } else {
                    Write-Warn "$($tool.Name) update failed (run: npm update -g $($tool.Pkg))"
                }
            } else {
                Write-Skip "$($tool.Name) (already installed)"
            }
        } else {
            Write-Step "Installing $($tool.Name)..."
            npm install -g $tool.Pkg 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Ok "$($tool.Name) installed"
            } else {
                Write-Err "$($tool.Name) failed (run later: npm i -g $($tool.Pkg))"
            }
        }
    }
} else {
    Write-Warn "npm not available — skipping provider CLI tools"
    Write-Warn "Install Node.js first, then run: npm i -g @openai/codex @anthropic-ai/claude-code @google/gemini-cli"
}

# ---------------------------------------------------------------------------
# 3. Download & install/update T3 Code MSI
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  [3/4] T3 Code Desktop App" -ForegroundColor White
Write-Host "  -------------------------" -ForegroundColor DarkGray

Write-Step "Fetching latest release from GitHub..."

try {
    $headers = @{ "User-Agent" = "T3CodeInstaller/2.0" }
    $release = $null
    $msiAsset = $null

    # Try latest release first
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
        $msiAsset = $release.assets | Where-Object { $_.name -match "\.msi$" } | Select-Object -First 1
    } catch {
        # No latest release, check all releases
    }

    if (-not $msiAsset) {
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=10" -Headers $headers
        foreach ($r in $releases) {
            $msiAsset = $r.assets | Where-Object { $_.name -match "\.msi$" } | Select-Object -First 1
            if ($msiAsset) { $release = $r; break }
        }
    }

    if (-not $msiAsset) {
        Write-Err "No MSI found in releases at github.com/$repo"
        Write-Warn "Visit https://github.com/$repo/releases to download manually."
        # Don't exit — deps were still installed successfully
    } else {
        $latestVersion = $release.tag_name -replace '^v', ''
        $msiUrl  = $msiAsset.browser_download_url
        $msiName = $msiAsset.name
        $sizeMB  = [math]::Round($msiAsset.size / 1MB, 1)

        # Compare versions — skip download if already on latest
        if ($installedVersion -and $installedVersion -eq $latestVersion) {
            Write-Ok "T3 Code v$installedVersion is already the latest version"
        } else {
            $tempDir = Join-Path $env:TEMP "t3code-install"
            $msiPath = Join-Path $tempDir $msiName

            if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }

            if ($isUpdate) {
                Write-Step "Downloading update: v$installedVersion -> v$latestVersion ($sizeMB MB)..."
            } else {
                Write-Step "Downloading $msiName ($sizeMB MB)..."
            }
            Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing

            Write-Step "Installing T3 Code (admin prompt may appear)..."
            # MSI /i handles both install and upgrade automatically
            $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qb /norestart" -Wait -Verb RunAs -PassThru
            if ($proc.ExitCode -eq 0) {
                if ($isUpdate) {
                    Write-Ok "T3 Code updated to v$latestVersion!"
                } else {
                    Write-Ok "T3 Code v$latestVersion installed!"
                }
            } else {
                Write-Err "MSI install returned exit code $($proc.ExitCode)"
            }

            # Cleanup
            Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
} catch {
    Write-Err "Download/install failed: $_"
    Write-Warn "Visit https://github.com/$repo/releases to download manually."
}

# ---------------------------------------------------------------------------
# 4. Update channel info
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  [4/4] Update Channels" -ForegroundColor White
Write-Host "  ---------------------" -ForegroundColor DarkGray

Write-Ok "Auto-update: T3 Code checks GitHub Releases on every launch"
Write-Ok "Manual update: re-run this same command anytime"

if ($hasWinget) {
    Write-Skip "  winget upgrade --all  (updates core deps)"
}
if ($hasChoco) {
    Write-Skip "  choco upgrade all -y  (updates core deps)"
}
if (Test-Command "npm") {
    Write-Skip "  npm update -g @openai/codex @anthropic-ai/claude-code @google/gemini-cli"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
if ($isUpdate) {
    Write-Host "         Update Complete!                  " -ForegroundColor Green
} else {
    Write-Host "       Installation Complete!              " -ForegroundColor Green
}
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""

if (-not $isUpdate) {
    Write-Host "  Launch T3 Code from the Start Menu or Desktop shortcut." -ForegroundColor White
    Write-Host ""
    Write-Host "  Quick start:" -ForegroundColor DarkGray
    Write-Host "    1. Sign in with your AI providers (ChatGPT, Claude, Gemini)" -ForegroundColor DarkGray
    Write-Host "    2. Connect your GitHub account" -ForegroundColor DarkGray
    Write-Host "    3. Start coding!" -ForegroundColor DarkGray
} else {
    Write-Host "  Restart T3 Code to use the latest version." -ForegroundColor White
}

Write-Host ""
Write-Host "  Run this command anytime to update:" -ForegroundColor DarkGray
Write-Host "    iex (irm https://raw.githubusercontent.com/$repo/main/install.ps1)" -ForegroundColor DarkGray
Write-Host ""
