@echo off
REM ============================================================
REM  IotBench launcher
REM  Usage:  start.bat            -> web UI + scale slave on COM9
REM          start.bat COM5       -> use a different serial port
REM          start.bat none       -> web UI only (no serial)
REM          start.bat COM9 plc   -> GDC PLC slave instead of scales (19200 8N2)
REM ============================================================
setlocal
cd /d "%~dp0"

set "COMPORT=%~1"
if "%COMPORT%"=="" set "COMPORT=COM9"
set "MODE=%~2"
if "%MODE%"=="" set "MODE=scales"

REM install dependencies on first run
if not exist "node_modules" (
    echo Installing dependencies ^(first run^)...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed. Is Node.js installed?  https://nodejs.org
        pause
        exit /b 1
    )
)

REM stop any previous IotBench instance so we never double-run (prevents COM9 / port 9010 conflicts)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'server\.js|run-scales\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

echo.
echo   IotBench starting...
echo   Reply editor : http://localhost:9010/
echo   Scale panel  : http://localhost:9010/scales
echo   PLC panel    : http://localhost:9010/plc
echo   MQTT monitor : http://localhost:9010/mqtt
echo   Bin/Crane data: http://localhost:9010/crane ^(topic bin/data^)
echo   Charge-mix bin: http://localhost:9010/bin ^(bin/chargemix, act as software or board^)
echo   PHSupport SQL : http://localhost:9010/phsupport ^(rows API for the SMES production-flow sync^)
echo   MQTT broker  : TCP 1883 ^(point ESP32 mqttBroker at this PC's IP^)

REM ensure Windows Firewall allows the ports (needs admin; skipped if not elevated)
net session >nul 2>&1
if %errorlevel%==0 (
    netsh advfirewall firewall show rule name="IotBench HTTP 9010" >nul 2>&1 || netsh advfirewall firewall add rule name="IotBench HTTP 9010" dir=in action=allow protocol=TCP localport=9010 >nul
    netsh advfirewall firewall show rule name="IotBench MQTT 1883" >nul 2>&1 || netsh advfirewall firewall add rule name="IotBench MQTT 1883" dir=in action=allow protocol=TCP localport=1883 >nul
    echo   Firewall     : rules ensured ^(TCP 9010, 1883^)
) else (
    echo   Firewall     : not admin - run as Administrator once if a device cannot connect
)

if /I "%COMPORT%"=="none" (
    echo   Serial       : OFF ^(web UI only^)
    echo.
    node server.js
) else (
    if /I "%MODE%"=="plc" (
        echo   Serial       : %COMPORT% @ 19200 8N2 - GDC PLC slave 1
    ) else (
        echo   Serial       : %COMPORT% @ 9600 8N1 - scales
    )
    echo.
    node server.js %COMPORT% %MODE%
)

echo.
echo IotBench stopped.
pause
endlocal
