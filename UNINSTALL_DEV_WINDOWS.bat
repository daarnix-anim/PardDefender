@echo off
rem @map role: Снимает расширение. Проекты и файлы не трогаются.
rem @map status: ready
rem @map layer: install
setlocal

set "EXT_ID=com.pard.defender"
set "TARGET=%APPDATA%\Adobe\CEP\extensions\%EXT_ID%"

if not exist "%TARGET%" (
    echo PardDefender is not installed.
    pause
    exit /b 0
)

rmdir /s /q "%TARGET%"
if exist "%TARGET%" (
    echo ERROR: The extension could not be removed. Close After Effects and retry.
    pause
    exit /b 1
)

echo PardDefender was removed. Nothing in your projects was touched.
pause
endlocal
