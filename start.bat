@echo off
title Doudizhu Launcher
echo ============================================
echo   Doudizhu - One-click Launcher
echo ============================================
echo.
echo [1/2] Starting game server (port 3000)...
start "Doudizhu Server" cmd /k "cd /d %~dp0 && node node-server.js"
timeout /t 2 >nul
echo [2/2] Starting cpolar public tunnel...
start "cpolar Tunnel" cmd /k "cpolar http 3000"
echo.
echo ============================================
echo   DONE! Two windows opened:
echo.
echo   "Doudizhu Server" = game backend (keep open)
echo   "cpolar Tunnel"   = public URL (keep open)
echo.
echo   Local:  http://localhost:3000
echo   Public: look in the cpolar window for a
echo           *.cpolar.cn URL - share it with
echo           friends so they can join!
echo ============================================
echo.
echo Keep both windows open while playing.
echo Close them to stop the server.
echo.
pause
