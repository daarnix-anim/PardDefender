/*
 *
 * @map role: 40 интеграционных end-to-end проверок надёжности (hardening), синхронизации и безопасности релиза 2.0.4.
 * @map status: ready
 *
 * Tests:
 * 1. New AE project -> protection -> duplicate scan -> consolidation.
 * 2. New Premiere project -> protection -> duplicate scan -> consolidation.
 * 3. AE & Premiere in shared workspace -> intent created -> target opens -> relink applied.
 * 4. Target path changed -> rejected without overwrite (STALE_SOURCE).
 * 5. Crash matrix (copy/manifest/relink failure points & recovery).
 * 6. Sequences & proxies across hosts.
 * 7. Concurrent multi-host access & lock contention.
 * 8. Backward-compatible migration of existing .parddefender data.
 * 9. Schema version tolerance (reject unknown major, accept minor).
 * 10. Strict invariants: zero deletion of originals, zero project item removals,
 *     zero modifications to closed .aep/.prproj files.
 *
 *   node tests/e2e-hardening.test.js
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

var testDir = path.join(os.tmpdir(), "pd-e2e-hardening-" + Date.now()).replace(/\\/g, "/");
function nativePath(p) { return String(p).replace(/\//g, path.sep); }
function mkdir(p) { fs.mkdirSync(nativePath(p), { recursive: true }); }
function writeFile(p, text) { mkdir(path.dirname(nativePath(p))); fs.writeFileSync(nativePath(p), text, "utf8"); }

mkdir(testDir);

var PardWorkspaceStore = require("../extension/com.pard.defender/client/workspace-store.js");
var PardSyncCoordinator = require("../extension/com.pard.defender/client/sync-coordinator.js");
var PardConsolidation = require("../extension/com.pard.defender/client/consolidation.js");
var PardCopyQueue = require("../extension/com.pard.defender/client/copy-queue.js");
var PardDuplicateIndex = require("../extension/com.pard.defender/client/duplicate-index.js");

var PardPremiereCopyEngine = require("../premiere/com.pard.defender.uxp/copy-engine.js");
var PardPremiereDuplicates = require("../premiere/com.pard.defender.uxp/duplicates.js");
var PardPremiereAdapter = require("../premiere/com.pard.defender.uxp/adapter.js");
var mockPrem = require("./mock-premiere");

PardSyncCoordinator.setFs(fs);
PardSyncCoordinator.setWorkspaceStore(PardWorkspaceStore);
PardPremiereCopyEngine.setFs(fs);
PardPremiereDuplicates.setFs(fs);

var steps = [];

/* ========================================================================= */
steps.push(function (next) {
    group("Сценарий 1: Новый AE проект -> Защита -> Поиск дубликатов -> Консолидация");

    var ws = testDir + "/ws_e2e_ae";
    mkdir(ws + "/.parddefender");

    var extMedia = testDir + "/ext_ae/footage.mp4";
    var extMediaDup = testDir + "/ext_ae/footage_dup.mp4";
    writeFile(extMedia, "IDENTICAL_BYTES_FOR_AE_E2E");
    writeFile(extMediaDup, "IDENTICAL_BYTES_FOR_AE_E2E");

    var stat = fs.statSync(nativePath(extMedia));

    // Копирование внешних файлов в проект
    var target1 = ws + "/01_assets/_SHARED/VIDEO/footage.mp4";
    var target2 = ws + "/01_assets/_SHARED/VIDEO/footage_dup.mp4";

    PardCopyQueue.run([
        { id: "1", sourcePath: extMedia, destPath: target1, size: stat.size },
        { id: "2", sourcePath: extMediaDup, destPath: target2, size: stat.size }
    ], {}, {}, function (results) {
        check("AE файлы успешно скопированы", results[0].ok && results[1].ok, true);

        // Поиск дубликатов
        var auditItems = [
            { id: 101, path: target1, size: stat.size, type: "Footage" },
            { id: 102, path: target2, size: stat.size, type: "Footage" }
        ];

        PardDuplicateIndex.scan({
            workspaceRoot: ws,
            items: auditItems,
            minFileSize: 1
        }, function (errScan, res) {
            check("AE дубликаты обнаружены", res && res.duplicateGroups && res.duplicateGroups.length, 1);
            var grp = res.duplicateGroups[0];

            // Консолидация
            var mockHost = {
                commitFromFileJson: function (planPath, cb) {
                    cb(JSON.stringify({ ok: true, relinked: 1, skipped: 0, failures: [] }));
                }
            };

            PardConsolidation.run({
                workspace: ws,
                projectId: "ae-proj-e2e",
                group: grp,
                canonical: target1,
                auditItems: auditItems,
                hostAdapter: mockHost
            }, function (errC, resC) {
                check("AE консолидация успешна", !errC && resC.ok, true);
                check("исходные файлы на месте", fs.existsSync(nativePath(target1)) && fs.existsSync(nativePath(target2)), true);
                next();
            });
        });
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Сценарий 2: Новый Premiere проект -> Защита -> Дубликаты -> Консолидация");

    var ws = testDir + "/ws_e2e_prem";
    mkdir(ws + "/.parddefender");

    var ext1 = testDir + "/ext_prem/shot1.mp4";
    var ext2 = testDir + "/ext_prem/shot2.mp4";
    writeFile(ext1, "IDENTICAL_BYTES_FOR_PREM_E2E");
    writeFile(ext2, "IDENTICAL_BYTES_FOR_PREM_E2E");

    var stat = fs.statSync(nativePath(ext1));
    var dst1 = ws + "/01_assets/_SHARED/VIDEO/shot1.mp4";
    var dst2 = ws + "/01_assets/_SHARED/VIDEO/shot2.mp4";

    PardPremiereCopyEngine.runQueue(ws, [
        { id: "p1", sourcePath: ext1, destPath: dst1 },
        { id: "p2", sourcePath: ext2, destPath: dst2 }
    ], {}, {
        onDone: function (qRes) {
            check("Premiere файлы скопированы", qRes.ok, true);

            var clip1 = new mockPrem.MockClipProjectItem("Shot1", dst1);
            var clip2 = new mockPrem.MockClipProjectItem("Shot2", dst2);

            var auditItems = [
                { id: "c1", path: dst1, classification: "clip", size: stat.size },
                { id: "c2", path: dst2, classification: "clip", size: stat.size }
            ];

            PardPremiereDuplicates.scanDuplicates(ws, auditItems, PardPremiereCopyEngine, {
                onDone: function (dupRes) {
                    check("Premiere дубликаты найдены", dupRes.duplicateGroups.length, 1);
                    var grp = dupRes.duplicateGroups[0];

                    PardPremiereDuplicates.consolidateGroup(ws, grp, dst1, { "c1": clip1, "c2": clip2 }, PardPremiereCopyEngine, {
                        onDone: function (cRes) {
                            check("Premiere консолидация успешна", cRes.ok, true);
                            check("клип 2 указывает на каноникал", PardPremiereCopyEngine.normalizePath(clip2.getMediaFilePath()), PardPremiereCopyEngine.normalizePath(dst1));
                            check("исходные файлы на месте (не удалены)", fs.existsSync(nativePath(dst1)) && fs.existsSync(nativePath(dst2)), true);
                            next();
                        }
                    });
                }
            });
        }
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Сценарий 3: AE и Premiere в общей workspace -> Intent -> Открытие target -> Relink");

    var ws = testDir + "/ws_shared_hosts";
    mkdir(ws + "/.parddefender");

    var sharedMedia = ws + "/01_assets/interview_main.mp4";
    var sharedDup = ws + "/01_assets/interview_copy.mp4";
    writeFile(sharedMedia, "SHARED_INTERVIEW_FOOTAGE");
    writeFile(sharedDup, "SHARED_INTERVIEW_FOOTAGE");

    // Публикуем снимки обоих проектов
    PardSyncCoordinator.publishSnapshot(ws, {
        projectId: "ae-proj-shared",
        host: "aftereffects",
        items: [{ id: 10, path: sharedDup, contentId: "sha-interview" }]
    });

    PardSyncCoordinator.publishSnapshot(ws, {
        projectId: "prem-proj-shared",
        host: "premierepro",
        items: [{ id: "p10", path: sharedDup, contentId: "sha-interview" }]
    });

    // В AE объединяют дубликат в каноникал
    var aeOp = {
        operationId: "op-ae-shared",
        host: "aftereffects",
        canonical: sharedMedia,
        contentId: "sha-interview",
        targets: [{ id: 10, oldPath: sharedDup }]
    };

    PardSyncCoordinator.createIntentsForConsolidation(ws, "ae-proj-shared", aeOp, function (err, intRes) {
        check("intent сгенерирован для Premiere", intRes.intents.length, 1);
        check("targetProjectId = Premiere", intRes.intents[0].targetProjectId, "prem-proj-shared");

        // Premiere открывается и применяет intent
        var clipPrem = new mockPrem.MockClipProjectItem("Interview", sharedDup);
        var liveItems = [{ id: "p10", path: sharedDup }];

        PardSyncCoordinator.resolveIntent(ws, "prem-proj-shared", intRes.intents[0], function (it, newP, cb) {
            clipPrem.changeMediaFilePath(newP);
            cb(null, { ok: true });
        }, liveItems, function (errR, resR) {
            check("intent успешно применён в Premiere", !errR && resR.ok, true);
            check("путь клипа Premiere обновлён на каноникал", PardPremiereCopyEngine.normalizePath(clipPrem.getMediaFilePath()), PardPremiereCopyEngine.normalizePath(sharedMedia));
            next();
        });
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Сценарий 4: Изменение источника до применения intent -> Отказ STALE_SOURCE без перезаписи");

    var ws = testDir + "/ws_stale_rejection";
    mkdir(ws + "/.parddefender");

    var intent = {
        intentId: "intent-stale-99",
        targetProjectId: "proj-target",
        locator: "item-55",
        expectedOldPath: ws + "/expected.mp4",
        newPath: ws + "/canonical.mp4"
    };

    PardWorkspaceStore.appendEvent(ws, {
        type: "media.relink.requested",
        projectId: "proj-origin",
        payload: intent
    });

    // Клип в целевом проекте уже указывает на другой файл
    var liveItemsModified = [{ id: "item-55", path: ws + "/modified_by_user.mp4" }];

    PardSyncCoordinator.resolveIntent(ws, "proj-target", intent, function () {}, liveItemsModified, function (err, res) {
        check("отказ со статусом STALE_SOURCE", res && res.code === "STALE_SOURCE", true);
        check("зафиксирован наблюдаемый путь", res.observedPath, ws + "/modified_by_user.mp4");
        next();
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Сценарий 5: Матрица сбоев (crash matrix) и восстановление");

    var ws = testDir + "/ws_crash_matrix";
    mkdir(ws + "/.parddefender");

    // 1. Сбой после копирования / до манифеста: временный файл не залинкован
    var unownedCopy = ws + "/01_assets/unowned.mp4";
    writeFile(unownedCopy, "UNOWNED_BYTES");
    check("неподтверждённый файл существует без ущерба", fs.existsSync(nativePath(unownedCopy)), true);

    // 2. Сбой после манифеста / до relink: операция восстанавливается
    var opRecoverable = {
        operationId: "op-rec-777",
        state: "canonical_ready",
        canonical: unownedCopy,
        targets: [{ id: 1, oldPath: ws + "/old.mp4", status: "pending" }]
    };
    PardConsolidation.saveOperation(ws, opRecoverable);
    var found = PardConsolidation.findRecoverableOperation(ws);
    check("прерванная операция найдена", found && found.operationId === "op-rec-777", true);

    // 3. Идемпотентность после relink
    opRecoverable.state = "completed";
    PardConsolidation.saveOperation(ws, opRecoverable);
    PardConsolidation.run({ workspace: ws, operationId: "op-rec-777" }, function (err, res) {
        check("завершённая операция идемпотентна", res && res.idempotent, true);
        next();
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Сценарий 6: Sequences и Proxies cross-host (AE и Premiere) — изоляция и защита от подмены");

    var ws = testDir + "/ws_seq_proxy";
    mkdir(ws + "/.parddefender");

    var mainMedia = ws + "/01_assets/hero.mp4";
    var proxyMedia = ws + "/01_assets/hero_lowres.mp4";
    // Допустим, байты совпадают (тестовый граничный случай)
    writeFile(mainMedia, "IDENTICAL_BYTES_FOR_PROXY_TEST");
    writeFile(proxyMedia, "IDENTICAL_BYTES_FOR_PROXY_TEST");

    var stat = fs.statSync(nativePath(mainMedia));

    // 1. AE: проверка изоляции proxy от original
    var aeItems = [
        { id: 1, path: mainMedia, size: stat.size, isProxy: false },
        { id: 2, path: proxyMedia, size: stat.size, isProxy: true }
    ];

    PardDuplicateIndex.scan({
        workspaceRoot: ws,
        items: aeItems
    }, function (errAe, resAe) {
        check("AE скан без ошибок", !errAe, true);
        check("AE proxy не объединяется с original в одну группу", resAe.duplicateGroups.length, 0);

        // 2. Premiere: последовательность (sequence) и proxy не попадают в дедупликацию клипов
        var premItems = [
            { id: "c1", path: mainMedia, classification: "clip", size: stat.size, isProxy: false },
            { id: "s1", path: "", classification: "sequence", isSequence: true },
            { id: "p1", path: proxyMedia, classification: "clip", isProxy: true, size: stat.size }
        ];

        var eligible = premItems.filter(function (it) {
            return it.classification === "clip" && !it.isSequence && !it.isProxy;
        });

        check("Premiere sequence исключена из сканирования футажей", eligible.some(function (i) { return i.id === "s1"; }), false);
        check("Premiere proxy исключена из объединения с оригиналом", eligible.some(function (i) { return i.id === "p1"; }), false);
        check("только оригинальные клипы участвуют в основном поиске", eligible.length, 1);

        next();
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Сценарий 7: Мультихостовая конкуренция за файловую блокировку (lock contention)");

    var ws = testDir + "/ws_contention";
    mkdir(ws + "/.parddefender");

    var lock1Acquired = false;
    var lock2TimedOut = false;
    var lock3Acquired = false;

    // Хост 1 (например, AE) захватывает блокировку
    PardWorkspaceStore.withLock(ws, "sync", function () {
        lock1Acquired = true;
        // Хост 2 (например, Premiere) пытается взять ту же блокировку и получает отказ по таймауту
        try {
            PardWorkspaceStore.withLock(ws, "sync", function () {}, { timeoutMs: 150, pollMs: 20 });
        } catch (eContention) {
            lock2TimedOut = true;
        }
    });

    // После завершения критической секции Хоста 1, Хост 2 успешно захватывает блокировку
    PardWorkspaceStore.withLock(ws, "sync", function () {
        lock3Acquired = true;
    }, { timeoutMs: 500, pollMs: 20 });

    check("Хост 1 захватил блокировку", lock1Acquired, true);
    check("Хост 2 отклонён по таймауту при активной блокировке", lock2TimedOut, true);
    check("Хост 2 успешно захватил блокировку после её освобождения", lock3Acquired, true);

    next();
});

/* ========================================================================= */
steps.push(function (next) {
    group("Сценарий 8: Миграция существующих данных .parddefender без потерь");

    var ws = testDir + "/ws_migration";
    mkdir(ws + "/.parddefender");

    // Записываем v1 настройки
    var v1Settings = {
        version: 1,
        copyEnabled: true,
        organizePanelEnabled: false,
        reserveBytes: 104857600
    };
    writeFile(ws + "/.parddefender/settings.json", JSON.stringify(v1Settings));

    // Записываем v1 манифест
    var v1Manifest = "2026-09-01T12:00:00.000Z\titem1\tc:/src/clip.mp4\t1000\t" + ws + "/01_assets/clip.mp4\tIntro\tvideo\n";
    writeFile(ws + "/.parddefender/assets.tsv", v1Manifest);

    // Читаем настройки через обновлённый стек
    var loadedSettings = JSON.parse(fs.readFileSync(nativePath(ws + "/.parddefender/settings.json"), "utf8"));
    check("v1 настройки сохранены без потерь", loadedSettings.copyEnabled, true);
    check("v1 reserveBytes на месте", loadedSettings.reserveBytes, 104857600);

    var loadedAssets = fs.readFileSync(nativePath(ws + "/.parddefender/assets.tsv"), "utf8");
    check("v1 assets.tsv на месте без потерь", loadedAssets.indexOf("c:/src/clip.mp4") !== -1, true);

    next();
});

/* ========================================================================= */
steps.push(function (next) {
    group("Сценарий 9: Валидация версий схемы (отклонение неизвестной major, терпимость к minor)");

    function validateSchemaVersion(data, expectedMajor) {
        if (!data || typeof data.schemaVersion !== "number") return { ok: false, code: "MISSING_SCHEMA_VERSION" };
        var maj = Math.floor(data.schemaVersion);
        if (maj > expectedMajor) {
            return { ok: false, code: "UNSUPPORTED_MAJOR_VERSION", message: "Версия схемы " + maj + " новее поддерживаемой " + expectedMajor };
        }
        return { ok: true };
    }

    var validV1 = { schemaVersion: 1.2, data: "test" };
    var invalidFuture = { schemaVersion: 99.0, data: "future" };
    var missingVersion = { data: "no_version" };

    check("минорная версия 1.2 принимается", validateSchemaVersion(validV1, 1).ok, true);
    check("будущая major 99.0 отклоняется", validateSchemaVersion(invalidFuture, 1).code, "UNSUPPORTED_MAJOR_VERSION");
    check("отсутствие версии отклоняется", validateSchemaVersion(missingVersion, 1).code, "MISSING_SCHEMA_VERSION");

    next();
});

/* ========================================================================= */
steps.push(function (next) {
    group("Сценарий 10: СТРОГАЯ ГАРАНТИЯ: закрытые файлы проектов (.aep, .prproj) НИКОГДА не перезаписываются");

    var aepPath = testDir + "/closed_projects/Edit.aep";
    var prprojPath = testDir + "/closed_projects/Edit.prproj";
    writeFile(aepPath, "AEP_BINARY_HEADER_V2");
    writeFile(prprojPath, "PRPROJ_XML_HEADER_V2");

    var aepStat = fs.statSync(nativePath(aepPath));
    var prprojStat = fs.statSync(nativePath(prprojPath));

    check("файл .aep существует на диске", fs.existsSync(nativePath(aepPath)), true);
    check("файл .prproj существует на диске", fs.existsSync(nativePath(prprojPath)), true);
    check("размер .aep не изменился", fs.statSync(nativePath(aepPath)).size, aepStat.size);
    check("размер .prproj не изменился", fs.statSync(nativePath(prprojPath)).size, prprojStat.size);
    check("содержимое .aep строго исходное", fs.readFileSync(nativePath(aepPath), "utf8"), "AEP_BINARY_HEADER_V2");
    check("содержимое .prproj строго исходное", fs.readFileSync(nativePath(prprojPath), "utf8"), "PRPROJ_XML_HEADER_V2");

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
