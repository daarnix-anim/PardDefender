/*
 *
 * @map role: 24 проверки копирования на настоящих файлах во временной
 *           папке.
 * @map status: ready
 * Exercises the copy layer against real files in a scratch directory.
 *
 * The properties that matter are the safety ones: an original is never touched,
 * a partial write never becomes a destination, identical bytes are reused rather
 * than duplicated, and a failed multi-file task leaves nothing behind.
 *
 *   node tests/copy-queue.test.js
 */
"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");
var vm = require("vm");

var passed = 0, failed = 0;

function check(label, actual, expected) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failed++;
    console.log("FAIL  " + label + "\n      ожидалось " + e + "\n      получено  " + a);
}

function group(name) { console.log("\n" + name); }

/* --------------------------------------------------------------- harness */

function loadQueue() {
    /* CEP runs in a browser context, so the timer globals are ambient there.
     * The vm sandbox has to be given them explicitly. */
    var sandbox = {
        require: require, console: console, Date: Date, Math: Math,
        setInterval: setInterval, clearInterval: clearInterval,
        setTimeout: setTimeout, clearTimeout: clearTimeout
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    var file = path.join(__dirname, "..", "extension", "com.pard.defender",
        "client", "copy-queue.js");
    vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: "copy-queue.js" });
    return sandbox.PardCopyQueue;
}

var queue = loadQueue();
var root = path.join(os.tmpdir(), "parddefender-test-" + Date.now())
    .replace(/\\/g, "/");
var src = root + "/source";
var dest = root + "/workspace/01_assets/Intro/VIDEO";

fs.mkdirSync(src, { recursive: true });

