@echo off
setlocal
if "%~1"=="" (
    wscript "%~dp0start-helper.vbs"
) else (
    wscript "%~dp0start-helper.vbs" "%~1"
)
echo Mania Replay Master helper started hidden in the background.
echo osu! folder is auto-detected; pass a path to override: start-helper.bat "E:\osu!"
echo It exits automatically once osu! or tosu is closed (or after 10 minutes idle).
ping -n 4 127.0.0.1 >nul
