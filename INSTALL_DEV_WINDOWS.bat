@echo off
rem @map role: Ставит расширения PardDefender в After Effects (CEP) и Premiere Pro (UXP), включает PlayerDebugMode.
rem @map status: ready
rem @map layer: install
setlocal

set "EXT_ID=com.pard.defender"
set "AE_SOURCE=%~dp0extension\%EXT_ID%"
set "AE_TARGET=%APPDATA%\Adobe\CEP\extensions\%EXT_ID%"

set "UXP_ID=com.pard.defender.uxp"
set "UXP_SOURCE=%~dp0premiere\%UXP_ID%"
set "UXP_TARGET1=%APPDATA%\Adobe\UXP\Plugins\External\%UXP_ID%"
set "UXP_TARGET2=%APPDATA%\Adobe\UXP\extensions\%UXP_ID%"

echo ========================================================
echo Installing PardDefender 2.0.0 for AE and Premiere Pro...
echo ========================================================

rem 1. Check sources
if not exist "%AE_SOURCE%\CSXS\manifest.xml" (
    echo ERROR: After Effects CEP extension files were not found next to this installer.
    pause
    exit /b 1
)

if not exist "%UXP_SOURCE%\manifest.json" (
    echo ERROR: Premiere Pro UXP extension files were not found next to this installer.
    pause
    exit /b 1
)

rem 2. Enable PlayerDebugMode for After Effects CEP
for %%V in (9 10 11 12 13 14 15) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)

rem 3. Install After Effects CEP extension
echo [1/2] Installing After Effects extension...
if exist "%AE_TARGET%" rmdir /s /q "%AE_TARGET%"
if exist "%AE_TARGET%" (
    echo ERROR: The previous After Effects extension could not be removed.
    echo Close After Effects and try again.
    pause
    exit /b 1
)
mkdir "%AE_TARGET%" >nul 2>&1
xcopy "%AE_SOURCE%\*" "%AE_TARGET%\" /E /I /Y >nul
if errorlevel 1 (
    echo ERROR: The After Effects extension could not be copied.
    pause
    exit /b 1
)

findstr /C:"2.0.0" "%AE_TARGET%\CSXS\manifest.xml" >nul
if errorlevel 1 (
    echo ERROR: Installed After Effects manifest verification failed.
    pause
    exit /b 1
)

for %%F in (PardDefenderCore.jsx PardDefenderPlan.jsx PardDefenderAudit.jsx PardDefenderApply.jsx PardDefenderLayers.jsx) do (
    if not exist "%AE_TARGET%\host\%%F" (
        echo ERROR: Host module %%F is missing from the installed AE extension.
        pause
        exit /b 1
    )
)

rem 4. Install Premiere Pro UXP plugin
echo [2/2] Installing Premiere Pro UXP plugin...
for %%T in ("%UXP_TARGET1%" "%UXP_TARGET2%") do (
    if exist "%%~T" rmdir /s /q "%%~T"
    mkdir "%%~T" >nul 2>&1
    xcopy "%UXP_SOURCE%\*" "%%~T\" /E /I /Y >nul
    if errorlevel 1 (
        echo WARNING: Failed copying to %%~T
    )
)

if not exist "%UXP_TARGET1%\manifest.json" (
    echo ERROR: Premiere Pro UXP installation verification failed.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo Installation complete!
echo.
echo After Effects:
echo   Restart After Effects, then open:
echo     Window ^> Extensions ^> PardDefender
echo.
echo Premiere Pro:
echo   Restart Premiere Pro, then open:
echo     Window ^> Extensions (or Plugins) ^> PardDefender
echo ========================================================
echo.
pause
endlocal
