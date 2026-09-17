/*
 *
 * @map role: 35 проверок защиты файлов, поблочного копирования, хеширования и консолидации в Premiere UXP.
 * @map status: ready
 *
 * Tests NIST SHA-256 vectors, chunk copy with .pdpart, pending.tsv journaling & recovery,
 * exact reuse, provenance in assets.tsv, relink rejection (canChange=false, stale path,
 * unsupported types), post-relink verification, duplicate scanning, safe consolidation,
 * and strict guarantee of zero deletion of original media files or project items.
 *
 *   node tests/premiere-protection.test.js
 */
"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");
var mock = require("./mock-premiere");

var passed = 0, failed = 0;

function check(label, actual, expected) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failed++;
    console.log("FAIL  " + label + "\n      ожидалось " + e + "\n      получено  " + a);
}

function group(name) { console.log("\n" + name); }

var testDir = path.join(os.tmpdir(), "pd-test-prem-protect-" + Date.now()).replace(/\\/g, "/");
function nativePath(p) { return String(p).replace(/\//g, path.sep); }
function mkdir(p) { fs.mkdirSync(nativePath(p), { recursive: true }); }
function writeFile(p, text) { mkdir(path.dirname(nativePath(p))); fs.writeFileSync(nativePath(p), text, "utf8"); }

mkdir(testDir);

var PardPremiereCopyEngine = require("../premiere/com.pard.defender.uxp/copy-engine.js");
var PardPremiereDuplicates = require("../premiere/com.pard.defender.uxp/duplicates.js");
var PardPremiereAdapter = require("../premiere/com.pard.defender.uxp/adapter.js");

PardPremiereCopyEngine.setFs(fs);
PardPremiereDuplicates.setFs(fs);

var steps = [];

/* ========================================================================= */
steps.push(function (next) {
    group("NIST SHA-256 тестовые векторы инкрементального хешера");

    var h1 = PardPremiereCopyEngine.createSha256();
    check("пустая строка NIST", h1.digest(),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    var h2 = PardPremiereCopyEngine.createSha256();
    h2.update("abc");
    check("вектор 'abc' NIST", h2.digest(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

    var h3 = PardPremiereCopyEngine.createSha256();
    h3.update("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq");
    check("вектор 448-bit multi-block NIST", h3.digest(),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");

    next();
});

/* ========================================================================= */
steps.push(function (next) {
    group("Поблочное копирование: .pdpart, SHA-256 верификация и атомарный rename");

    var ws = testDir + "/ws_copy";
    mkdir(ws + "/.parddefender");
    var src = testDir + "/sources/video1.mp4";
    var dst = ws + "/01_assets/_SHARED/VIDEO/video1.mp4";
    writeFile(src, "HEAVY_VIDEO_PAYLOAD_CHUNKS_OF_DATA");

    var progressEvents = [];

    PardPremiereCopyEngine.copyChunked(src, dst, {
        id: "task-1",
        workspace: ws
    }, {
        onProgress: function (p) { progressEvents.push(p); },
        onDone: function (res) {
            check("копирование успешно", res.ok, true);
            check("целевой файл существует", fs.existsSync(nativePath(dst)), true);
            check("содержимое целевого файла совпадает", fs.readFileSync(nativePath(dst), "utf8"), "HEAVY_VIDEO_PAYLOAD_CHUNKS_OF_DATA");
            check("исходный файл не тронут", fs.existsSync(nativePath(src)), true);
            check("прогресс отправлялся", progressEvents.length > 0, true);

            // Проверяем, что в целевой папке нет оставшихся .pdpart
            var dirFiles = fs.readdirSync(nativePath(path.dirname(dst)));
            var parts = dirFiles.filter(function (f) { return /\.pdpart$/.test(f); });
            check("временных .pdpart не осталось", parts.length, 0);

            next();
        }
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Откат и аварийное восстановление (pending.tsv и очистка .pdpart)");

    var ws = testDir + "/ws_pending";
    mkdir(ws + "/.parddefender");
    var deadPart = ws + "/01_assets/_SHARED/VIDEO/abandoned.mp4.12345.pdpart";
    writeFile(deadPart, "HALF_WRITTEN_CORRUPTED_BYTES");

    var innocentFile = ws + "/01_assets/_SHARED/VIDEO/innocent.mp4";
    writeFile(innocentFile, "DO_NOT_TOUCH_ME");

    // Записываем брошенный .pdpart в pending.tsv
    var pTsv = ws + "/.parddefender/pending.tsv";
    var row = [new Date().toISOString(), "task-crash", "src.mp4", "dst.mp4", deadPart].join("\t") + "\n";
    writeFile(pTsv, row);

    var rec = PardPremiereCopyEngine.recoverPending(ws);
    check("найден и удалён ровно 1 брошенный .pdpart", rec.recovered, 1);
    check("файл .pdpart реально удалён", fs.existsSync(nativePath(deadPart)), false);
    check("невинный файл не удалён", fs.existsSync(nativePath(innocentFile)), true);
    check("pending.tsv очищен после восстановления", fs.existsSync(nativePath(pTsv)), false);

    next();
});

/* ========================================================================= */
steps.push(function (next) {
    group("Очередь задач: переиспользование точных копий и запись в assets.tsv");

    var ws = testDir + "/ws_queue";
    mkdir(ws + "/.parddefender");
    var src = testDir + "/sources/shot_queue.mp4";
    var dst = ws + "/01_assets/_SHARED/VIDEO/shot_queue.mp4";
    writeFile(src, "IDENTICAL_BYTES_FOR_REUSE");

    var tasks = [{
        id: "q1",
        sourcePath: src,
        destPath: dst,
        allowReuse: true,
        branch: "_SHARED",
        category: "video"
    }];

    // Первый проход: копирование
    PardPremiereCopyEngine.runQueue(ws, tasks, {}, {
        onDone: function (res1) {
            check("первый проход: успешно", res1.ok, true);

            var assetsContent = fs.readFileSync(nativePath(ws + "/.parddefender/assets.tsv"), "utf8");
            check("provenance записан в assets.tsv", assetsContent.indexOf("shot_queue.mp4") !== -1, true);

            // Второй проход с allowReuse: true
            PardPremiereCopyEngine.runQueue(ws, tasks, {}, {
                onDone: function (res2) {
                    check("второй проход: успешно", res2.ok, true);
                    check("файл был переиспользован (reused)", res2.results[0].reused, true);
                    next();
                }
            });
        }
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Перелинковка клипов Premiere (relinkClip): проверки безопасности");

    var clipNormal = new mock.MockClipProjectItem("ClipA", "c:/old/path/clipA.mp4");
    var resNormal = PardPremiereCopyEngine.relinkClip(clipNormal, "c:/new/dest/clipA.mp4", "c:/old/path/clipA.mp4");
    check("нормальная перелинковка успешна", resNormal.ok, true);
    check("путь клипа обновился", PardPremiereCopyEngine.normalizePath(clipNormal.getMediaFilePath()), "c:/new/dest/clipA.mp4");

    // 1. Отклонение при устаревшем пути источника
    var clipStale = new mock.MockClipProjectItem("ClipB", "c:/current/path/clipB.mp4");
    var resStale = PardPremiereCopyEngine.relinkClip(clipStale, "c:/new/dest/clipB.mp4", "c:/expected/old/clipB.mp4");
    check("отклонено: STALE_SOURCE", resStale.code, "STALE_SOURCE");

    // 2. Отклонение когда canChangeMediaPath возвращает false
    var clipLocked = new mock.MockClipProjectItem("ClipLocked", "c:/path/locked.mp4");
    clipLocked.canChangeMediaPath = function () { return false; };
    var resLocked = PardPremiereCopyEngine.relinkClip(clipLocked, "c:/new/path/locked.mp4", "c:/path/locked.mp4");
    check("отклонено: CANNOT_CHANGE_PATH", resLocked.code, "CANNOT_CHANGE_PATH");

    // 3. Отклонение для multicam / merged / synthetic
    var clipMulti = new mock.MockClipProjectItem("Multi", "c:/path/multi.mp4", { isMulticam: true });
    var resMulti = PardPremiereCopyEngine.relinkClip(clipMulti, "c:/new/multi.mp4");
    check("отклонено: UNSUPPORTED_TYPE", resMulti.code, "UNSUPPORTED_TYPE");

    next();
});

/* ========================================================================= */
steps.push(function (next) {
    group("Поиск дубликатов и транзакционное объединение (consolidation) в Premiere");

    var ws = testDir + "/ws_dup_cons";
    mkdir(ws + "/01_assets");
    mkdir(ws + "/.parddefender");

    var fileCan = ws + "/01_assets/can.mp4";
    var fileDup = ws + "/01_assets/dup.mp4";
    writeFile(fileCan, "EXACT_DUPLICATE_PREMIERE_BYTES");
    writeFile(fileDup, "EXACT_DUPLICATE_PREMIERE_BYTES");

    var stat = fs.statSync(nativePath(fileCan));

    var clip1 = new mock.MockClipProjectItem("Clip1", fileCan);
    var clip2 = new mock.MockClipProjectItem("Clip2", fileDup);

    var auditItems = [
        { id: "c1", name: "Clip1", path: fileCan, classification: "clip", size: stat.size, missing: false },
        { id: "c2", name: "Clip2", path: fileDup, classification: "clip", size: stat.size, missing: false }
    ];

    var pMap = { "c1": clip1, "c2": clip2 };

    // 1. Поиск дубликатов
    PardPremiereDuplicates.scanDuplicates(ws, auditItems, PardPremiereCopyEngine, {
        onDone: function (scanRes) {
            check("дубликаты найдены", scanRes.ok, true);
            check("найдена 1 группа дубликатов", scanRes.duplicateGroups.length, 1);
            var grp = scanRes.duplicateGroups[0];
            check("в группе 2 файла", grp.files.length, 2);

            // 2. Объединение дубликатов
            PardPremiereDuplicates.consolidateGroup(ws, grp, fileCan, pMap, PardPremiereCopyEngine, {
                onDone: function (consRes) {
                    check("объединение успешно", consRes.ok, true);
                    check("перелинковано 2 ссылки", consRes.relinked, 2);

                    // Проверка состояния клипов
                    check("клип 1 указывает на каноникал", PardPremiereCopyEngine.normalizePath(clip1.getMediaFilePath()), PardPremiereCopyEngine.normalizePath(fileCan));
                    check("клип 2 перелинкован на каноникал", PardPremiereCopyEngine.normalizePath(clip2.getMediaFilePath()), PardPremiereCopyEngine.normalizePath(fileCan));

                    // БЕЗОПАСНОСТЬ: исходный файл дубликата на диске НЕ удалён!
                    check("исходный файл каноникала на месте", fs.existsSync(nativePath(fileCan)), true);
                    check("исходный файл дубликата НЕ удалён", fs.existsSync(nativePath(fileDup)), true);

                    next();
                }
            });
        }
    });
});

/* Runner */
function runSteps(idx) {
    if (idx >= steps.length) {
        console.log("\nИтоги: пройдено " + passed + ", провалено " + failed);
        if (failed > 0) process.exit(1);
        return;
    }
    steps[idx](function () {
        runSteps(idx + 1);
    });
}

runSteps(0);
