@echo off
cd /d "%~dp0"
call npm.cmd run build
if errorlevel 1 goto failed
node_modules\electron\dist\electron.exe . --demo --no-device
if errorlevel 1 goto failed
exit /b 0
:failed
pause
