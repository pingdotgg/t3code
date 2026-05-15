@echo off
setlocal

set "REPO_ROOT=%~dp0.."
cd /d "%REPO_ROOT%"

set "T3CODE_HEALTH_NOTIFY=1"
bun run health:orchestrator

exit /b %ERRORLEVEL%
