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

REM Windows services installed through NSSM currently run as LocalSystem. In that
REM context USERPROFILE points at systemprofile, so CLIs like codex/gh cannot see
REM Vivek's installed binaries or auth files unless we hydrate the user profile
REM explicitly. Default to the profile that owns this checkout:
REM   C:\Users\Vivek\Affil\t3code -> C:\Users\Vivek
if "%T3CODE_SERVICE_USERPROFILE%"=="" (
  for %%I in ("%REPO_ROOT%\..\..") do set "T3CODE_SERVICE_USERPROFILE=%%~fI"
)

if exist "%T3CODE_SERVICE_USERPROFILE%\.codex" (
  set "USERPROFILE=%T3CODE_SERVICE_USERPROFILE%"
  set "HOME=%T3CODE_SERVICE_USERPROFILE%"
  if exist "%T3CODE_SERVICE_USERPROFILE%\AppData\Roaming" set "APPDATA=%T3CODE_SERVICE_USERPROFILE%\AppData\Roaming"
  if exist "%T3CODE_SERVICE_USERPROFILE%\AppData\Local" set "LOCALAPPDATA=%T3CODE_SERVICE_USERPROFILE%\AppData\Local"
  if "%CODEX_HOME%"=="" set "CODEX_HOME=%T3CODE_SERVICE_USERPROFILE%\.codex"
  if "%GH_CONFIG_DIR%"=="" set "GH_CONFIG_DIR=%T3CODE_SERVICE_USERPROFILE%\AppData\Roaming\GitHub CLI"
)

set "PATH=%T3CODE_SERVICE_USERPROFILE%\.local\bin;%LOCALAPPDATA%\OpenAI\Codex\bin;%T3CODE_SERVICE_USERPROFILE%\AppData\Roaming\npm;%T3CODE_SERVICE_USERPROFILE%\.bun\bin;%LOCALAPPDATA%\Microsoft\WindowsApps;C:\Program Files\GitHub CLI;C:\Program Files\Git\cmd;C:\Program Files\Git\bin;%PATH%"

REM Git refuses repositories owned by another Windows account unless they are
REM marked safe. NSSM runs this service as LocalSystem while the working repos
REM are owned by Vivek, so mark service-launched git operations as safe for local
REM automation. This avoids false "not a git repository" / unsupported VCS errors.
if "%GIT_CONFIG_COUNT%"=="" (
  set "GIT_CONFIG_COUNT=1"
  set "GIT_CONFIG_KEY_0=safe.directory"
  set "GIT_CONFIG_VALUE_0=*"
)

echo [%DATE% %TIME%] service profile: USERPROFILE=%USERPROFILE% CODEX_HOME=%CODEX_HOME% GH_CONFIG_DIR=%GH_CONFIG_DIR% >> "logs\t3code-server.log"
where codex >> "logs\t3code-server.log" 2>&1
where gh >> "logs\t3code-server.log" 2>&1
where git >> "logs\t3code-server.log" 2>&1

if not "%T3CODE_OWNER_PAIRING_TOKEN%"=="" (
  set "T3CODE_OWNER_PAIRING_STATE=userdata"
  node scripts\seed-owner-pairing-token.ts >> "logs\t3code-server.log" 2>&1
)

node apps\server\dist\bin.mjs --port 3773 --host 127.0.0.1 --no-browser >> "logs\t3code-server.log" 2>&1

exit /b %ERRORLEVEL%
