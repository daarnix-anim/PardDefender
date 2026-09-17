/*
 *
 * @map role: 25 проверок безопасного объединения дубликатов в After Effects.
 * @map status: ready
 *
 * Tests state machine, persistence, pre-verification, rehash mismatch abort,
 * external canonical copy, manifest provenance failure abort, host relinking,
 * crash recovery, idempotency and safety guarantees (no deletions).
 *
 *   node tests/consolidation.test.js
 */
"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");
var vm = require("vm");
var crypto = require("crypto");

var passed = 0, failed = 0;

function check(label, actual, expected) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failed++;
    console.log("FAIL  " + label + "\n      ожидалось " + e + "\n      получено  " + a);
}

function group(name) { console.log("\n" + name); }

var clientDir = path.join(__dirname, "..", "extension", "com.pard.defender", "client");

function loadModule(fileName, sandbox) {
    var fullPath = path.join(clientDir, fileName);
    var code = fs.readFileSync(fullPath, "utf8");
    vm.runInContext(code, sandbox, { filename: fileName });
}

function createSandbox() {
    var sandbox = {
        require: require, console: console, Date: Date, Math: Math, JSON: JSON,
        String: String, Number: Number, Array: Array, Object: Object,
        RegExp: RegExp, Error: Error, process: process,
        setInterval: setInterval, clearInterval: clearInterval,
        setTimeout: setTimeout, clearTimeout: clearTimeout
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);

    loadModule("copy-queue.js", sandbox);
    loadModule("workspace-store.js", sandbox);
    loadModule("duplicate-index.js", sandbox);
    loadModule("consolidation.js", sandbox);

    return sandbox;
}

var ctx = createSandbox();
var PardConsolidation = ctx.PardConsolidation;
var PardDuplicateIndex = ctx.PardDuplicateIndex;
var PardCopyQueue = ctx.PardCopyQueue;
var PardWorkspaceStore = ctx.PardWorkspaceStore;

