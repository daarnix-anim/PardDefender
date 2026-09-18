/*
 *
 * @map role: 30 проверок фундамента Premiere Pro UXP адаптера.
 * @map status: ready
 *
 * Tests UXP adapter capabilities, active/unsaved project handling, GUID registry,
 * recursive bins, proxy tracking, offline/generated media classification,
 * normalized audit schema, and strict absence of QE/CEP/ExtendScript.
 *
 *   node tests/premiere-adapter.test.js
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

var testDir = path.join(os.tmpdir(), "pd-test-premiere-" + Date.now()).replace(/\\/g, "/");
function nativePath(p) { return String(p).replace(/\//g, path.sep); }
function mkdir(p) { fs.mkdirSync(nativePath(p), { recursive: true }); }
function writeFile(p, text) { mkdir(path.dirname(nativePath(p))); fs.writeFileSync(nativePath(p), text, "utf8"); }

mkdir(testDir);

var PardPremiereAdapter = require("../premiere/com.pard.defender.uxp/adapter.js");
var mockPpro = new mock.MockPremierePro("25.6.2");
PardPremiereAdapter.setPpro(mockPpro);
PardPremiereAdapter.setFs(fs);

/* ========================================================================= */
group("Метаданные хоста и флаги возможностей");
/* ========================================================================= */
(function () {
    var desc = PardPremiereAdapter.describe();
    check("хост - premierepro", desc.host, "premierepro");
    check("адаптер - uxp", desc.adapter, "uxp");
    check("минимальная версия - 25.6", desc.minHostVersion, "25.6");
    check("манифест - версия 5", desc.manifestVersion, 5);
    check("флаг qeDom строго false", desc.capabilities.qeDom, false);
    check("флаг extendScript строго false", desc.capabilities.extendScript, false);
    check("поддержка proxyTracking true", desc.capabilities.proxyTracking, true);
})();

/* ========================================================================= */
group("Состояния проекта: нет проекта, несохранённый и сохранённый");
/* ========================================================================= */
(function () {
    // 1. Нет активного проекта
    mockPpro.setActiveProject(null);
    var idNoProj = PardPremiereAdapter.identifyProject();
    check("нет активного проекта: ok=false", idNoProj.ok, false);
    check("ошибка NO_ACTIVE_PROJECT", idNoProj.error, "NO_ACTIVE_PROJECT");

    var auditNoProj = null;
    PardPremiereAdapter.auditMedia(null, function (err, res) {
        auditNoProj = res;
    });
    check("аудит без проекта возвращает ok=false без сбоя", auditNoProj && auditNoProj.ok, false);

    // 2. Несохранённый проект
    var unsavedProj = new mock.MockProject("guid-unsaved-123", "", "Новый проект");
    mockPpro.setActiveProject(unsavedProj);
    var idUnsaved = PardPremiereAdapter.identifyProject();
    check("несохранённый проект распознан", idUnsaved.ok, true);
    check("флаг projectSaved=false", idUnsaved.projectSaved, false);
    check("GUID извлечён", idUnsaved.projectId, "guid-unsaved-123");

    var auditUnsaved = null;
    PardPremiereAdapter.auditMedia(null, function (err, res) {
        auditUnsaved = res;
    });
    check("аудит несохранённого проекта возвращает projectSaved=false", auditUnsaved && auditUnsaved.projectSaved, false);

    // 3. Сохранённый проект
    var prprojPath = testDir + "/projects/MyEdit/Project.prproj";
    writeFile(prprojPath, "MOCK_PRPROJ");
    var savedProj = new mock.MockProject("guid-saved-456", prprojPath, "Project.prproj");
    mockPpro.setActiveProject(savedProj);
    var idSaved = PardPremiereAdapter.identifyProject();
    check("сохранённый проект: projectSaved=true", idSaved.projectSaved, true);
    check("GUID сохранённого проекта", idSaved.projectId, "guid-saved-456");
    check("рабочая папка вычислена по расположению .prproj", idSaved.workspace, PardPremiereAdapter.normalizePath(testDir + "/projects/MyEdit"));
})();

