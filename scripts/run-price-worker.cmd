@echo off
rem Keeps the background price worker running: builds it if needed, starts it,
rem and restarts it 15s after any exit. Logs go to logs\price-worker.log.
rem Only one copy can run at a time (a second launch exits straight away).
rem Normally started by the "RiskManagerPriceWorker" scheduled task
rem (scripts\install-background-services.ps1), but safe to double-click too.
setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs
set "LOCK=%CD%\logs\.price-worker.lock"

2>nul (
  >"%LOCK%" (
    call :run
  )
) || echo Price worker is already running - nothing to do.
exit /b

:run
if not exist dist-worker\priceWorker.js call npm run worker:build >> logs\price-worker.log 2>&1
:loop
node dist-worker\priceWorker.js >> logs\price-worker.log 2>&1
echo [%date% %time%] worker exited with code %errorlevel%, restarting in 15s >> logs\price-worker.log
ping -n 16 127.0.0.1 >nul
goto loop
