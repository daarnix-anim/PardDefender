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
set "UXP_USER1=%APPDATA%\Adobe\UXP\Plugins\External\%UXP_ID%"
set "UXP_USER2=%APPDATA%\Adobe\UXP\extensions\%UXP_ID%"
set "UXP_SYS_PPRO=C:\Program Files\Adobe\Adobe Premiere Pro 2026\UXP\plugins\%UXP_ID%"
set "UXP_SYS_COMMON=C:\Program Files\Common Files\Adobe\UXP\extensions\%UXP_ID%"

set "IS_ADMIN=0"
net session >nul 2>&1
if %errorlevel% equ 0 set "IS_ADMIN=1"

if "%IS_ADMIN%"=="0" (
    if "%~1"=="" (
        echo Requesting administrator privileges for full installation...
        powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\" admin' -Verb RunAs" 2>nul
        if not errorlevel 1 exit /b
    )
)

echo ========================================================
echo Installing PardDefender 2.0.1 for AE and Premiere Pro...
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
echo [1/3] Installing After Effects extension...
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

findstr /C:"2.0.1" "%AE_TARGET%\CSXS\manifest.xml" >nul
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

rem 4. Install Premiere Pro UXP plugin into user directories
echo [2/3] Installing Premiere Pro UXP plugin (User)...
for %%T in ("%UXP_USER1%" "%UXP_USER2%") do (
    if exist "%%~T" rmdir /s /q "%%~T"
    mkdir "%%~T" >nul 2>&1
    xcopy "%UXP_SOURCE%\*" "%%~T\" /E /I /Y >nul
)

rem 5. If running as administrator, install into Premiere Pro system UXP plugins
echo [3/3] Installing Premiere Pro UXP plugin (System)...
if "%IS_ADMIN%"=="1" (
    if exist "C:\Program Files\Adobe\Adobe Premiere Pro 2026\UXP\plugins" (
        if exist "%UXP_SYS_PPRO%" rmdir /s /q "%UXP_SYS_PPRO%"
        mkdir "%UXP_SYS_PPRO%" >nul 2>&1
        xcopy "%UXP_SOURCE%\*" "%UXP_SYS_PPRO%\" /E /I /Y >nul
        echo       Installed into Premiere Pro 2026 UXP directory.
    )
    if exist "C:\Program Files\Common Files\Adobe\UXP\extensions" (
        if exist "%UXP_SYS_COMMON%" rmdir /s /q "%UXP_SYS_COMMON%"
        mkdir "%UXP_SYS_COMMON%" >nul 2>&1
        xcopy "%UXP_SOURCE%\*" "%UXP_SYS_COMMON%\" /E /I /Y >nul
        echo       Installed into Common Files Adobe UXP directory.
    )
) else (
    echo       Note: System directory copy skipped - run as Admin to copy to Program Files.
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
echo     Window ^> PardDefender
echo.
echo   * ВАЖНО: В Premiere Pro современные UXP-панели находятся
echo     напрямую в меню "Окно" (Window), а НЕ в "Расширения" (Extensions),
echo     где отображаются только старые CEP-плагины!
echo ========================================================
echo.
pause
endlocal
