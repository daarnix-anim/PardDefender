@echo off
rem @map role: Ставит расширение в %APPDATA%/Adobe/CEP/extensions и включает PlayerDebugMode.
rem @map status: ready
rem @map layer: install
setlocal

set "EXT_ID=com.pard.defender"
set "SOURCE=%~dp0extension\%EXT_ID%"
set "TARGET=%APPDATA%\Adobe\CEP\extensions\%EXT_ID%"

echo Installing PardDefender 1.0.2...

if not exist "%SOURCE%\CSXS\manifest.xml" (
    echo ERROR: Extension files were not found next to this installer.
    pause
    exit /b 1
)

rem An unsigned extension only loads with PlayerDebugMode set. The range covers
rem every CEP runtime After Effects 2017 through 2026 may register.
for %%V in (9 10 11 12 13 14 15) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)

if exist "%TARGET%" rmdir /s /q "%TARGET%"
if exist "%TARGET%" (
    echo ERROR: The previous extension could not be removed.
    echo Close After Effects and every PardDefender panel, then run this again.
    pause
    exit /b 1
)
mkdir "%TARGET%" >nul 2>&1

xcopy "%SOURCE%\*" "%TARGET%\" /E /I /Y >nul
if errorlevel 1 (
    echo ERROR: The extension could not be copied.
    pause
    exit /b 1
)

findstr /C:"1.0.2" "%TARGET%\CSXS\manifest.xml" >nul
if errorlevel 1 (
    echo ERROR: Installed manifest verification failed.
    pause
    exit /b 1
)

for %%F in (PardDefenderCore.jsx PardDefenderPlan.jsx PardDefenderAudit.jsx PardDefenderApply.jsx) do (
    if not exist "%TARGET%\host\%%F" (
        echo ERROR: Host module %%F is missing from the installed extension.
        pause
        exit /b 1
    )
)

echo.
echo Installation complete.
echo Restart After Effects, then open:
echo   Window ^> Extensions ^> PardDefender
echo.
pause
endlocal