var testRoot = path.join(os.tmpdir(), "pd-test-consolidation-" + Date.now()).replace(/\\/g, "/");
function nativePath(p) { return String(p).replace(/\//g, path.sep); }
function mkdir(p) { fs.mkdirSync(nativePath(p), { recursive: true }); }
function writeFile(p, text) { mkdir(path.dirname(nativePath(p))); fs.writeFileSync(nativePath(p), text, "utf8"); }

mkdir(testRoot);

var steps = [];

/* ========================================================================= */
steps.push(function (next) {
    group("Хранилище операций: атомарное сохранение и чтение");
    var ws = testRoot + "/ws1";
    mkdir(ws + "/.parddefender");

    var op = PardConsolidation.createOperation({
        workspace: ws,
        projectId: "proj1",
        group: {
            contentId: "sha256:abc",
            kind: "file",
            size: 100,
            recommendedCanonical: ws + "/01_assets/A.mp4",
            files: [
                { path: ws + "/01_assets/A.mp4", references: [1] },
                { path: ws + "/01_assets/B.mp4", references: [2] }
            ]
        },
        auditItems: [
            { id: 1, key: "i1", path: ws + "/01_assets/A.mp4" },
            { id: 2, key: "i2", path: ws + "/01_assets/B.mp4" }
        ]
    });

    check("созданная операция имеет state=planned", op.state, "planned");
    check("создано 2 цели", op.targets.length, 2);
    check("каноникал уже помечен relinked", op.targets[0].status, "relinked");
    check("дубликат помечен pending", op.targets[1].status, "pending");

    var loaded = PardConsolidation.loadOperation(ws, op.operationId);
    check("операция успешно прочитана с диска", loaded && loaded.operationId === op.operationId, true);

    var list = PardConsolidation.listOperations(ws);
    check("операция есть в списке", list.length, 1);

    var recoverable = PardConsolidation.findRecoverableOperation(ws, "proj1");
    check("операция planned определяется как recoverable", recoverable && recoverable.operationId === op.operationId, true);
    next();
});

/* ========================================================================= */
steps.push(function (next) {
    group("Предварительная проверка (reverify)");
    var ws = testRoot + "/ws_reverify";
    mkdir(ws + "/01_assets");
    var canFile = ws + "/01_assets/canonical.mp4";
    var dupFile = ws + "/01_assets/duplicate.mp4";
    writeFile(canFile, "SAME_CONTENT_FOR_REVERIFY");
    writeFile(dupFile, "SAME_CONTENT_FOR_REVERIFY");

    var contentId = crypto.createHash("sha256").update("SAME_CONTENT_FOR_REVERIFY").digest("hex");
    var stat = fs.statSync(nativePath(canFile));

    var audit = [
        { id: 10, key: "i10", path: canFile, missing: false },
        { id: 20, key: "i20", path: dupFile, missing: false }
    ];

    var op = PardConsolidation.createOperation({
        workspace: ws,
        projectId: "proj_rev",
        group: {
            contentId: contentId,
            kind: "file",
            size: stat.size,
            recommendedCanonical: canFile,
            files: [
                { path: canFile, references: [10] },
                { path: dupFile, references: [20] }
            ]
        },
        auditItems: audit
    });

    // 1. Успешный reverify
    PardConsolidation.reverify(ws, op, audit, function (err, res) {
        check("reverify успешен при совпадении путей и хэша", !err && res === true, true);

        // 2. Ошибка: элемент пропал из проекта
        var badAuditMissing = [
            { id: 10, key: "i10", path: canFile, missing: false }
        ];
        PardConsolidation.reverify(ws, op, badAuditMissing, function (errMissing) {
            check("reverify падает если элемент проекта исчез", !!errMissing, true);

            // 3. Ошибка: путь элемента в проекте изменился
            var badAuditPath = [
                { id: 10, key: "i10", path: canFile, missing: false },
                { id: 20, key: "i20", path: ws + "/other.mp4", missing: false }
            ];
            PardConsolidation.reverify(ws, op, badAuditPath, function (errPath) {
                check("reverify падает если путь элемента изменился", !!errPath, true);

                // 4. Ошибка: REHASH_MISMATCH если хэш не совпал
                var opMismatch = PardConsolidation.createOperation({
                    workspace: ws,
                    projectId: "proj_rev",
                    group: {
                        contentId: "fake_old_hash_12345",
                        kind: "file",
                        size: stat.size,
                        recommendedCanonical: canFile,
                        files: [
                            { path: canFile, references: [10] },
                            { path: dupFile, references: [20] }
                        ]
                    },
                    auditItems: audit
                });
                PardConsolidation.reverify(ws, opMismatch, audit, function (errHash) {
                    check("reverify падает с REHASH_MISMATCH при изменении хэша",
                        errHash && errHash.message.indexOf("REHASH_MISMATCH") !== -1, true);

                    // 5. Ошибка: Proxy и Original не могут смешиваться
                    var opProxyMix = PardConsolidation.createOperation({
                        workspace: ws,
                        projectId: "proj_rev",
                        group: {
                            contentId: contentId,
                            kind: "proxy",
                            size: stat.size,
                            recommendedCanonical: canFile,
                            files: [{ path: canFile, references: [10] }]
                        },
                        auditItems: audit
                    });
                    opProxyMix.targets[0].isProxy = false;
                    PardConsolidation.reverify(ws, opProxyMix, audit, function (errMix) {
                        check("reverify запрещает смешивать proxy и original", !!errMix, true);
                        next();
                    });
                });
            });
        });
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Внешний canonical: безопасное копирование и запись в манифест");
    var ws = testRoot + "/ws_external";
    mkdir(ws + "/.parddefender");
    var extDir = testRoot + "/external_source";
    mkdir(extDir);
    var extFile = extDir + "/footage_ext.mp4";
    writeFile(extFile, "EXTERNAL_FOOTAGE_BYTES");

    var stat = fs.statSync(nativePath(extFile));
    var contentId = crypto.createHash("sha256").update("EXTERNAL_FOOTAGE_BYTES").digest("hex");

    var op = PardConsolidation.createOperation({
        workspace: ws,
        projectId: "proj_ext",
        group: {
            contentId: contentId,
            kind: "file",
            size: stat.size,
            recommendedCanonical: extFile,
            files: [
                { path: extFile, references: [100] }
            ]
        },
        auditItems: [{ id: 100, key: "i100", path: extFile }]
    });

    PardConsolidation.ensureCanonicalReady(ws, op, {}, function (err, readyPath) {
        check("копирование внешнего canonical успешно", !err, true);
        check("файл скопирован в рабочую папку 01_assets/_SHARED/VIDEO",
            readyPath && PardConsolidation.normalizePath(readyPath).indexOf(PardConsolidation.normalizePath(ws) + "/01_assets/_SHARED/VIDEO/footage_ext.mp4") !== -1, true);
        check("скопированный файл реально существует на диске", fs.existsSync(nativePath(readyPath)), true);

        // Проверка записи в assets.tsv
        var assetsTsv = fs.readFileSync(nativePath(ws + "/.parddefender/assets.tsv"), "utf8");
        check("provenance записан в assets.tsv", assetsTsv.indexOf("footage_ext.mp4") !== -1, true);
        next();
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Сбой манифеста: блокировка relink при невозможности записать provenance");
    var ws = testRoot + "/ws_manifest_fail";
    mkdir(ws + "/.parddefender");
    var extDir = testRoot + "/ext_fail";
    mkdir(extDir);
    var extFile = extDir + "/footage_manifest_fail.mp4";
    writeFile(extFile, "BYTES_FOR_MANIFEST_FAIL");

    var stat = fs.statSync(nativePath(extFile));
    var contentId = crypto.createHash("sha256").update("BYTES_FOR_MANIFEST_FAIL").digest("hex");

    var op = PardConsolidation.createOperation({
        workspace: ws,
        projectId: "proj_mf",
        group: {
            contentId: contentId,
            kind: "file",
            size: stat.size,
            recommendedCanonical: extFile,
            files: [{ path: extFile, references: [200] }]
        },
        auditItems: [{ id: 200, key: "i200", path: extFile }]
    });

    var origAppend = PardCopyQueue.appendText;
    PardCopyQueue.appendText = function () { return false; };

    PardConsolidation.ensureCanonicalReady(ws, op, {}, function (readyErr) {
        PardCopyQueue.appendText = origAppend;
        check("ошибка MANIFEST_FAILED если assets.tsv недоступен",
            readyErr && readyErr.message.indexOf("MANIFEST_FAILED") !== -1, true);
        next();
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Полный цикл машины состояний и хост-перелинковка (happy path)");
    var ws = testRoot + "/ws_happy";
    mkdir(ws + "/01_assets");
    mkdir(ws + "/.parddefender");
    var canFile = ws + "/01_assets/shot_main.mp4";
    var dupFile1 = ws + "/01_assets/shot_copy1.mp4";
    var dupFile2 = ws + "/01_assets/shot_copy2.mp4";
    writeFile(canFile, "HAPPY_PATH_FOOTAGE");
    writeFile(dupFile1, "HAPPY_PATH_FOOTAGE");
    writeFile(dupFile2, "HAPPY_PATH_FOOTAGE");

    var stat = fs.statSync(nativePath(canFile));
    var contentId = crypto.createHash("sha256").update("HAPPY_PATH_FOOTAGE").digest("hex");

    var audit = [
        { id: 1, key: "i1", path: canFile },
        { id: 2, key: "i2", path: dupFile1 },
        { id: 3, key: "i3", path: dupFile2 }
    ];

    var groupData = {
        groupId: "grp_happy",
        contentId: contentId,
        kind: "file",
        size: stat.size,
        recommendedCanonical: canFile,
        files: [
            { path: canFile, references: [1] },
            { path: dupFile1, references: [2] },
            { path: dupFile2, references: [3] }
        ]
    };

    var mockHostAdapter = {
        commitFromFileJson: function (planPath, cb) {
            var body = fs.readFileSync(nativePath(planPath), "utf8");
            var plan = JSON.parse(body);
            check("хост получил план с 2 не-каноническими элементами", plan.items.length, 2);
            check("хост получил destPath=canonical", plan.items[0].destPath, canFile);
            cb(JSON.stringify({
                ok: true,
                relinked: 2,
                skipped: 0,
                failures: []
            }));
        }
    };

    PardConsolidation.run({
        workspace: ws,
        projectId: "proj_happy",
        group: groupData,
        canonical: canFile,
        auditItems: audit,
        hostAdapter: mockHostAdapter
    }, function (err, runRes) {
        check("операция завершилась успешно", runRes && runRes.ok, true);
        check("состояние операции: completed", runRes.op.state, "completed");
        check("все 3 элемента отмечены relinked (1 каноникал + 2 цели)", runRes.op.results.relinked, 3);
        check("событие записано в журнал операций", !!runRes.op.eventId, true);

        // Проверка сохранённого состояния на диске
        var savedOp = PardConsolidation.loadOperation(ws, runRes.op.operationId);
        check("на диске сохранено состояние completed", savedOp && savedOp.state, "completed");

        // Повторный запуск завершённой операции идемпотентен
        PardConsolidation.run({
            workspace: ws,
            operationId: runRes.op.operationId
        }, function (err2, idemRes) {
            check("повторный запуск завершённой операции идемпотентен", idemRes && idemRes.idempotent, true);

            // БЕЗОПАСНОСТЬ: оригинальные файлы не удалены!
            check("каноникал на месте", fs.existsSync(nativePath(canFile)), true);
            check("дубликат 1 на месте (не удалён)", fs.existsSync(nativePath(dupFile1)), true);
            check("дубликат 2 на месте (не удалён)", fs.existsSync(nativePath(dupFile2)), true);
            next();
        });
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Частичный сбой: пропуск изменившегося файла (RELINK_SOURCE_CHANGED)");
    var ws = testRoot + "/ws_partial";
    mkdir(ws + "/01_assets");
    mkdir(ws + "/.parddefender");
    var canFile = ws + "/01_assets/asset_can.mp4";
    var dupFile1 = ws + "/01_assets/asset_dup1.mp4";
    var dupFile2 = ws + "/01_assets/asset_dup2.mp4";
    writeFile(canFile, "PARTIAL_PATH_CONTENT");
    writeFile(dupFile1, "PARTIAL_PATH_CONTENT");
    writeFile(dupFile2, "PARTIAL_PATH_CONTENT");

    var stat = fs.statSync(nativePath(canFile));
    var contentId = crypto.createHash("sha256").update("PARTIAL_PATH_CONTENT").digest("hex");

    var audit = [
        { id: 10, key: "i10", path: canFile },
        { id: 20, key: "i20", path: dupFile1 },
        { id: 30, key: "i30", path: dupFile2 }
    ];

    var mockHostAdapter = {
        commitFromFileJson: function (planPath, cb) {
            cb(JSON.stringify({
                ok: true,
                relinked: 1,
                skipped: 1,
                failures: [
                    { id: 30, code: "RELINK_SOURCE_CHANGED", reason: "Источник изменился до перелинковки" }
                ]
            }));
        }
    };

    PardConsolidation.run({
        workspace: ws,
        projectId: "proj_partial",
        group: {
            groupId: "grp_partial",
            contentId: contentId,
            kind: "file",
            size: stat.size,
            recommendedCanonical: canFile,
            files: [
                { path: canFile, references: [10] },
                { path: dupFile1, references: [20] },
                { path: dupFile2, references: [30] }
            ]
        },
        canonical: canFile,
        auditItems: audit,
        hostAdapter: mockHostAdapter
    }, function (err, runRes) {
        check("операция завершилась со статусом partial", runRes && runRes.partial, true);
        check("состояние операции: partial", runRes.op.state, "partial");
        check("relinked: 2 (каноникал + 1 успешная цель)", runRes.op.results.relinked, 2);
        check("skipped: 1", runRes.op.results.skipped, 1);
        check("элемент 30 помечен skipped", runRes.op.targets[2].status, "skipped");
        next();
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Восстановление после сбоя (crash recovery)");
    var ws = testRoot + "/ws_crash";
    mkdir(ws + "/01_assets");
    mkdir(ws + "/.parddefender");
    var canFile = ws + "/01_assets/rec_can.mp4";
    var dupFile = ws + "/01_assets/rec_dup.mp4";
    writeFile(canFile, "CRASH_RECOVERY_CONTENT");
    writeFile(dupFile, "CRASH_RECOVERY_CONTENT");

    var stat = fs.statSync(nativePath(canFile));
    var contentId = crypto.createHash("sha256").update("CRASH_RECOVERY_CONTENT").digest("hex");

    var audit = [
        { id: 101, key: "i101", path: canFile },
        { id: 202, key: "i202", path: dupFile }
    ];

    var op = PardConsolidation.createOperation({
        workspace: ws,
        projectId: "proj_crash",
        group: {
            groupId: "grp_crash",
            contentId: contentId,
            kind: "file",
            size: stat.size,
            recommendedCanonical: canFile,
            files: [
                { path: canFile, references: [101] },
                { path: dupFile, references: [202] }
            ]
        },
        auditItems: audit
    });
    op.state = "canonical_ready";
    PardConsolidation.saveOperation(ws, op);

    var recOp = PardConsolidation.findRecoverableOperation(ws, "proj_crash");
    check("findRecoverableOperation находит упавшую операцию",
        recOp && recOp.operationId === op.operationId, true);

    var mockHostAdapter = {
        commitFromFileJson: function (planPath, cb) {
            cb(JSON.stringify({ ok: true, relinked: 1, skipped: 0, failures: [] }));
        }
    };

    PardConsolidation.run({
        workspace: ws,
        projectId: "proj_crash",
        operation: recOp,
        auditItems: audit,
        hostAdapter: mockHostAdapter
    }, function (err, resumeRes) {
        check("возобновлённая операция завершилась успешно", resumeRes && resumeRes.ok, true);
        check("состояние переведено в completed", resumeRes.op.state, "completed");

        var recAfter = PardConsolidation.findRecoverableOperation(ws, "proj_crash");
        check("после завершения нет незавершённых операций", recAfter, null);
        next();
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
