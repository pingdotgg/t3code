#Requires -Version 5.1
<#
.SYNOPSIS
    Interactive installer & updater for T3 Code desktop app.

.DESCRIPTION
    Walks you through installing T3 Code and its dependencies step by step.
    You choose what to install — nothing gets installed without your say.

.EXAMPLE
    irm hlsitechio.github.io/t3code/install.ps1 | iex
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
function Write-Bot($msg)  { Write-Host "  T3 $msg" -ForegroundColor Magenta }

function Ask-YesNo($question) {
    $answer = Read-Host "  $question (Y/n)"
    return ($answer -eq "" -or $answer -match "^[Yy]")
}

# ---------------------------------------------------------------------------
# Detect existing T3 Code installation
# ---------------------------------------------------------------------------

function Get-InstalledT3Version {
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
            if ($entry) { return $entry.DisplayVersion }
        } catch {}
    }
    return $null
}

function Test-Command($cmd) {
    try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true }
    catch { return $false }
}

function Test-ChocoWorks {
    try { $null = & choco --version 2>&1; return ($LASTEXITCODE -eq 0) }
    catch { return $false }
}

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# ---------------------------------------------------------------------------
# Winget install helper (with live progress)
# ---------------------------------------------------------------------------

function Invoke-Winget {
    param([string]$Action, [string]$Id)

    $wingetArgs = "$Action --id $Id --accept-package-agreements --accept-source-agreements --disable-interactivity"
    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = "winget"
    $pinfo.Arguments = $wingetArgs
    $pinfo.RedirectStandardOutput = $true
    $pinfo.RedirectStandardError = $true
    $pinfo.UseShellExecute = $false
    $pinfo.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($pinfo)
    $allOutput = ""
    while (-not $p.StandardOutput.EndOfStream) {
        $line = $p.StandardOutput.ReadLine()
        $allOutput += "$line`n"
        if ($line -match '\d+%|MB|KB|download|Download|install|Install|Found|found|correctement|succ') {
            Write-Host "    $line" -ForegroundColor DarkGray
        }
    }
    $p.WaitForExit()
    $ok = ($p.ExitCode -eq 0) -or ($allOutput -match "already installed|No available upgrade|No newer package|No applicable update|no applicable|correctement|succ|Aucun|aucun")
    return $ok
}

# =========================================================================
#  WELCOME
# =========================================================================

$installedVersion = Get-InstalledT3Version
$isUpdate = $null -ne $installedVersion

Write-Host ""
Write-Host "  ========================================" -ForegroundColor White
Write-Host "            T3 Code Setup                 " -ForegroundColor White
Write-Host "  ========================================" -ForegroundColor White
Write-Host ""

if ($isUpdate) {
    Write-Bot "Hey! Looks like you have T3 Code v$installedVersion installed."
    Write-Bot "Let me help you update everything."
} else {
    Write-Bot "Hey! I'll help you set up T3 Code."
    Write-Bot "I'll walk you through each step — you decide what gets installed."
}
Write-Host ""

# =========================================================================
#  PACKAGE MANAGER
# =========================================================================

$hasWinget = Test-Command "winget"
$hasChoco  = (Test-Command "choco") -and (Test-ChocoWorks)

