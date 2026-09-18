// @map role: Скрипт сборки release-архивов для GitHub (zip и ccx).
// @map status: ready
// @map layer: tool

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const STAGING_DIR = path.join(os.tmpdir(), 'parddefender-staging-' + Date.now());

if (fs.existsSync(RELEASE_DIR)) {
  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
}
fs.mkdirSync(RELEASE_DIR, { recursive: true });
fs.mkdirSync(STAGING_DIR, { recursive: true });


console.log('1. Preparing staging directory...');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
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

// Copy extension (AE CEP)
copyDir(path.join(ROOT, 'extension'), path.join(STAGING_DIR, 'extension'));

// Copy premiere (UXP)
copyDir(path.join(ROOT, 'premiere'), path.join(STAGING_DIR, 'premiere'));

// Copy installer & docs
fs.copyFileSync(path.join(ROOT, 'INSTALL_DEV_WINDOWS.bat'), path.join(STAGING_DIR, 'INSTALL_DEV_WINDOWS.bat'));
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(STAGING_DIR, 'README.md'));
if (fs.existsSync(path.join(ROOT, 'docs'))) {
  copyDir(path.join(ROOT, 'docs'), path.join(STAGING_DIR, 'docs'));
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'premiere', 'com.pard.defender.uxp', 'manifest.json'), 'utf8'));
const VERSION = manifest.version || '2.0.3';

console.log(`2. Creating PardDefender-${VERSION}.zip (all-in-one)...`);
const zipPath = path.join(RELEASE_DIR, `PardDefender-${VERSION}.zip`);
execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${STAGING_DIR}\\*' -DestinationPath '${zipPath}' -Force"`);

console.log(`3. Creating PardDefender-${VERSION}.ccx (Premiere Pro UXP package)...`);
const ccxTempZip = path.join(RELEASE_DIR, `PardDefender-${VERSION}-uxp.zip`);
const ccxPath = path.join(RELEASE_DIR, `PardDefender-${VERSION}.ccx`);
const uxpSource = path.join(ROOT, 'premiere', 'com.pard.defender.uxp');
execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${uxpSource}\\*' -DestinationPath '${ccxTempZip}' -Force"`);
fs.renameSync(ccxTempZip, ccxPath);

// Clean staging
fs.rmSync(STAGING_DIR, { recursive: true, force: true });

console.log('Build finished successfully:');
console.log('  ->', zipPath, `(${fs.statSync(zipPath).size} bytes)`);
console.log('  ->', ccxPath, `(${fs.statSync(ccxPath).size} bytes)`);
