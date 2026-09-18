# @map role: Скрипт копирования UXP-плагина в системные каталоги Program Files с повышением прав.
# @map status: ready
# @map layer: install

$ErrorActionPreference = "Stop"

$source = "D:\Yandex.Disk\MyPrograms\Plugins After effets\Projector\premiere\com.pard.defender.uxp"
$targetPpro = "C:\Program Files\Adobe\Adobe Premiere Pro 2026\UXP\plugins\com.pard.defender.uxp"
$targetCommon = "C:\Program Files\Common Files\Adobe\UXP\extensions\com.pard.defender.uxp"

if (Test-Path "C:\Program Files\Adobe\Adobe Premiere Pro 2026\UXP\plugins") {
    if (Test-Path $targetPpro) { Remove-Item -Recurse -Force $targetPpro }
    New-Item -ItemType Directory -Force -Path $targetPpro | Out-Null
    Copy-Item -Recurse -Force "$source\*" $targetPpro
    Write-Host "Copied to Premiere Pro 2026 UXP plugins" -ForegroundColor Green
}

if (Test-Path "C:\Program Files\Common Files\Adobe\UXP\extensions") {
    if (Test-Path $targetCommon) { Remove-Item -Recurse -Force $targetCommon }
    New-Item -ItemType Directory -Force -Path $targetCommon | Out-Null
    Copy-Item -Recurse -Force "$source\*" $targetCommon
    Write-Host "Copied to Common Files UXP extensions" -ForegroundColor Green
}
