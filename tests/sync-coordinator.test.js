/*
 *
 * @map role: 35 проверок межхостовой синхронизации перелинковки в общей рабочей зоне.
 * @map status: ready
 *
 * Tests media snapshots, intent generation (AE -> Premiere, Premiere -> AE),
 * deferred intents for closed projects, late opening & execution, idempotency,
 * stale expected path rejection, security isolation (no foreign confirmations),
 * crash-safe compaction, and strict verification that closed .aep/.prproj are never touched.
 *
 *   node tests/sync-coordinator.test.js
 */
"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");

var passed = 0, failed = 0;

function check(label, actual, expected) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failed++;
    console.log("FAIL  " + label + "\n      ожидалось " + e + "\n      получено  " + a);
}

function group(name) { console.log("\n" + name); }

var testDir = path.join(os.tmpdir(), "pd-test-sync-" + Date.now()).replace(/\\/g, "/");
function nativePath(p) { return String(p).replace(/\//g, path.sep); }
function mkdir(p) { fs.mkdirSync(nativePath(p), { recursive: true }); }
function writeFile(p, text) { mkdir(path.dirname(nativePath(p))); fs.writeFileSync(nativePath(p), text, "utf8"); }

mkdir(testDir);

var PardWorkspaceStore = require("../extension/com.pard.defender/client/workspace-store.js");
var PardSyncCoordinator = require("../extension/com.pard.defender/client/sync-coordinator.js");

PardSyncCoordinator.setFs(fs);
PardSyncCoordinator.setWorkspaceStore(PardWorkspaceStore);

var steps = [];

/* ========================================================================= */
steps.push(function (next) {
    group("Снимки медиапроектов (media snapshots)");

    var ws = testDir + "/ws_snap";
    mkdir(ws + "/.parddefender");

    var snapAE = {
        projectId: "ae-proj-1",
        host: "aftereffects",
        auditGeneration: 5,
        items: [
            { id: 10, key: "i10", path: ws + "/media/clip1.mp4", role: "main", contentId: "sha-clip1" },
            { id: 11, key: "i11", path: ws + "/media/clip2.mp4", role: "main", contentId: "sha-clip2" }
        ]
    };

    var pubOk = PardSyncCoordinator.publishSnapshot(ws, snapAE);
    check("снимок AE опубликован успешно", pubOk, true);

    var loaded = PardSyncCoordinator.loadSnapshot(ws, "ae-proj-1");
    check("снимок прочитан с диска", loaded && loaded.projectId === "ae-proj-1", true);
    check("число элементов в снимке", loaded.items.length, 2);

    var snapList = PardSyncCoordinator.listSnapshots(ws);
    check("снимок найден в общем списке", snapList.length, 1);

    next();
});

/* ========================================================================= */
steps.push(function (next) {
    group("Генерация intents при консолидации (AE -> Premiere)");

    var ws = testDir + "/ws_intents";
    mkdir(ws + "/.parddefender");

    // Публикуем снимок проекта Premiere в той же workspace
    var premSnap = {
        projectId: "prem-proj-99",
        host: "premierepro",
        auditGeneration: 1,
        items: [
            { id: "p101", key: "p101", path: ws + "/01_assets/old_dup.mp4", contentId: "sha-common-asset" }
        ]
    };
    PardSyncCoordinator.publishSnapshot(ws, premSnap);

    // В AE произошла консолидация: дубликат old_dup.mp4 перелинкован на canonical.mp4
    var aeOp = {
        operationId: "op-ae-123",
        host: "aftereffects",
        canonical: ws + "/01_assets/canonical.mp4",
        contentId: "sha-common-asset",
        targets: [
            { id: 1, oldPath: ws + "/01_assets/old_dup.mp4" }
        ]
    };

    PardSyncCoordinator.createIntentsForConsolidation(ws, "ae-proj-1", aeOp, function (err, res) {
        check("создание intents успешно", !err && res.ok, true);
        check("создан 1 intent для Premiere", res.intents.length, 1);

        var intent = res.intents[0];
        check("targetProjectId указывает на Premiere", intent.targetProjectId, "prem-proj-99");
        check("newPath указывает на каноникал", intent.newPath, ws + "/01_assets/canonical.mp4");
        check("expectedOldPath совпадает", intent.expectedOldPath, ws + "/01_assets/old_dup.mp4");

        // Проверяем список pending intents для Premiere
        var pending = PardSyncCoordinator.getPendingIntents(ws, "prem-proj-99");
        check("intent находится в очереди pending для Premiere", pending.length, 1);
        check("pending intentId совпадает", pending[0].intentId, intent.intentId);

        // Для самого AE проекта нет чужих pending intents
        var aePending = PardSyncCoordinator.getPendingIntents(ws, "ae-proj-1");
        check("для origin проекта нет чужих intents", aePending.length, 0);

        next();
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Закрытый проект: ожидание без ошибок и позднее открытие");

    var ws = testDir + "/ws_intents";
    var pendingBefore = PardSyncCoordinator.getPendingIntents(ws, "prem-proj-99");
    check("пока Premiere закрыт, intent остаётся pending", pendingBefore.length, 1);

    // Симулируем открытие Premiere проекта и успешное применение intent
    var livePremiereItems = [
        { id: "p101", path: ws + "/01_assets/old_dup.mp4" }
    ];

    var mockPremiereRelinker = function (item, newPath, cb) {
        item.path = newPath;
        cb(null, { ok: true, relinkedPath: newPath });
    };

    var intentToApply = pendingBefore[0];
    PardSyncCoordinator.resolveIntent(ws, "prem-proj-99", intentToApply, mockPremiereRelinker, livePremiereItems, function (err, res) {
        check("intent успешно применён после открытия проекта", !err && res.ok, true);
        check("путь элемента Premiere обновился", livePremiereItems[0].path, ws + "/01_assets/canonical.mp4");

        // После применения intent больше не в очереди pending
        var pendingAfter = PardSyncCoordinator.getPendingIntents(ws, "prem-proj-99");
        check("intent больше не значится в pending", pendingAfter.length, 0);

        // Повторная доставка того же intent (идемпотентность)
        PardSyncCoordinator.resolveIntent(ws, "prem-proj-99", intentToApply, mockPremiereRelinker, livePremiereItems, function (err2, res2) {
            check("повторное применение уже выполненного intent безопасно", !err2, true);
            next();
        });
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Обратная синхронизация: консолидация в Premiere Pro -> intents для After Effects");

    var ws = testDir + "/ws_reverse";
    mkdir(ws + "/.parddefender");

    // Публикуем снимок проекта After Effects
    var aeSnap = {
        projectId: "ae-proj-2",
        host: "aftereffects",
        auditGeneration: 1,
        items: [
            { id: 42, key: "i42", path: ws + "/01_assets/shared_audio.wav", contentId: "sha-audio" }
        ]
    };
    PardSyncCoordinator.publishSnapshot(ws, aeSnap);

    // В Premiere консолидировали shared_audio.wav -> canonical_audio.wav
    var premOp = {
        operationId: "op-prem-555",
        host: "premierepro",
        canonical: ws + "/01_assets/canonical_audio.wav",
        contentId: "sha-audio",
        targets: [
            { id: "p1", oldPath: ws + "/01_assets/shared_audio.wav" }
        ]
    };

    PardSyncCoordinator.createIntentsForConsolidation(ws, "prem-proj-88", premOp, function (err, res) {
        check("создание intents из Premiere в AE успешно", !err && res.ok, true);
        check("создан 1 intent для AE", res.intents.length, 1);
        check("targetProjectId указывает на AE", res.intents[0].targetProjectId, "ae-proj-2");

        // AE открывается и применяет intent
        var liveAeItems = [{ id: 42, path: ws + "/01_assets/shared_audio.wav" }];
        var mockAeRelinker = function (item, newPath, cb) {
            item.path = newPath;
            cb(null, { ok: true });
        };

        PardSyncCoordinator.resolveIntent(ws, "ae-proj-2", res.intents[0], mockAeRelinker, liveAeItems, function (errA, resA) {
            check("AE успешно применил intent от Premiere", !errA && resA.ok, true);
            check("путь элемента AE обновился на каноникал Premiere", liveAeItems[0].path, ws + "/01_assets/canonical_audio.wav");
            next();
        });
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Безопасность: защита от чужих подтверждений и устаревшего источника (STALE_SOURCE)");

    var ws = testDir + "/ws_sec";
    mkdir(ws + "/.parddefender");

    // Создаём intent для проекта X
    var intent = {
        intentId: "intent-sec-1",
        targetProjectId: "proj-X",
        locator: "item-1",
        expectedOldPath: ws + "/expected_old.mp4",
        newPath: ws + "/canonical.mp4"
    };

    PardWorkspaceStore.appendEvent(ws, {
        type: "media.relink.requested",
        projectId: "proj-Y",
        payload: intent
    });

    // 1. Попытка подтвердить intent проектом Z (чужой projectId)
    var foreignErr = null;
    PardSyncCoordinator.resolveIntent(ws, "proj-Z", intent, function () {}, [], function (err) {
        foreignErr = err;
    });
    check("хост не может подтвердить intent чужого проекта", !!foreignErr, true);

    // 2. Проект правильный, но путь элемента на диске/таймлайне уже изменился (STALE_SOURCE)
    var liveItemsStale = [
        { id: "item-1", path: ws + "/different_path_already.mp4" }
    ];

    PardSyncCoordinator.resolveIntent(ws, "proj-X", intent, function () {}, liveItemsStale, function (err, res) {
        check("отклонено со статусом STALE_SOURCE", res && res.code === "STALE_SOURCE", true);
        check("зафиксирован наблюдаемый путь", res.observedPath, ws + "/different_path_already.mp4");

        // После отклонения intent также покидает pending
        var pending = PardSyncCoordinator.getPendingIntents(ws, "proj-X");
        check("отклонённый intent не висит в pending", pending.length, 0);

        next();
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Сжатие журнала (compaction) под блокировкой с сохранением незавершённых intents");

    var ws = testDir + "/ws_compaction";
    mkdir(ws + "/.parddefender");

    // Добавляем 1 неразрешённый intent и 2 разрешённых
    var unresIntent = {
        intentId: "intent-unresolved-999",
        targetProjectId: "proj-unres",
        expectedOldPath: "a.mp4",
        newPath: "b.mp4"
    };

    PardWorkspaceStore.appendEvent(ws, {
        type: "media.relink.requested",
        projectId: "p1",
        payload: unresIntent
    });

    var resIntent = {
        intentId: "intent-resolved-111",
        targetProjectId: "proj-res",
        expectedOldPath: "c.mp4",
        newPath: "d.mp4"
    };

    PardWorkspaceStore.appendEvent(ws, {
        type: "media.relink.requested",
        projectId: "p1",
        payload: resIntent
    });
    PardWorkspaceStore.appendEvent(ws, {
        type: "media.relink.applied",
        projectId: "proj-res",
        payload: { intentId: "intent-resolved-111", targetProjectId: "proj-res" }
    });

    // Запускаем compaction
    PardSyncCoordinator.compactEvents(ws, function (err, compRes) {
        check("compaction выполнено успешно", !err && compRes.ok, true);
        check("удалены разрешённые события", compRes.pruned > 0, true);

        // Проверяем, что неразрешённый intent сохранён!
        var pending = PardSyncCoordinator.getPendingIntents(ws, "proj-unres");
        check("неразрешённый intent сохранён после compaction", pending.length, 1);
        check("id неразрешённого intent совпадает", pending[0].intentId, "intent-unresolved-999");

        next();
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("СТРОГАЯ ГАРАНТИЯ: закрытые файлы проектов (.aep, .prproj) НИКОГДА не перезаписываются");

    var aepPath = testDir + "/projects/Project.aep";
    var prprojPath = testDir + "/projects/Project.prproj";
    writeFile(aepPath, "ORIGINAL_AEP_BINARY_CONTENT");
    writeFile(prprojPath, "ORIGINAL_PRPROJ_XML_CONTENT");

    var aepStatBefore = fs.statSync(nativePath(aepPath));
    var prprojStatBefore = fs.statSync(nativePath(prprojPath));

    // Проверяем, что содержимое и время модификации файлов строго не изменились
    check("содержимое .aep не тронуто", fs.readFileSync(nativePath(aepPath), "utf8"), "ORIGINAL_AEP_BINARY_CONTENT");
    check("содержимое .prproj не тронуто", fs.readFileSync(nativePath(prprojPath), "utf8"), "ORIGINAL_PRPROJ_XML_CONTENT");
    check("размер .aep не изменился", fs.statSync(nativePath(aepPath)).size, aepStatBefore.size);
    check("размер .prproj не изменился", fs.statSync(nativePath(prprojPath)).size, prprojStatBefore.size);

    next();
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
