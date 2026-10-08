@echo off
rem Keeps the local dashboard server (Vite, http://localhost:5173) running and
rem restarts it 15s after any exit. Logs go to logs\web-server.log. Only one
rem copy can run at a time. Normally started by the "RiskManagerWebServer"
rem scheduled task (scripts\install-background-services.ps1).
setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs
set "LOCK=%CD%\logs\.web-server.lock"

2>nul (
  >"%LOCK%" (
    call :run
  )
) || echo Web server task is already running - nothing to do.
exit /b

:run
:loop
rem --strictPort: fail instead of silently hopping to 5174 if 5173 is taken.
call npm run dev -- --strictPort >> logs\web-server.log 2>&1
echo [%date% %time%] web server exited with code %errorlevel%, restarting in 15s >> logs\web-server.log
ping -n 16 127.0.0.1 >nul
goto loop