if ($hasWinget) {
    Write-Ok "winget detected"
} elseif ($hasChoco) {
    Write-Ok "Chocolatey detected"
} else {
    Write-Bot "You don't have a package manager installed."
    Write-Bot "I need one to install dependencies. Which would you like?"
    Write-Host ""
    Write-Host "    [1] winget  (recommended, built into Windows 10/11)" -ForegroundColor Cyan
    Write-Host "    [2] Chocolatey  (community package manager)" -ForegroundColor Cyan
    Write-Host "    [3] Skip  (I'll handle dependencies myself)" -ForegroundColor DarkGray
    Write-Host ""
    $choice = Read-Host "  Your choice (1/2/3)"
    switch ($choice) {
        "1" {
            if (Test-Command "winget") {
                $hasWinget = $true
                Write-Ok "winget is available"
            } else {
                Write-Warn "winget not found. Install 'App Installer' from Microsoft Store:"
                Write-Host "    ms-windows-store://pdp/?productid=9NBLGGH4NNS1" -ForegroundColor Cyan
            }
        }
        "2" {
            Write-Step "Installing Chocolatey..."
            try {
                Set-ExecutionPolicy Bypass -Scope Process -Force
                [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
                Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
                $hasChoco = $true
                Write-Ok "Chocolatey installed"
            } catch { Write-Err "Could not install Chocolatey: $_" }
        }
        default { Write-Skip "Skipping package manager" }
    }
    Write-Host ""
}

# =========================================================================
#  SCAN SYSTEM
# =========================================================================

Write-Bot "Let me scan your system..."
Write-Host ""

$scan = @(
    @{ Name = "Node.js";    Cmd = "node";   Args = "--version";  Required = $true;  WingetId = "OpenJS.NodeJS.LTS"; ChocoId = "nodejs-lts"; Url = "https://nodejs.org" },
    @{ Name = "Git";        Cmd = "git";    Args = "--version";  Required = $true;  WingetId = "Git.Git";           ChocoId = "git";        Url = "https://git-scm.com" },
    @{ Name = "GitHub CLI";  Cmd = "gh";     Args = "--version";  Required = $false; WingetId = "GitHub.cli";        ChocoId = "gh";         Url = "https://cli.github.com" }
)

$missing = @()
$installed = @()

foreach ($dep in $scan) {
    if (Test-Command $dep.Cmd) {
        $ver = & $dep.Cmd $dep.Args.Split(" ") 2>$null | Select-Object -First 1
        Write-Ok "$($dep.Name): $ver"
        $installed += $dep
    } else {
        $tag = if ($dep.Required) { "(required)" } else { "(optional)" }
        Write-Warn "$($dep.Name): not found $tag"
        $missing += $dep
    }
}

# Check npm CLI tools
$npmTools = @(
    @{ Name = "Codex CLI (OpenAI)";       Cmd = "codex";  Pkg = "@openai/codex" },
    @{ Name = "Claude Code (Anthropic)";   Cmd = "claude"; Pkg = "@anthropic-ai/claude-code" },
    @{ Name = "Gemini CLI (Google)";       Cmd = "gemini"; Pkg = "@google/gemini-cli" }
)

$missingNpm = @()
$installedNpm = @()

foreach ($tool in $npmTools) {
    if (Test-Command $tool.Cmd) {
        Write-Ok "$($tool.Name): installed"
        $installedNpm += $tool
    } else {
        Write-Warn "$($tool.Name): not found"
        $missingNpm += $tool
    }
}

Write-Host ""

# =========================================================================
#  INSTALL MISSING CORE DEPS
# =========================================================================

if ($missing.Count -gt 0) {
    Write-Bot "I found $($missing.Count) missing core tool(s). Let's set them up."
    Write-Host ""

    foreach ($dep in $missing) {
        $tag = if ($dep.Required) { " (required)" } else { "" }
        if (Ask-YesNo "Install $($dep.Name)$($tag)?") {
            if ($hasWinget) {
                Write-Step "Installing $($dep.Name) via winget..."
                $ok = Invoke-Winget -Action "install" -Id $dep.WingetId
                if ($ok) {
                    Write-Ok "$($dep.Name) installed"
                    Refresh-Path
                } else {
                    Write-Err "winget failed for $($dep.Name)"
                    Write-Warn "Install manually: $($dep.Url)"
                }
            } elseif ($hasChoco) {
                Write-Step "Installing $($dep.Name) via Chocolatey..."
                try {
                    choco install $dep.ChocoId -y --no-progress 2>$null
                    if ($LASTEXITCODE -eq 0) {
                        Write-Ok "$($dep.Name) installed"
                        Refresh-Path
                    }
                } catch { Write-Err "Chocolatey failed for $($dep.Name)" }
            } else {
                Write-Warn "No package manager — install manually: $($dep.Url)"
            }
        } else {
            Write-Skip "Skipping $($dep.Name)"
        }
        Write-Host ""
    }
} else {
    Write-Bot "All core tools are installed. Nice!"
    Write-Host ""
}

# =========================================================================
#  UPDATE EXISTING CORE DEPS (if update mode)
# =========================================================================

if ($isUpdate -and $installed.Count -gt 0 -and $hasWinget) {
    if (Ask-YesNo "Check for updates to core tools (Node.js, Git, etc.)?") {
        Write-Host ""
        foreach ($dep in $installed) {
            Write-Step "Checking $($dep.Name)..."
            $ok = Invoke-Winget -Action "upgrade" -Id $dep.WingetId
            if ($ok) {
                Write-Ok "$($dep.Name) up to date"
            } else {
                Write-Ok "$($dep.Name) already current (not managed by winget)"
            }
        }
        Write-Host ""
    } else {
        Write-Skip "Skipping core tool updates"
        Write-Host ""
    }
}

# =========================================================================
#  PROVIDER CLI TOOLS
# =========================================================================

if (Test-Command "npm") {
    if ($missingNpm.Count -gt 0) {
        Write-Bot "Now for the AI provider CLIs. Pick the ones you want:"
        Write-Host ""

        foreach ($tool in $missingNpm) {
            if (Ask-YesNo "Install $($tool.Name)?") {
                Write-Step "Installing $($tool.Name)..."
                npm install -g $tool.Pkg 2>$null
                if ($LASTEXITCODE -eq 0) {
                    Write-Ok "$($tool.Name) installed"
                } else {
                    Write-Err "$($tool.Name) failed (run later: npm i -g $($tool.Pkg))"
                }
            } else {
                Write-Skip "Skipping $($tool.Name)"
            }
        }
        Write-Host ""
    }

    # Update existing npm tools if update mode
    if ($isUpdate -and $installedNpm.Count -gt 0) {
        if (Ask-YesNo "Update installed AI provider CLIs?") {
            Write-Host ""
            foreach ($tool in $installedNpm) {
                Write-Step "Updating $($tool.Name)..."
                npm update -g $tool.Pkg 2>$null
                if ($LASTEXITCODE -eq 0) {
                    Write-Ok "$($tool.Name) updated"
                } else {
                    Write-Warn "$($tool.Name) update failed"
                }
            }
            Write-Host ""
        } else {
            Write-Skip "Skipping CLI updates"
            Write-Host ""
        }
    }
} else {
    Write-Bot "npm is not available — skipping provider CLI tools."
    Write-Warn "Install Node.js first, then run:"
    Write-Host "    npm i -g @openai/codex @anthropic-ai/claude-code @google/gemini-cli" -ForegroundColor DarkGray
    Write-Host ""
}

# =========================================================================
#  T3 CODE DESKTOP APP
# =========================================================================

Write-Bot "Now for the main event — T3 Code desktop app."
Write-Host ""

try {
    Write-Step "Checking latest release..."
    $headers = @{ "User-Agent" = "T3CodeInstaller/3.0" }
    $release = $null
    $msiAsset = $null

    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
        $msiAsset = $release.assets | Where-Object { $_.name -match "\.msi$" } | Select-Object -First 1
    } catch {}

    if (-not $msiAsset) {
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=10" -Headers $headers
        foreach ($r in $releases) {
            $msiAsset = $r.assets | Where-Object { $_.name -match "\.msi$" } | Select-Object -First 1
            if ($msiAsset) { $release = $r; break }
        }
    }

    if (-not $msiAsset) {
        Write-Warn "No MSI found in GitHub releases."
        Write-Warn "Visit https://github.com/$repo/releases"
    } else {
        $latestVersion = $release.tag_name -replace '^v', ''
        $msiUrl  = $msiAsset.browser_download_url
        $msiName = $msiAsset.name
        $sizeMB  = [math]::Round($msiAsset.size / 1MB, 1)

        if ($installedVersion -and $installedVersion -eq $latestVersion) {
            Write-Ok "T3 Code v$installedVersion is already the latest!"
        } else {
            if ($isUpdate) {
                Write-Bot "Update available: v$installedVersion -> v$latestVersion ($sizeMB MB)"
            } else {
                Write-Bot "Latest version: v$latestVersion ($sizeMB MB)"
            }
            Write-Host ""

            if (Ask-YesNo "Download and install T3 Code v$($latestVersion)?") {
                # Ask for install folder
                $defaultDir = Join-Path $env:ProgramFiles "T3 Code"
                Write-Host ""
                Write-Bot "Where do you want to install T3 Code?"
                Write-Host "    Default: $defaultDir" -ForegroundColor DarkGray
                Write-Host "    Current: $($PWD.Path)" -ForegroundColor DarkGray
                Write-Host ""
                Write-Host "    [1] Default ($defaultDir)" -ForegroundColor Cyan
                Write-Host "    [2] Current folder ($($PWD.Path))" -ForegroundColor Cyan
                Write-Host "    [3] Custom path" -ForegroundColor Cyan
                Write-Host ""
                $folderChoice = Read-Host "  Your choice (1/2/3)"
                switch ($folderChoice) {
                    "2" { $installDir = $PWD.Path }
                    "3" {
                        $customPath = Read-Host "  Enter full path"
                        if ($customPath -and (Test-Path (Split-Path $customPath -Parent) -ErrorAction SilentlyContinue)) {
                            $installDir = $customPath
                        } else {
                            Write-Warn "Invalid path, using default"
                            $installDir = $defaultDir
                        }
                    }
                    default { $installDir = $defaultDir }
                }
                Write-Host ""

                $tempDir = Join-Path $env:TEMP "t3code-install"
                $msiPath = Join-Path $tempDir $msiName
                if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }

                Write-Step "Downloading $msiName..."
                $prevPref = $ProgressPreference
                $ProgressPreference = "Continue"
                Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
                $ProgressPreference = $prevPref

                Write-Step "Installing T3 Code to $installDir..."
                $msiArgs = "/i `"$msiPath`" /qb /norestart APPLICATIONFOLDER=`"$installDir`""
                $proc = Start-Process msiexec.exe -ArgumentList $msiArgs -Wait -Verb RunAs -PassThru
                if ($proc.ExitCode -eq 0) {
                    Write-Ok "T3 Code v$latestVersion installed to $installDir"
                } else {
                    Write-Err "MSI returned exit code $($proc.ExitCode)"
                }

                Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
            } else {
                Write-Skip "Skipping T3 Code install"
            }
        }
    }
} catch {
    Write-Err "Download failed: $_"
    Write-Warn "Visit https://github.com/$repo/releases"
}

# =========================================================================
#  DONE
# =========================================================================

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "              All Done!                   " -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""

Write-Bot "You're all set! Here's what to do next:"
Write-Host ""
if (-not $isUpdate) {
    Write-Host "    1. Launch T3 Code from Start Menu or Desktop" -ForegroundColor DarkGray
    Write-Host "    2. Sign in with your AI providers" -ForegroundColor DarkGray
    Write-Host "    3. Connect GitHub" -ForegroundColor DarkGray
    Write-Host "    4. Start coding!" -ForegroundColor DarkGray
} else {
    Write-Host "    Restart T3 Code to use v$latestVersion" -ForegroundColor DarkGray
}

Write-Host ""
Write-Bot "Run this anytime to update:"
Write-Host "    irm hlsitechio.github.io/t3code/install.ps1 | iex" -ForegroundColor Cyan
Write-Host ""
