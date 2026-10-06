# @map role: Безопасное обновление четырёх исправленных файлов Defender в двух системных установках Premiere.
# @map status: ready
# Run as Administrator. No deletion, registry writes, or changes to project/media files.
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $taskRoot 'premiere\com.pard.defender.uxp'
$targets = @(
    'C:\Program Files\Adobe\Adobe Premiere Pro 2026\UXP\plugins\com.pard.defender.uxp',
    'C:\Program Files\Common Files\Adobe\UXP\extensions\com.pard.defender.uxp'
)
$files = @('main.js', 'adapter.js', 'copy-engine.js', 'sync-coordinator.js')
foreach ($target in $targets) {
    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        throw "Expected Defender installation is missing: $target"
    }
    foreach ($name in $files) {
        $sourceFile = Join-Path $sourceRoot $name
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
            throw "Source is missing: $sourceFile"
        }
    }
}
foreach ($target in $targets) {
    foreach ($name in $files) {
        $sourceFile = Join-Path $sourceRoot $name
        $targetFile = Join-Path $target $name
        Copy-Item -LiteralPath $sourceFile -Destination $targetFile -Force
        if ((Get-FileHash -LiteralPath $sourceFile).Hash -ne (Get-FileHash -LiteralPath $targetFile).Hash) {
            throw "Installed file verification failed: $targetFile"
        }
    }
    Write-Output "Updated and verified: $target"
}
