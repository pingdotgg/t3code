@echo off
setlocal

REM Start the t3 server, logging stdout+stderr to logs/t3code-server.log.
REM Intended for use with Windows Task Scheduler (auto-start at login),
REM but you can also run it directly for debugging.

set "REPO_ROOT=%~dp0.."
cd /d "%REPO_ROOT%"

if not exist "logs" mkdir "logs"

if exist ".env.local" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env.local") do (
    if not "%%A"=="" set "%%A=%%B"
  )
)
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if not "%%A"=="" set "%%A=%%B"
  )
)

set "PATH=%USERPROFILE%\.local\bin;%LOCALAPPDATA%\OpenAI\Codex\bin;%USERPROFILE%\AppData\Roaming\npm;%USERPROFILE%\.bun\bin;%LOCALAPPDATA%\Microsoft\WindowsApps;%PATH%"

if not "%T3CODE_OWNER_PAIRING_TOKEN%"=="" (
  set "T3CODE_OWNER_PAIRING_STATE=userdata"
  node scripts\seed-owner-pairing-token.ts >> "logs\t3code-server.log" 2>&1
)

node apps\server\dist\bin.mjs --port 3773 --host 127.0.0.1 --no-browser >> "logs\t3code-server.log" 2>&1

exit /b %ERRORLEVEL%
