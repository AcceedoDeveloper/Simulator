@echo off
REM ============================================================
REM  IotBench stopper
REM  Stops only IotBench's node processes (server.js / run-scales.js).
REM  Leaves any unrelated Node apps and the firewall rules alone.
REM ============================================================
echo Stopping IotBench ^(server.js / run-scales.js^) ...

powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'server\.js|run-scales\.js' }; if ($p) { $p | ForEach-Object { Write-Host ('  killing PID ' + $_.ProcessId) ; Stop-Process -Id $_.ProcessId -Force } } else { Write-Host '  no IotBench node process found' }"

echo Done.
pause
