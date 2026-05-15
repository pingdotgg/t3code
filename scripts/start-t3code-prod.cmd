@echo off
setlocal

REM Start all three prod pieces of the t3code setup:
REM   - t3code-server       : Windows service when installed, otherwise scheduled task fallback
REM   - cloudflared-t3code  : Windows service exposing https://t3.olumbe.com
REM   - t3code-desktop      : packaged desktop app scheduled task
REM
REM Safe to run if already running. Intended for local use; services/tasks
REM auto-start at boot/login.

set "REPO_ROOT=%~dp0.."
set "LOG_FILE=%REPO_ROOT%\logs\t3code-server.log"

echo Starting t3code-server...
powershell -NoProfile -Command "if (Get-Service t3code-server -ErrorAction SilentlyContinue) { Start-Service t3code-server } else { schtasks /run /tn t3code-server | Out-Null }" >nul 2>&1

echo Starting cloudflared-t3code...
powershell -NoProfile -Command "if (Get-Service cloudflared-t3code -ErrorAction SilentlyContinue) { Start-Service cloudflared-t3code } else { schtasks /run /tn t3code-tunnel | Out-Null }" >nul 2>&1

echo Starting t3code-desktop...
schtasks /run /tn t3code-desktop >nul 2>&1

echo.
echo Waiting for server to bind port 3773...
set /a TRIES=0
:wait_loop
set /a TRIES+=1
powershell -NoProfile -Command "exit !(([bool](Get-NetTCPConnection -LocalPort 3773 -State Listen -ErrorAction SilentlyContinue)))" >nul 2>&1
if %ERRORLEVEL%==0 goto wait_done
if %TRIES% GEQ 30 (
  echo [warn] server did not bind within 30s. Check "%LOG_FILE%"
  goto wait_done
)
timeout /t 1 /nobreak >nul
goto wait_loop
:wait_done

echo Checking public endpoint https://t3.olumbe.com...
curl -sS -o NUL -w "  https://t3.olumbe.com -> %%{http_code}\n" https://t3.olumbe.com/

echo Checking unauthenticated bridge route...
curl -sS -o NUL -X POST -w "  /api/execution/runs/status -> %%{http_code} (expected 401 when secret is configured)\n" https://t3.olumbe.com/api/execution/runs/status

echo.
echo Pairing URL:
powershell -NoProfile -Command "if ($env:T3CODE_OWNER_PAIRING_TOKEN) { '  https://t3.olumbe.com/pair#token=' + [uri]::EscapeDataString($env:T3CODE_OWNER_PAIRING_TOKEN) } else { $line = Get-Content -LiteralPath '%LOG_FILE%' -Tail 200 -ErrorAction SilentlyContinue | Where-Object { $_ -match 'pairingUrl:' } | Select-Object -Last 1; if ($line) { '  ' + (($line -replace '.*pairingUrl:\s*', '').Trim() -replace 'http://127\.0\.0\.1:3773', 'https://t3.olumbe.com') } else { '  (no pairingUrl found yet - check ' + '%LOG_FILE%' + ')' } }"

endlocal
