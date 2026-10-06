# @map role: Обновляет существующие установки AE и Premiere из исходников с backup и проверкой SHA-256.
# @map status: ready
param([switch]$System)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskUxpSource = Join-Path $taskRoot 'premiere\com.pard.defender.uxp'
$taskAeSource = Join-Path $taskRoot 'extension\com.pard.defender'
$taskTargets = @(
    @{ Source = $taskAeSource; Target = (Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.pard.defender') },
    @{ Source = $taskUxpSource; Target = (Join-Path $env:APPDATA 'Adobe\UXP\Plugins\External\com.pard.defender.uxp') },
    @{ Source = $taskUxpSource; Target = (Join-Path $env:APPDATA 'Adobe\UXP\extensions\com.pard.defender.uxp') },
    @{ Source = $taskUxpSource; Target = (Join-Path $env:APPDATA 'Adobe\Premiere Pro\26.0\UXP\DebugPlugins\com.pard.defender.uxp') },
    @{ Source = $taskUxpSource; Target = (Join-Path $env:APPDATA 'Adobe\Premiere Pro\25.0\UXP\DebugPlugins\com.pard.defender.uxp') }
)
if ($System) {
    $taskTargets = @(
        @{ Source = $taskUxpSource; Target = 'C:\Program Files\Adobe\Adobe Premiere Pro 2026\UXP\plugins\com.pard.defender.uxp' },
        @{ Source = $taskUxpSource; Target = 'C:\Program Files\Common Files\Adobe\UXP\extensions\com.pard.defender.uxp' }
    )
}
foreach ($taskEntry in $taskTargets) {
    if (-not (Test-Path -LiteralPath $taskEntry.Target -PathType Container)) { throw "Expected installation missing: $($taskEntry.Target)" }
    if (-not (Test-Path -LiteralPath $taskEntry.Source -PathType Container)) { throw "Source missing: $($taskEntry.Source)" }
}
$taskBackupRoot = Join-Path $env:TEMP ('PardDefender-release-backup-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $taskBackupRoot | Out-Null
$taskPlans = @()
$taskIndex = 0
foreach ($taskEntry in $taskTargets) {
    foreach ($taskFile in (Get-ChildItem -LiteralPath $taskEntry.Source -Recurse -File)) {
        $taskRelative = $taskFile.FullName.Substring($taskEntry.Source.Length + 1)
        $taskDestination = Join-Path $taskEntry.Target $taskRelative
        $taskBackup = Join-Path (Join-Path $taskBackupRoot ('installation-' + $taskIndex)) $taskRelative
        if (Test-Path -LiteralPath $taskDestination -PathType Leaf) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $taskBackup) -Force | Out-Null
            Copy-Item -LiteralPath $taskDestination -Destination $taskBackup
            if ((Get-FileHash -LiteralPath $taskDestination).Hash -ne (Get-FileHash -LiteralPath $taskBackup).Hash) { throw "Backup mismatch: $taskDestination" }
        }
        $taskPlans += @{ Source = $taskFile.FullName; Destination = $taskDestination }
    }
    $taskIndex++
}
foreach ($taskPlan in $taskPlans) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskPlan.Destination) -Force | Out-Null
    Copy-Item -LiteralPath $taskPlan.Source -Destination $taskPlan.Destination -Force
    if ((Get-FileHash -LiteralPath $taskPlan.Source).Hash -ne (Get-FileHash -LiteralPath $taskPlan.Destination).Hash) { throw "Installed file mismatch: $($taskPlan.Destination)" }
}
Write-Output ("Updated and verified files: " + $taskPlans.Count)
Write-Output ("Backup: " + $taskBackupRoot)
