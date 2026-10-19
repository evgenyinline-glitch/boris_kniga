@echo off
chcp 65001 >nul
title Интерактивная книга — локальный сервер
cd /d "%~dp0"

echo ============================================
echo   Интерактивная книга «Его Высочество Юмор»
echo   Локальный сервер: http://127.0.0.1:8000
echo   Остановка: Ctrl+C
echo ============================================
echo.

start "" "http://127.0.0.1:8000/index.html"

python -m http.server 8000 --bind 127.0.0.1
if errorlevel 1 (
    echo.
    echo Не удалось запустить Python. Попробуйте Node.js:
    echo   npx serve -l 8000
    pause
)
