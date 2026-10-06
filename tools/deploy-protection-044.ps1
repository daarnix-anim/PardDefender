# @map role: Обновление шести файлов Premiere Defender с резервной копией и проверкой хешей.
# @map status: ready
param([switch]$System)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $taskRoot 'premiere\com.pard.defender.uxp'
$targets = @(
    'C:\Users\hdnix\AppData\Roaming\Adobe\UXP\Plugins\External\com.pard.defender.uxp',
    'C:\Users\hdnix\AppData\Roaming\Adobe\UXP\extensions\com.pard.defender.uxp',
    'C:\Users\hdnix\AppData\Roaming\Adobe\Premiere Pro\26.0\UXP\DebugPlugins\com.pard.defender.uxp',
    'C:\Users\hdnix\AppData\Roaming\Adobe\Premiere Pro\25.0\UXP\DebugPlugins\com.pard.defender.uxp'
)
if ($System) {
    $targets = @(
        'C:\Program Files\Adobe\Adobe Premiere Pro 2026\UXP\plugins\com.pard.defender.uxp',
        'C:\Program Files\Common Files\Adobe\UXP\extensions\com.pard.defender.uxp'
    )
}
$files = @('main.js', 'adapter.js', 'copy-engine.js', 'sync-coordinator.js', 'index.html', 'styles.css')
foreach ($target in $targets) {
    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        throw "Expected installation is missing: $target"
    }
    foreach ($name in $files) {
        if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $name) -PathType Leaf)) {
            throw "Source file is missing: $name"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $target $name) -PathType Leaf)) {
            throw "Installed file is missing: $target / $name"
        }
    }
}
$backupRoot = Join-Path 'C:\Users\hdnix\AppData\Local\Temp' ('PardDefender-backup-044-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $backupRoot | Out-Null
$index = 0
# Back up every selected target before the first replacement. No deletions.
foreach ($target in $targets) {
    $backupDir = Join-Path $backupRoot ('installation-' + $index)
    New-Item -ItemType Directory -Path $backupDir | Out-Null
    foreach ($name in $files) {
        $installed = Join-Path $target $name
        $backup = Join-Path $backupDir $name
        Copy-Item -LiteralPath $installed -Destination $backup
        if ((Get-FileHash -LiteralPath $installed).Hash -ne (Get-FileHash -LiteralPath $backup).Hash) {
            throw "Backup verification failed: $installed"
        }
    }
    $index++
}
foreach ($target in $targets) {
    foreach ($name in $files) {
        $source = Join-Path $sourceRoot $name
        $destination = Join-Path $target $name
        Copy-Item -LiteralPath $source -Destination $destination -Force
        if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) {
            throw "Installed file verification failed: $destination"
        }
    }
    Write-Output "Updated and verified: $target"
}
Write-Output "Backup: $backupRoot"
