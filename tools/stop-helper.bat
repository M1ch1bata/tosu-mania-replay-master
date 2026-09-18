@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'mrm-helper' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Mania Replay Master helper stopped.
ping -n 3 127.0.0.1 >nul
