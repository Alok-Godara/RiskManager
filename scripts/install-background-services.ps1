# Registers two Windows scheduled tasks that keep the Risk Manager running
# whenever you are logged in — a LOCKED screen does not stop them; sleeping,
# hibernating or shutting down the PC does:
#
#   RiskManagerPriceWorker  headless QuantHub -> Supabase price updater (no browser needed)
#   RiskManagerWebServer    the local dashboard at http://localhost:5173
#
# Each starts at logon, is re-checked every 5 minutes, restarts itself 15s after
# a crash, and only ever runs one copy. Run from the project root:
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-background-services.ps1
#
# Remove them again with:
#
#   Unregister-ScheduledTask -TaskName RiskManagerPriceWorker, RiskManagerWebServer -Confirm:$false
#
# Re-run this script after changing the worker's source or the VITE_* values in
# .env.local (they are baked into the worker bundle at build time). A changed
# QH_API_TOKEN needs no re-run: the worker re-reads it by itself when QuantHub
# rejects the old one, and the dev server restarts on any .env change.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "Building the price worker..."
npm run worker:build
if ($LASTEXITCODE -ne 0) { throw "worker build failed" }

$user = "$env:USERDOMAIN\$env:USERNAME"

function Install-Service($taskName, $launcherFile, $description, $processPattern) {
  $launcher = Join-Path $PSScriptRoot $launcherFile

  # Stop any copy that is already running (supervisor first, so it doesn't
  # respawn what we kill), so the fresh build / config takes over.
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like "*$launcherFile*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($processPattern) {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -like $processPattern } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Seconds 1

  # wscript + hidden-launch.vbs: runs the launcher with no window at all (a
  # visible console would also get closed by accident and kill the service).
  $vbs = Join-Path $PSScriptRoot "hidden-launch.vbs"
  $action = New-ScheduledTaskAction -Execute "wscript.exe" `
    -Argument "//B //Nologo `"$vbs`" `"$launcher`"" `
    -WorkingDirectory $root
  # At logon, plus a 5-minute watchdog: if the process (or its console) is ever
  # killed, the next tick starts it again; while it runs, ticks are ignored
  # (MultipleInstances IgnoreNew + the launcher's lock file).
  $trigger = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $user),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650))
  )
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)

  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description $description -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-Host "Task '$taskName' registered and started."
}

Install-Service "RiskManagerPriceWorker" "run-price-worker.cmd" `
  "Keeps Risk Manager live prices updating (QuantHub -> Supabase) with no browser open." "*dist-worker*priceWorker.js*"
Install-Service "RiskManagerWebServer" "run-web-server.cmd" `
  "Serves the Risk Manager dashboard at http://localhost:5173." "*node_modules*vite*vite.js*"

Write-Host "Done. Logs: $root\logs\price-worker.log and web-server.log"
