@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'mrm-helper' }); if ($p.Count -eq 0) { Write-Host 'Mania Replay Master helper is not running.'; exit 0 }; $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Host ('Mania Replay Master helper stopped (' + $p.Count + ' process(es)).')"
ping -n 3 127.0.0.1 >nul
