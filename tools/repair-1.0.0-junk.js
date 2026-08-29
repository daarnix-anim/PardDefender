/*
 *
 * @map role: Разовая починка проектов после 1.0.0: копии без расширения —
 *           в Корзину, манифест чистится. По умолчанию — пробный прогон.
 * @map status: ready
 * One-off repair for projects protected by PardDefender 1.0.0.
 *
 * 1.0.0 built the destination path from the route alone and never appended the
 * file name. A route names a FOLDER, so every copy landed as a file literally
 * called "VIDEO" (then "VIDEO (2)", "VIDEO (3)" as the names collided) with no
 * extension - which is why After Effects refused to relink them: a file with no
 * extension is not a recognised type.
 *
 * This script finds exactly those files - extension-less files inside the
 * workspace whose paths PardDefender itself recorded in assets.tsv - sends them
 * to the Recycle Bin, and drops the matching manifest rows so the extension
 * re-copies them correctly under 1.0.1.
 *
 * Originals are never touched: this only ever looks inside the workspace.
 *
 *   node tools/repair-1.0.0-junk.js "<workspace>"           # dry run, default
 *   node tools/repair-1.0.0-junk.js "<workspace>" --apply   # actually repair
 */
"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");
var childProcess = require("child_process");

var workspace = String(process.argv[2] || "").replace(/\\/g, "/").replace(/\/+$/, "");
var apply = process.argv.indexOf("--apply") >= 0;

if (!workspace) {
    console.log("Использование: node tools/repair-1.0.0-junk.js \"<рабочая папка>\" [--apply]");
    process.exit(1);
}

var metaDir = workspace + "/.parddefender";
var manifestPath = metaDir + "/assets.tsv";

function native(p) { return String(p).replace(/\//g, path.sep); }

if (!fs.existsSync(native(manifestPath))) {
    console.log("Манифест не найден: " + manifestPath);
    console.log("Похоже, PardDefender в этой папке ещё не работал.");
    process.exit(1);
}

/* ------------------------------------------------- what 1.0.0 actually wrote */

var lines = fs.readFileSync(native(manifestPath), "utf8").split(/\r?\n/);
var rows = [];
lines.forEach(function (line) {
    if (!line) return;
    var f = line.split("\t");
    if (f.length < 5) return;
    rows.push({ line: line, source: f[2], dest: f[4].replace(/\\/g, "/") });
});

function leafOf(p) { return p.replace(/^.*\//, ""); }

/*
 * A junk file is one PardDefender recorded, that still exists, and whose name
 * carries no extension. Requiring a manifest row is what keeps this away from
 * anything the owner put in the workspace themselves.
 */
var junk = {}, keep = [];
rows.forEach(function (row) {
    var leaf = leafOf(row.dest);
    var extensionless = leaf.indexOf(".") < 0;
    if (extensionless && fs.existsSync(native(row.dest))) {
        junk[row.dest] = row.source;
    } else {
        keep.push(row.line);
    }
});

var paths = Object.keys(junk);
if (!paths.length) {
    console.log("Испорченных копий не найдено — чинить нечего.");
    process.exit(0);
}

var totalBytes = 0, orphans = [];
paths.forEach(function (p) {
    try { totalBytes += fs.statSync(native(p)).size; } catch (e) {}
    if (!fs.existsSync(native(junk[p]))) orphans.push(p);
});

console.log("Рабочая папка: " + workspace);
console.log("Испорченных копий: " + paths.length +
    " (" + (totalBytes / 1048576).toFixed(1) + " МБ)");
console.log("");
paths.forEach(function (p) {
    var mark = orphans.indexOf(p) >= 0 ? "  [!] оригинал недоступен" : "";
    console.log("  " + p.replace(workspace + "/", "") + mark);
    console.log("      оригинал: " + junk[p]);
});
console.log("");

if (orphans.length) {
    console.log("ВНИМАНИЕ: у " + orphans.length +
        " файлов оригинал сейчас недоступен — после удаления их придётся импортировать заново.");
    console.log("");
}

if (!apply) {
    console.log("Это пробный прогон. Ничего не тронуто.");
    console.log("Чтобы починить: node tools/repair-1.0.0-junk.js \"" + workspace + "\" --apply");
    process.exit(0);
}

/* --------------------------------------------------------------- the repair */

var scratch = String(os.tmpdir()).replace(/\\/g, "/") + "/parddefender-repair";
try { fs.mkdirSync(native(scratch), { recursive: true }); } catch (e) {}

var listFile = scratch + "/list.txt";
var scriptFile = scratch + "/recycle.ps1";

/* Recycle Bin, never a permanent delete: this is a repair, and a repair that
 * destroys data is not a repair. */
var script = [
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    "$ok = 0",
    "$fail = 0",
    "foreach ($line in [System.IO.File]::ReadAllLines($args[0], [System.Text.Encoding]::UTF8)) {",
    "  if ([string]::IsNullOrWhiteSpace($line)) { continue }",
    "  try {",
    "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($line, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    "    $ok = $ok + 1",
    "  } catch { $fail = $fail + 1 }",
    "}",
    "Write-Output \"$ok/$fail\""
].join("\n");

fs.writeFileSync(native(listFile), paths.map(native).join("\r\n"), "utf8");
fs.writeFileSync(native(scriptFile), script, "utf8");

childProcess.execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", native(scriptFile), native(listFile)],
    { windowsHide: true, timeout: 120000 },
    function (error, stdout) {
        var match = /(\d+)\/(\d+)/.exec(String(stdout || ""));
        if (!match) {
            console.log("Корзина недоступна, файлы не тронуты" + (error ? ": " + error : "."));
            process.exit(1);
        }
        console.log("В корзину отправлено: " + match[1] +
            (Number(match[2]) ? ", не удалось: " + match[2] : ""));

        /* Back the manifest up before rewriting it - it is the record of what is
         * protected, and a repair should not be able to lose it. */
        var backup = manifestPath + ".before-repair";
        try { fs.copyFileSync(native(manifestPath), native(backup)); } catch (e) {}
        fs.writeFileSync(native(manifestPath),
            keep.length ? keep.join("\n") + "\n" : "", "utf8");
        console.log("Манифест очищен от испорченных строк (" +
            rows.length + " → " + keep.length + "), копия: " + backup);

        /* The issue rows describe failures that no longer apply. */
        var issues = metaDir + "/issues.json";
        try {
            if (fs.existsSync(native(issues))) {
                fs.renameSync(native(issues), native(issues + ".before-repair"));
                console.log("Список проблем сброшен.");
            }
        } catch (e2) {}

        console.log("");
        console.log("Готово. Установите 1.0.1, откройте проект и нажмите «Разложить сейчас» —");
        console.log("файлы скопируются заново, уже с правильными именами.");
    }
);
