// @map role: Локальное копирование исходников Defender в папки расширений Adobe.
// @map status: partial
// @map note: Системные отказы сообщаются предупреждением; проверенное обновление выполняет deploy-release.ps1.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const appData = process.env.APPDATA;

if (!appData) {
    console.error("APPDATA environment variable not found");
    process.exit(1);
}

function copyDir(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// 1. AE CEP
const aeSource = path.join(ROOT, 'extension', 'com.pard.defender');
const aeTarget = path.join(appData, 'Adobe', 'CEP', 'extensions', 'com.pard.defender');
if (fs.existsSync(aeSource)) {
    copyDir(aeSource, aeTarget);
    console.log("AE CEP successfully deployed to:", aeTarget);
}

// 2. Premiere Pro UXP
const uxpSource = path.join(ROOT, 'premiere', 'com.pard.defender.uxp');
const uxpTargets = [
    path.join(appData, 'Adobe', 'UXP', 'Plugins', 'External', 'com.pard.defender.uxp'),
    path.join(appData, 'Adobe', 'UXP', 'extensions', 'com.pard.defender.uxp'),
    path.join(appData, 'Adobe', 'Premiere Pro', '26.0', 'UXP', 'DebugPlugins', 'com.pard.defender.uxp'),
    path.join(appData, 'Adobe', 'Premiere Pro', '25.0', 'UXP', 'DebugPlugins', 'com.pard.defender.uxp'),
    'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2026\\UXP\\plugins\\com.pard.defender.uxp',
    'C:\\Program Files\\Common Files\\Adobe\\UXP\\Plugins\\External\\com.pard.defender.uxp',
    'C:\\Program Files\\Common Files\\Adobe\\UXP\\extensions\\com.pard.defender.uxp'
];

for (const target of uxpTargets) {
    try {
        copyDir(uxpSource, target);
        console.log("Premiere Pro UXP successfully deployed to:", target);
    } catch (e) {
        console.warn("Could not deploy to:", target, e.message);
    }
}