/* ========================================================================= */
group("Интеграция с реестром проектов (Save As с сохранением GUID)");
/* ========================================================================= */
(function () {
    var ws = testDir + "/ws_registry";
    mkdir(ws + "/.parddefender");
    var guid = "stable-guid-999";
    var origPath = ws + "/Edit_v1.prproj";
    var saveAsPath = ws + "/Edit_v2_final.prproj";

    // Первая фиксация
    var ok1 = PardPremiereAdapter.syncProjectRegistry(ws, guid, origPath);
    check("первая синхронизация реестра успешна", ok1, true);

    var reg1 = JSON.parse(fs.readFileSync(nativePath(ws + "/.parddefender/projects.json"), "utf8"));
    check("в реестре зафиксирован guid", reg1.projects[guid].projectId, guid);
    check("в реестре зафиксирован v1 путь", reg1.projects[guid].projectPath, origPath);
    check("хост указан как premierepro", reg1.host, "premierepro");

    // Save As: тот же GUID, другой путь
    var ok2 = PardPremiereAdapter.syncProjectRegistry(ws, guid, saveAsPath);
    check("Save As синхронизация успешна", ok2, true);

    var reg2 = JSON.parse(fs.readFileSync(nativePath(ws + "/.parddefender/projects.json"), "utf8"));
    check("GUID остался стабилен после Save As", reg2.projects[guid].projectId, guid);
    check("путь обновился на v2", reg2.projects[guid].projectPath, saveAsPath);
})();

/* ========================================================================= */
group("Рекурсивный аудит: bins, клипы, proxy, offline, generated и секвенции");
/* ========================================================================= */
(function () {
    var ws = testDir + "/ws_audit";
    var prproj = ws + "/FeatureFilm.prproj";
    mkdir(ws + "/media");

    var media1 = ws + "/media/shotA.mp4";
    var proxy1 = ws + "/media/shotA_proxy.mp4";
    var media2 = ws + "/media/shotB.mov";
    writeFile(media1, "SHOT_A_DATA");
    writeFile(proxy1, "SHOT_A_PROXY_DATA");
    writeFile(media2, "SHOT_B_DATA");

    var proj = new mock.MockProject("proj-guid-film", prproj, "FeatureFilm.prproj");
    var root = proj.getRootItem();

    // Папка верхнего уровня: Footage
    var binFootage = new mock.MockFolderItem("Footage");
    root.addItem(binFootage);

    // Вложенная папка: Interviews
    var binInterviews = new mock.MockFolderItem("Interviews");
    binFootage.addItem(binInterviews);

    // 1. Клип с proxy
    var clipWithProxy = new mock.MockClipProjectItem("ShotA", media1, {
        hasProxy: true,
        proxyPath: proxy1
    });
    binInterviews.addItem(clipWithProxy);

    // 2. Обычный клип
    var clipNormal = new mock.MockClipProjectItem("ShotB", media2);
    binFootage.addItem(clipNormal);

    // 3. Offline клип
    var clipOffline = new mock.MockClipProjectItem("ShotC_Missing", ws + "/missing.mp4", {
        offline: true
    });
    binFootage.addItem(clipOffline);

    // 4. Секвенция
    var seq = new mock.MockSequence("Timeline_Scene1");
    root.addItem(seq);

    // 5. Синтетическое/сгенерированное медиа (Color Matte)
    var genMatte = new mock.MockClipProjectItem("Black Matte", "", {
        isSynthetic: true,
        mediaType: "synthetic"
    });
    root.addItem(genMatte);

    // 6. Multicam клип
    var multiClip = new mock.MockClipProjectItem("Multicam_Seq", "", {
        isMulticam: true
    });
    root.addItem(multiClip);

    // 7. Merged клип
    var mergedClip = new mock.MockClipProjectItem("Merged_Sync", "", {
        isMerged: true
    });
    root.addItem(mergedClip);

    mockPpro.setActiveProject(proj);

    var auditRes = null;
    PardPremiereAdapter.auditMedia(proj, function (err, res) {
        auditRes = res;
    });

    check("аудит вернул ok=true", auditRes && auditRes.ok, true);
    check("хост premierepro", auditRes.host, "premierepro");
    check("всего элементов в аудите (7)", auditRes.items.length, 7);

    var stats = auditRes.stats;
    check("статистика: clips = 2", stats.clips, 2);
    check("статистика: sequences = 1", stats.sequences, 1);
    check("статистика: offline = 1", stats.offline, 1);
    check("статистика: generated = 1", stats.generated, 1);
    check("статистика: multicam = 1", stats.multicam, 1);
    check("статистика: merged = 1", stats.merged, 1);

    // Проверка binPath и структуры клипа с proxy
    var itemA = auditRes.items[0];
    check("ShotA: binPath вычислен рекурсивно", itemA.binPath, "Footage/Interviews");
    check("ShotA: путь медиа совпадает", itemA.path, PardPremiereAdapter.normalizePath(media1));
    check("ShotA: hasProxy=true", itemA.hasProxy, true);
    check("ShotA: proxyPath совпадает", itemA.proxyPath, PardPremiereAdapter.normalizePath(proxy1));
    check("ShotA: classification=clip", itemA.classification, "clip");

    // Проверка offline клипа
    var itemOffline = auditRes.items[2];
    check("ShotC: classification=offline", itemOffline.classification, "offline");
    check("ShotC: missing=true", itemOffline.missing, true);

    // Проверка секвенции
    var itemSeq = auditRes.items[3];
    check("Scene1: isSequence=true", itemSeq.isSequence, true);
    check("Scene1: classification=sequence", itemSeq.classification, "sequence");

    // Проверка generated media
    var itemGen = auditRes.items[4];
    check("Matte: classification=generated", itemGen.classification, "generated");
})();

