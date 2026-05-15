param(
  [string]$Remote = "pingdotgg",
  [string]$Branch = "main",
  [switch]$SkipGitUpdate,
  [switch]$AllowDirty,
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$SkipRestart,
  [switch]$SkipHealthCheck
)

$ErrorActionPreference = "Stop"

$ServiceName = "t3code-server"
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found on PATH."
  }
}

function Assert-AdminIfNeeded {
  if ($SkipRestart) {
    return
  }

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    throw "Restarting $ServiceName requires an elevated PowerShell. Rerun as Administrator or pass -SkipRestart."
  }
}

function Invoke-Logged {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )
  Write-Host "> $FilePath $($Arguments -join ' ')"
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE"
  }
}

Set-Location -LiteralPath $RepoRoot

Write-Step "Checking prerequisites"
Require-Command git
Require-Command bun
Require-Command curl.exe
Assert-AdminIfNeeded

Write-Host "Repo root: $RepoRoot"
Write-Host "Target upstream: $Remote/$Branch"

if (-not $SkipGitUpdate) {
  Write-Step "Checking git worktree"
  $status = git status --porcelain
  if ($status -and -not $AllowDirty) {
    Write-Host $status
    throw "Worktree is dirty. Commit/stash changes first, or rerun with -AllowDirty if you know the local changes are intentional."
  }

  git remote get-url $Remote | Out-Null

  Write-Step "Fetching upstream"
  Invoke-Logged git @("fetch", $Remote, $Branch)

  Write-Step "Merging upstream"
  Invoke-Logged git @("merge", "$Remote/$Branch")
} else {
  Write-Step "Skipping git update"
}

if (-not $SkipInstall) {
  Write-Step "Installing dependencies"
  Invoke-Logged bun @("install")
}

if (-not $SkipBuild) {
  Write-Step "Building server and web assets"
  Invoke-Logged bun @("run", "build")
}

if (-not $SkipRestart) {
  Write-Step "Restarting $ServiceName"
  if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    throw "$ServiceName is not installed. Run scripts\install-t3code-server-service.ps1 from an elevated PowerShell first."
  }
  Restart-Service -Name $ServiceName -Force
  Start-Sleep -Seconds 10
  $service = Get-Service -Name $ServiceName
  Write-Host "$ServiceName status: $($service.Status)"
  if ($service.Status -ne "Running") {
    throw "$ServiceName did not return to Running status."
  }
}

if (-not $SkipHealthCheck) {
  Write-Step "Running orchestrator health check"
  Invoke-Logged bun @("run", "health:orchestrator")
}

Write-Step "Update complete"
git log -1 --oneline