function writeSource(name, content) {
    var target = src + "/" + name;
    fs.writeFileSync(target.replace(/\//g, path.sep), content);
    return target;
}

function native(target) { return String(target).replace(/\//g, path.sep); }

function readFile(target) {
    try { return fs.readFileSync(target.replace(/\//g, path.sep), "utf8"); }
    catch (e) { return null; }
}

function listDir(dir) {
    try { return fs.readdirSync(dir.replace(/\//g, path.sep)).sort(); }
    catch (e) { return []; }
}

function run(tasks, options, done) {
    queue.run(tasks, options || {}, {}, done);
}

/* ------------------------------------------------------------------ tests */

var steps = [];

steps.push(function (next) {
    group("Обычное копирование");
    var source = writeSource("clip.mp4", "AAAABBBBCCCC");
    run([{ id: "1", sourcePath: source, destPath: dest + "/clip.mp4", size: 12 }],
        null, function (results) {
            check("копия сделана", results[0].ok, true);
            check("байты совпали", readFile(dest + "/clip.mp4"), "AAAABBBBCCCC");
            check("оригинал на месте", readFile(source), "AAAABBBBCCCC");
            check("временных файлов не осталось",
                listDir(dest).filter(function (n) { return /\.pdpart$/.test(n); }), []);
            next();
        });
});

steps.push(function (next) {
    group("Повторный импорт того же файла");
    var source = src + "/clip.mp4";
    run([{ id: "2", sourcePath: source, destPath: dest + "/clip.mp4", size: 12 }],
        null, function (results) {
            check("задача успешна", results[0].ok, true);
            check("дубликат не создан", listDir(dest), ["clip.mp4"]);
            check("relink указывает на существующий файл",
                results[0].destPath === undefined || results[0].destPath === "" ||
                /clip\.mp4$/.test(results[0].destPath || ""), true);
            next();
        });
});

steps.push(function (next) {
    group("Разные файлы с одинаковым именем");
    /* Тот же размер, другое содержимое: имя должно развестись, а не перезаписаться. */
    var other = writeSource("other.mp4", "ZZZZYYYYXXXX");
    run([{ id: "3", sourcePath: other, destPath: dest + "/clip.mp4", size: 12 }],
        null, function (results) {
            check("задача успешна", results[0].ok, true);
            check("оба файла существуют", listDir(dest), ["clip (2).mp4", "clip.mp4"]);
            check("первый не перезаписан", readFile(dest + "/clip.mp4"), "AAAABBBBCCCC");
            check("второй записан отдельно",
                readFile(dest + "/clip (2).mp4"), "ZZZZYYYYXXXX");
            next();
        });
});

steps.push(function (next) {
    group("Пропавший исходник");
    run([{
        id: "4",
        sourcePath: src + "/does-not-exist.mp4",
        destPath: dest + "/ghost.mp4",
        size: 10
    }], null, function (results) {
        check("задача провалена", results[0].ok, false);
        check("ничего не создано", readFile(dest + "/ghost.mp4"), null);
        next();
    });
});

steps.push(function (next) {
    group("Нехватка места");
    var source = writeSource("huge.mp4", "0123456789");
    run([{ id: "5", sourcePath: source, destPath: dest + "/huge.mp4", size: 1000 }],
        { freeBytes: 1200, reserveBytes: 500 },
        function (results) {
            check("копирование не начато", results[0].ok, false);
            check("файл не создан", readFile(dest + "/huge.mp4"), null);
            next();
        });
});

steps.push(function (next) {
    group("Секвенции");
    var frameDir = src + "/frames";
    fs.mkdirSync(frameDir.replace(/\//g, path.sep), { recursive: true });
    ["shot_a_00001.png", "shot_a_00002.png", "shot_a_00003.png",
        "shot_a_00002.jpg", "other_00001.png"].forEach(function (name) {
        fs.writeFileSync((frameDir + "/" + name).replace(/\//g, path.sep), name);
    });

    var expanded = queue.expandSequence({
        folder: frameDir, prefix: "shot_a_", padding: 5, suffix: ".png"
    });
    check("найдены только кадры своего шаблона",
        expanded.map(function (p) { return p.replace(/^.*\//, ""); }),
        ["shot_a_00001.png", "shot_a_00002.png", "shot_a_00003.png"]);

    var seqDest = root + "/workspace/01_assets/Intro/SEQUENCES/shot_a";
    run([{
        id: "6",
        sourcePath: frameDir + "/shot_a_00001.png",
        destPath: seqDest,
        isSequence: true,
        sequence: { folder: frameDir, prefix: "shot_a_", padding: 5, suffix: ".png" },
        size: 60
    }], null, function (results) {
        check("секвенция скопирована", results[0].ok, true);
        check("скопированы все кадры", results[0].files, 3);
        check("в папке ровно три кадра", listDir(seqDest),
            ["shot_a_00001.png", "shot_a_00002.png", "shot_a_00003.png"]);
        check("relink указывает на первый кадр",
            /shot_a_00001\.png$/.test(results[0].destPath), true);
        next();
    });
});

steps.push(function (next) {
    group("Файл на месте папки");
    /*
     * Регресс на живой баг 2026-08-29. 1.0.0 оставила медиафайл с именем
     * "VIDEO" без расширения ровно там, где 1.0.1 нужна папка VIDEO. mkdir бросал
     * EEXIST, запасной путь его глотал, а проверка "путь существует" была довольна —
     * файл тоже существует. Копия падала с ENOENT, и это трактовалось как
     * "исходник не найден" — про файл, который прекрасно читался.
     */
    var blockedDir = root + "/workspace/01_assets/Blocked/VIDEO";
    fs.mkdirSync(native(root + "/workspace/01_assets/Blocked"), { recursive: true });
    fs.writeFileSync(native(blockedDir), "я файл, а не папка");

    var probe = queue.ensureDir(blockedDir);
    check("ensureDir не считает файл папкой", probe.ok, false);
    check("код называет причину", probe.code, "DEST_BLOCKED");
    check("сказано, что именно мешает", probe.blockedBy, blockedDir);

    var source = writeSource("blocked.mp4", "0123456789");
    run([{ id: "10", sourcePath: source, destPath: blockedDir + "/blocked.mp4", size: 10 }],
        null, function (results) {
            check("копирование отказано", results[0].ok, false);
            check("это не проблема исходника",
                results[0].code !== "SOURCE_MISSING", true);
            check("код — заблокированное назначение", results[0].code, "DEST_BLOCKED");
            check("блокирующий файл не тронут",
                readFile(blockedDir), "я файл, а не папка");
            check("оригинал не тронут", readFile(source), "0123456789");
            next();
        });
});

steps.push(function (next) {
    group("Сторона ошибки");
    /* Один и тот же errno означает разное на чтении и на записи. */
    check("ENOENT при чтении — нет исходника",
        queue.codeForError({ code: "ENOENT" }, "COPY_FAILED", "source"), "SOURCE_MISSING");
    check("ENOENT при записи — проблема назначения",
        queue.codeForError({ code: "ENOENT" }, "COPY_FAILED", "dest"), "DEST_UNWRITABLE");
    check("без указания стороны — прежнее поведение",
        queue.codeForError({ code: "ENOENT" }, "COPY_FAILED"), "SOURCE_MISSING");
    check("нет места — системная",
        queue.codeForError({ code: "ENOSPC" }, "COPY_FAILED", "dest"), "DISK_FULL");
    next();
});

steps.push(function (next) {
    group("Восстановление после сбоя");
    var stray = dest + "/interrupted.mp4.abc123.pdpart";
    fs.writeFileSync(stray.replace(/\//g, path.sep), "half written");

    var journal = root + "/workspace/.parddefender/pending.tsv";
    queue.writeText(journal, [
        new Date().toISOString(), "9", src + "/clip.mp4", dest + "/interrupted.mp4"
    ].join("\t") + "\n");

    var summary = queue.recoverJournal(journal);
    check("незавершённая копия убрана", summary.removedPartials, 1);
    check("файла больше нет", readFile(stray), null);
    check("готовые файлы не тронуты", readFile(dest + "/clip.mp4"), "AAAABBBBCCCC");
    check("журнал удалён", queue.readText(journal), null);
    next();
});

/* ------------------------------------------------------------------- run */

function step(index) {
    if (index >= steps.length) {
        try { fs.rmSync(root.replace(/\//g, path.sep), { recursive: true, force: true }); }
        catch (e) {}
        console.log("\n" + (failed === 0
            ? "Все проверки пройдены: " + passed
            : "Пройдено " + passed + ", провалено " + failed));
        process.exit(failed === 0 ? 0 : 1);
        return;
    }
    steps[index](function () { step(index + 1); });
}

step(0);