/* ========================================================================= */
group("Асинхронные UXP API Premiere Pro 26 (Promises, activeProject, items)");
/* ========================================================================= */
(function () {
    var wsAsync = testDir + "/ws_async";
    var prprojAsync = wsAsync + "/AsyncProject.prproj";
    var mediaAsync = wsAsync + "/clipAsync.mp4";
    mkdir(wsAsync);
    writeFile(prprojAsync, "ASYNC_PROJECT");
    writeFile(mediaAsync, "ASYNC_CLIP_DATA");

    // Имитируем реальный C++ UXP интерфейс Premiere Pro 26:
    // getActiveProject, getRootItem, getItems, getMediaFilePath возвращают Promise!
    var asyncClip = {
        name: "clipAsync.mp4",
        type: 3,
        nodeId: "clip_async_1",
        masterClip: { mediaFilePath: mediaAsync, isOffline: false },
        getMediaFilePath: function () { return Promise.resolve(mediaAsync); },
        isOffline: function () { return Promise.resolve(false); },
        hasProxy: function () { return Promise.resolve(false); }
    };

    var asyncFolder = {
        name: "Root",
        type: 1,
        isBin: true,
        items: [asyncClip],
        getItems: function () { return Promise.resolve([asyncClip]); }
    };

    var asyncProj = {
        name: "AsyncProject.prproj",
        path: prprojAsync,
        guid: "guid-async-777",
        rootItem: asyncFolder,
        getRootItem: function () { return Promise.resolve(asyncFolder); }
    };

    var asyncPpro = {
        version: "26.0.2",
        Project: {
            activeProject: asyncProj,
            projects: [asyncProj],
            getActiveProject: function () { return Promise.resolve(asyncProj); }
        }
    };

    PardPremiereAdapter.setPpro(asyncPpro);

    // 1. identifyProject с асинхронным хостом через activeProject
    var idAsync = PardPremiereAdapter.identifyProject();
    check("асинхронный хост: projectSaved=true", idAsync.projectSaved, true);
    check("асинхронный хост: guid извлечён", idAsync.projectId, "guid-async-777");
    check("асинхронный хост: имя проекта", idAsync.projectName, "AsyncProject.prproj");

    // 2. auditMedia с промисами на всех уровнях
    var asyncAuditDone = false;
    PardPremiereAdapter.auditMedia(null, function (err, res) {
        asyncAuditDone = true;
        check("auditMedia с Promises: ok=true", res && res.ok, true);
        check("auditMedia с Promises: stats.clips=1", res && res.stats && res.stats.clips, 1);
        check("auditMedia с Promises: items[0].path", res && res.items && res.items[0] && res.items[0].path, PardPremiereAdapter.normalizePath(mediaAsync));
        check("auditMedia с Promises: _nativeItem привязан", res && res.items && res.items[0] && res.items[0]._nativeItem === asyncClip, true);
    });

    // Восстанавливаем mockPpro
    PardPremiereAdapter.setPpro(mockPpro);
})();

/* ========================================================================= */
group("Строгая изоляция: полное отсутствие QE DOM, CEP, evalScript и ExtendScript");
/* ========================================================================= */
(function () {
    var uxpDir = path.join(__dirname, "..", "premiere", "com.pard.defender.uxp");
    var files = fs.readdirSync(uxpDir);

    var forbiddenPatterns = [
        /\bqe\./,
        /\bQE\./,
        /\bevalScript\s*\(/,
        /\.evalScript\b/,
        /\bCSInterface\b/,
        /\b#include\b/i,
        /\bapp\.project\.importFiles\b/,
        /\b#target\s+premierepro/i
    ];

    var violations = [];

    files.forEach(function (f) {
        if (f.slice(-3) !== ".js" && f.slice(-5) !== ".html" && f.slice(-4) !== ".jsx") return;
        var content = fs.readFileSync(path.join(uxpDir, f), "utf8");

        forbiddenPatterns.forEach(function (pat) {
            if (pat.test(content)) {
                violations.push(f + " содержит запрещённый паттерн " + pat.toString());
            }
        });
    });

    check("нет запрещённых QE/CEP/evalScript/ExtendScript паттернов в UXP коде", violations, []);
})();

console.log("\nИтоги: пройдено " + passed + ", провалено " + failed);
if (failed > 0) process.exit(1);
