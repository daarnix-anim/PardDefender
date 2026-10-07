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
    check("pluginVersion плагина равен 2.3.3", PardPremiereAdapter.pluginVersion, "2.3.3");
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
        type: 1, // ProjectItemType.CLIP = 1
        nodeId: "clip_async_1",
        masterClip: { mediaFilePath: mediaAsync, isOffline: false },
        getMediaFilePath: function () { return Promise.resolve(mediaAsync); },
        isOffline: function () { return Promise.resolve(false); },
        hasProxy: function () { return Promise.resolve(false); }
    };

    var asyncFolder = {
        name: "Root",
        type: 2, // ProjectItemType.BIN = 2
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
group("Нормализация путей Windows (\\?\\, /?/) и разрешение рабочей папки");
/* ========================================================================= */
(function () {
    var p1 = "\\\\?\\D:\\Yandex.Disk\\00_Projects\\MyProj\\04_edit\\MyProj.prproj";
    var norm1 = PardPremiereAdapter.normalizePath(p1);
    check("normalizePath очищает префикс \\\\?\\", norm1, "d:/Yandex.Disk/00_Projects/MyProj/04_edit/MyProj.prproj");

    var p2 = "/?/D:/Yandex.Disk/00_Projects/MyProj/04_edit/MyProj.prproj";
    var norm2 = PardPremiereAdapter.normalizePath(p2);
    check("normalizePath очищает префикс /?/", norm2, "d:/Yandex.Disk/00_Projects/MyProj/04_edit/MyProj.prproj");

    var p3 = "//?/C:/Users/User/Downloads/test.mp4";
    var norm3 = PardPremiereAdapter.normalizePath(p3);
    check("normalizePath очищает префикс //?/", norm3, "c:/Users/User/Downloads/test.mp4");

    // resolveWorkspace с папками 04_edit, edit, 05_shot_production
    var ws1 = PardPremiereAdapter.resolveWorkspace("d:/Projects/Soul/04_edit/Soul.prproj");
    check("resolveWorkspace для 04_edit возвращает корень", ws1, "d:/Projects/Soul");

    var ws2 = PardPremiereAdapter.resolveWorkspace("d:/Projects/Soul/Edit/Soul.prproj");
    check("resolveWorkspace для Edit возвращает корень", ws2, "d:/Projects/Soul");

    var ws3 = PardPremiereAdapter.resolveWorkspace("d:/Projects/Soul/05_shot_production/Soul.prproj");
    check("resolveWorkspace для 05_shot_production возвращает корень", ws3, "d:/Projects/Soul");

    var ws4 = PardPremiereAdapter.resolveWorkspace("d:/Projects/Soul/04_edit/prproj/Soul.prproj");
    check("resolveWorkspace для вложенных edit-папок возвращает корень", ws4, "d:/Projects/Soul");

    var ws5 = PardPremiereAdapter.resolveWorkspace("d:/Projects/Soul/Soul.prproj");
    check("resolveWorkspace для проекта в корне возвращает корень", ws5, "d:/Projects/Soul");
})();

/* ========================================================================= */
group("Обход ProjectItemCollection (Array.isArray === false, numItems)");
/* ========================================================================= */
(function () {
    var collProj = new mock.MockProject("CollProj", "d:/Projects/CollProj/04_edit/CollProj.prproj");
    // rootItem.children это MockProjectItemCollection, для которого Array.isArray === false!
    check("rootItem.children не является JS-массивом", Array.isArray(collProj.rootItem.children), false);
    check("rootItem.children имеет свойство numItems", typeof collProj.rootItem.children.numItems, "number");

    var bin1 = new mock.MockFolderItem("SubBin");
    collProj.rootItem.addItem(bin1);
    check("bin1.children не является JS-массивом", Array.isArray(bin1.children), false);

    var clipInBin = new mock.MockClipProjectItem("clip_in_bin.mp4", "d:/Projects/CollProj/05_shot_production/clip_in_bin.mp4");
    bin1.addItem(clipInBin);

    var doneAudit = false;
    PardPremiereAdapter.auditMedia(collProj, function (err, res) {
        doneAudit = true;
        check("auditMedia прошёл успешно для ProjectItemCollection", res && res.ok, true);
        check("auditMedia нашёл клип внутри bin с коллекцией", res && res.stats && res.stats.clips, 1);
        check("workspace разрешён правильно (родитель 04_edit)", res && res.workspace, "d:/Projects/CollProj");
    });
    check("auditMedia завершился синхронно/асинхронно", doneAudit, true);
})();

/* ========================================================================= */
group("Реальные константы Premiere Pro ProjectItemType: Clip=1, Bin=2, Root=3, File=4");
/* ========================================================================= */
(function () {
    // Симуляция проекта 'Огни Москвы.prproj' из пользовательского скриншота:
    // Папки: 01 Видеоряд, 02 аудио, 03 Графика, 04 Музыка, 05 Фото, 06 Последовательности
    // Аудиоклипы в корне: 'Огни Москвы - 15.wav', 'Огни москвы.wav' (type = 1 или 4)
    // Секвенция в корне: '01_Огни Москвы_15' (type = 1, isSequence() === true)
    // Клип внутри папки 01 Видеоряд: 'take1.mov' (type = 1)
    var wsMoscow = testDir + "/ws_moscow";
    var prprojMoscow = wsMoscow + "/04_edit/Огни Москвы.prproj";
    mkdir(wsMoscow + "/04_edit");

    var audio1 = wsMoscow + "/Огни Москвы - 15.wav";
    var audio2 = wsMoscow + "/Огни москвы.wav";
    var video1 = wsMoscow + "/take1.mov";
    writeFile(prprojMoscow, "MOCK_PRPROJ");
    writeFile(audio1, "WAV1");
    writeFile(audio2, "WAV2");
    writeFile(video1, "MOV1");

    var projMoscow = new mock.MockProject("guid-moscow-111", prprojMoscow, "Огни Москвы.prproj");
    var root = projMoscow.getRootItem();
    root.type = 3; // ProjectItemType.ROOT = 3

    var binVideo = new mock.MockFolderItem("01 Видеоряд");
    binVideo.type = 2; // ProjectItemType.BIN = 2
    root.addItem(binVideo);

    var clipInVideo = {
        name: "take1.mov",
        type: 1, // ProjectItemType.CLIP = 1
        nodeId: "clip_take1",
        getMediaFilePath: function () { return video1; },
        isOffline: function () { return false; },
        hasProxy: function () { return false; },
        canChangeMediaPath: function () { return true; },
        changeMediaFilePath: function (p) { this.mediaPath = p; return true; }
    };
    binVideo.addItem(clipInVideo);

    var binAudio = new mock.MockFolderItem("02 аудио");
    binAudio.type = 2;
    root.addItem(binAudio);

    // Аудиоклипы в корне (type = 1 или 4)
    var clipWav1 = {
        name: "Огни Москвы - 15.wav",
        type: 1, // ProjectItemType.CLIP = 1 (в Premiere Pro все клипы имеют type = 1)
        nodeId: "clip_wav_1",
        getMediaFilePath: function () { return audio1; },
        isOffline: function () { return false; },
        hasProxy: function () { return false; },
        canChangeMediaPath: function () { return true; },
        changeMediaFilePath: function (p) { this.mediaPath = p; return true; }
    };
    root.addItem(clipWav1);

    var clipWav2 = {
        name: "Огни москвы.wav",
        type: 4, // ProjectItemType.FILE = 4
        nodeId: "clip_wav_2",
        getMediaFilePath: function () { return audio2; },
        isOffline: function () { return false; },
        hasProxy: function () { return false; },
        canChangeMediaPath: function () { return true; },
        changeMediaFilePath: function (p) { this.mediaPath = p; return true; }
    };
    root.addItem(clipWav2);

    // Секвенция в корне
    var seqMoscow = {
        name: "01_Огни Москвы_15",
        type: 1, // В Premiere Pro секвенции также имеют type = 1, но isSequence() возвращает true
        nodeId: "seq_moscow_1",
        isSequence: function () { return true; }
    };
    root.addItem(seqMoscow);

    var resMoscow = null;
    PardPremiereAdapter.auditMedia(projMoscow, function (err, res) {
        resMoscow = res;
    });

    check("аудит проекта с реальными константами успешен", resMoscow && resMoscow.ok, true);
    check("всего элементов в аудите: 4 (3 клипа + 1 секвенция)", resMoscow && resMoscow.items && resMoscow.items.length, 4);
    check("статистика clips = 3 (не 0!)", resMoscow && resMoscow.stats && resMoscow.stats.clips, 3);
    check("статистика sequences = 1", resMoscow && resMoscow.stats && resMoscow.stats.sequences, 1);

    // Проверка, что ни один клип не классифицирован как bin и не отброшен
    var names = resMoscow.items.map(function (it) { return it.name; });
    check("клип take1.mov внутри папки обнаружен", names.indexOf("take1.mov") !== -1, true);
    check("корневой клип 'Огни Москвы - 15.wav' (type=1) обнаружен", names.indexOf("Огни Москвы - 15.wav") !== -1, true);
    check("корневой клип 'Огни москвы.wav' (type=4) обнаружен", names.indexOf("Огни москвы.wav") !== -1, true);
    check("секвенция '01_Огни Москвы_15' обнаружена", names.indexOf("01_Огни Москвы_15") !== -1, true);
})();

/* ========================================================================= */
group("Отказоустойчивость: fallback через metadata XML, коллекции sequences и сохранение online статуса");
/* ========================================================================= */
(function () {
    var wsFb = testDir + "/ws_fallback";
    var prprojFb = wsFb + "/Fallback.prproj";
    mkdir(wsFb);
    writeFile(prprojFb, "PRPROJ_FB");

    var projFb = new mock.MockProject("guid-fb-999", prprojFb, "Fallback.prproj");
    var rootFb = projFb.getRootItem();

    // 1. Секвенция, у которой isSequence() возвращает false или отсутствует, но она зарегистрирована в project.sequences
    var seqItem = {
        name: "MySequence",
        type: 1,
        nodeId: "seq_node_1",
        isSequence: function () { return false; }, // эмуляция сбоя метода
        isOffline: function () { return false; }
    };
    rootFb.addItem(seqItem);
    projFb.sequences.push({
        name: "MySequence",
        projectItem: seqItem,
        id: "seq_id_1"
    });

    // 2. Клип, у которого getMediaFilePath() возвращает пустую строку, но путь есть в getProjectMetadata()
    var realPath = "I:/Download/sample_audio.wav";
    var clipNoPath = {
        name: "sample_audio.wav",
        type: 1,
        nodeId: "clip_node_2",
        getMediaFilePath: function () { return ""; }, // getMediaFilePath пустой
        isOffline: function () { return false; } // но клип онлайн в Premiere!
    };
    rootFb.addItem(clipNoPath);

    projFb.getProjectMetadata = function () {
        return '<premierePrivateProjectMetaData:Column.Intrinsic.FilePath>' + realPath + '</premierePrivateProjectMetaData:Column.Intrinsic.FilePath>' +
               '<premierePrivateProjectMetaData:Column.Intrinsic.Name>sample_audio.wav</premierePrivateProjectMetaData:Column.Intrinsic.Name>';
    };

    var resFb = null;
    PardPremiereAdapter.auditMedia(projFb, function (err, res) {
        resFb = res;
    });

    check("auditMedia с fallback прошёл успешно", resFb && resFb.ok, true);
    check("секвенция обнаружена через project.sequences", resFb && resFb.stats && resFb.stats.sequences, 1);
    check("клип с пустым getMediaFilePath() получил путь из project metadata XML", resFb && resFb.items && resFb.items[1] && resFb.items[1].path, PardPremiereAdapter.normalizePath(realPath));
    check("клип онлайн и не помечен как missing/offline", resFb && resFb.items && resFb.items[1] && resFb.items[1].classification, "clip");
    check("диагностика заполнена строками журнала", resFb && Array.isArray(resFb.diagnostics) && resFb.diagnostics.length > 0, true);
})();

/* ========================================================================= */
group("Корректная классификация online/offline без isOffline() и через ClipProjectItem.cast");
/* ========================================================================= */
(function () {
    var wsCast = testDir + "/ws_cast_test";
    var prprojCast = wsCast + "/CastTest.prproj";
    var realDiskMedia = wsCast + "/real_clip.mp4";
    var missingDiskMedia = wsCast + "/missing_clip.mp4";
    mkdir(wsCast);
    writeFile(prprojCast, "CAST_TEST_PRPROJ");
    writeFile(realDiskMedia, "REAL_MEDIA_BYTES");

    var projCast = new mock.MockProject("guid-cast-1", prprojCast, "CastTest.prproj");
    var rootCast = projCast.getRootItem();

    // 1. Клип без метода isOffline (как в реальном Premiere Pro), но файл существует на диске
    var clipNoMethod = {
        name: "real_clip.mp4",
        type: 1,
        nodeId: "clip_no_isoffline",
        getMediaFilePath: function () { return realDiskMedia; }
        // isOffline отсутствует!
    };
    rootCast.addItem(clipNoMethod);

    // 2. Клип без метода isOffline, и файла нет на диске -> должен быть offline
    var clipMissingOnDisk = {
        name: "missing_clip.mp4",
        type: 1,
        nodeId: "clip_missing_disk",
        getMediaFilePath: function () { return missingDiskMedia; }
    };
    rootCast.addItem(clipMissingOnDisk);

    // 3. Нетипизированный узел ProjectItem, где getMediaFilePath доступен только через ClipProjectItem.cast
    var rawNode = {
        name: "typed_clip.mp4",
        type: 1,
        nodeId: "node_raw_generic"
    };
    var typedClip = {
        name: "typed_clip.mp4",
        type: 1,
        nodeId: "node_raw_generic",
        getMediaFilePath: function () { return realDiskMedia; }
    };
    rootCast.addItem(rawNode);

    var customPpro = new mock.MockPremierePro("25.6.0");
    customPpro.ClipProjectItem = {
        queryCast: function (item) {
            if (item === rawNode) return typedClip;
            return item;
        },
        cast: function (item) {
            if (item === rawNode) return typedClip;
            return item;
        }
    };
    PardPremiereAdapter.setPpro(customPpro);

    // 4. Клип с получением пути через собственный item.getProjectMetadata()
    var clipItemMeta = {
        name: "meta_clip.wav",
        type: 1,
        nodeId: "clip_with_own_metadata",
        getProjectMetadata: function () {
            return '<premierePrivateProjectMetaData:Column.Intrinsic.FilePath>' + realDiskMedia + '</premierePrivateProjectMetaData:Column.Intrinsic.FilePath>';
        }
    };
    rootCast.addItem(clipItemMeta);

    var resCast = null;
    PardPremiereAdapter.auditMedia(projCast, function (err, res) {
        resCast = res;
    });

    PardPremiereAdapter.setPpro(mockPpro); // Возвращаем дефолтный мок

    check("аудит cast/offline прошёл успешно", resCast && resCast.ok, true);
    check("клип без isOffline(), существующий на диске, онлайн (classification=clip)", resCast && resCast.items && resCast.items[0] && resCast.items[0].classification, "clip");
    check("клип без isOffline(), существующий на диске, missing=false", resCast && resCast.items && resCast.items[0] && resCast.items[0].missing, false);
    check("клип, отсутствующий на диске, классифицирован как offline", resCast && resCast.items && resCast.items[1] && resCast.items[1].classification, "offline");
    check("клип, отсутствующий на диске, missing=true", resCast && resCast.items && resCast.items[1] && resCast.items[1].missing, true);
    check("нетипизированный узел получил путь через ClipProjectItem.cast", resCast && resCast.items && resCast.items[2] && resCast.items[2].path, PardPremiereAdapter.normalizePath(realDiskMedia));
    check("нетипизированный узел классифицирован как clip", resCast && resCast.items && resCast.items[2] && resCast.items[2].classification, "clip");
    check("клип с собственным getProjectMetadata() получил путь", resCast && resCast.items && resCast.items[3] && resCast.items[3].path, PardPremiereAdapter.normalizePath(realDiskMedia));
    check("клип с собственным getProjectMetadata() онлайн (classification=clip)", resCast && resCast.items && resCast.items[3] && resCast.items[3].classification, "clip");
    check("статистика: clips = 3", resCast && resCast.stats && resCast.stats.clips, 3);
    check("статистика: offline = 1", resCast && resCast.stats && resCast.stats.offline, 1);
})();

/* ========================================================================= */
group("Показ ассета через официальный UXP SourceMonitor");
/* ========================================================================= */
(function () {
    var projReveal = new mock.MockProject("proj-reveal", testDir + "/reveal.prproj", "reveal.prproj");
    var clip = new mock.MockClipProjectItem("target_clip.mp4", testDir + "/target.mp4");
    projReveal.getRootItem().addItem(clip);
    mockPpro.setActiveProject(projReveal);

    // Full awaited SourceMonitor assertions live in premiere-uxp-io.test.js.
    // Node/CEP-only select/revealItem methods must never be used by UXP.
    var resReveal = PardPremiereAdapter.revealItem(clip);
    check("revealItem возвращает Promise", typeof resReveal.then, "function");
    check("Не вызывает несуществующий в UXP item.select", !!clip.selected, false);
    check("Не вызывает несуществующий в UXP project.revealItem", !!clip.revealed, false);
})();

/* ========================================================================= */
group("Межхостовое сопоставление медиа: распознавание защиты After Effects");
/* ========================================================================= */
(function () {
    var wsAe = testDir + "/ws_ae_match";
    mkdir(wsAe + "/01_assets/_SHARED/VIDEO");
    mkdir(wsAe + "/05_shot_production");
    mkdir(wsAe + "/.parddefender/projects");

    var aeProtectedFile = wsAe + "/05_shot_production/Interview_final.mp4";
    writeFile(aeProtectedFile, "AE_PROTECTED_DATA");

    // Записываем снимок проекта After Effects
    var aeSnapshot = {
        schemaVersion: 1,
        projectId: "ae_proj_101",
        host: "aftereffects",
        items: [
            {
                id: "ae_item_1",
                path: "05_shot_production/Interview_final.mp4",
                contentId: "sha256:abcd1234",
                size: 17,
                classification: "clip"
            }
        ]
    };
    writeFile(wsAe + "/.parddefender/projects/ae_proj_101.media.json", JSON.stringify(aeSnapshot, null, 2));

    var prprojAe = wsAe + "/04_edit/Edit.prproj";
    writeFile(prprojAe, "MOCK_PRPROJ");
    var projAe = new mock.MockProject("guid-ae-match", prprojAe, "Edit.prproj");

    // Клип в Premiere, ссылающийся на внешний файл с тем же именем
    var externalClip = new mock.MockClipProjectItem("Interview_final.mp4", "d:/Downloads/Interview_final.mp4");
    projAe.getRootItem().addItem(externalClip);

    // Клип в Premiere, уже находящийся в 05_shot_production
    var internalClip = new mock.MockClipProjectItem("Interview_final.mp4", aeProtectedFile);
    projAe.getRootItem().addItem(internalClip);

    mockPpro.setActiveProject(projAe);

    var auditRes = null;
    PardPremiereAdapter.auditMedia(projAe, function (err, res) {
        auditRes = res;
    });

    check("аудит с межхостовым сопоставлением успешен", auditRes && auditRes.ok, true);
    check("найдено 2 элемента", auditRes && auditRes.items && auditRes.items.length, 2);

    var itemExt = auditRes.items[0];
    check("внешний клип распознал защиту в AE", !!(itemExt.crossHost && itemExt.crossHost.isAeProtected), true);
    check("внешний клип указывает на хост aftereffects", itemExt.crossHost && itemExt.crossHost.host, "aftereffects");
    check("канонический путь совпадает с файлом AE", itemExt.crossHost && itemExt.crossHost.canonicalPath, PardPremiereAdapter.normalizePath(aeProtectedFile));
    check("внешний клип sharedInProject = false", itemExt.crossHost && itemExt.crossHost.sharedInProject, false);

    var itemInt = auditRes.items[1];
    check("внутренний клип распознал защиту в AE", !!(itemInt.crossHost && itemInt.crossHost.isAeProtected), true);
    check("внутренний клип sharedInProject = true", itemInt.crossHost && itemInt.crossHost.sharedInProject, true);
})();

/* ========================================================================= */
group("Межхостовое сопоставление через assets.tsv (реальный кейс AE без .media.json)");
/* ========================================================================= */
(function () {
    var wsTsv = testDir + "/ws_tsv_match";
    mkdir(wsTsv + "/01_assets/_SHARED/VIDEO");
    mkdir(wsTsv + "/.parddefender");

    var aeCanonFile = wsTsv + "/01_assets/_SHARED/VIDEO/Scene1_take2.mp4";
    writeFile(aeCanonFile, "AE_CANONICAL_BYTES");

    // Записываем только assets.tsv (как делает AE при защите)
    var tsvPath = wsTsv + "/.parddefender/assets.tsv";
    var row = [
        new Date().toISOString(),
        "i100",
        "d:/Renders/Scene1_take2.mp4",
        18,
        aeCanonFile,
        "_SHARED",
        "video"
    ].join("\t") + "\n";
    writeFile(tsvPath, row);

    var prproj = wsTsv + "/04_edit/Edit.prproj";
    writeFile(prproj, "MOCK_PRPROJ");
    var proj = new mock.MockProject("guid-tsv-match", prproj, "Edit.prproj");

    // Внешний клип в Premiere
    var extClip = new mock.MockClipProjectItem("Scene1_take2.mp4", "d:/Renders/Scene1_take2.mp4");
    proj.getRootItem().addItem(extClip);

    // Внутренний клип в Premiere (уже пролинкованный на канонический файл)
    var intClip = new mock.MockClipProjectItem("Scene1_take2.mp4", aeCanonFile);
    proj.getRootItem().addItem(intClip);

    mockPpro.setActiveProject(proj);

    var auditRes = null;
    PardPremiereAdapter.auditMedia(proj, function (err, res) {
        auditRes = res;
    });

    check("аудит с assets.tsv успешен", auditRes && auditRes.ok, true);
    check("найдено 2 элемента", auditRes && auditRes.items && auditRes.items.length, 2);

    var itemExt = auditRes.items[0];
    check("общий legacy assets.tsv не доказывает авторство AE", !!(itemExt.crossHost && itemExt.crossHost.isAeProtected), false);
    check("внешний клип хост aftereffects", itemExt.crossHost && itemExt.crossHost.host, "aftereffects");
    check("внешний клип canRelink = true", itemExt.crossHost && itemExt.crossHost.canRelink, true);
    check("внешний клип sharedInProject = false", itemExt.crossHost && itemExt.crossHost.sharedInProject, false);
    check("внешний клип канонический путь совпадает", itemExt.crossHost && itemExt.crossHost.canonicalPath, PardPremiereAdapter.normalizePath(aeCanonFile));

    var itemInt = auditRes.items[1];
    check("внутренний legacy TSV файл не выдаётся за защиту AE", !!(itemInt.crossHost && itemInt.crossHost.isAeProtected), false);
    check("внутренний клип sharedInProject = true", itemInt.crossHost && itemInt.crossHost.sharedInProject, true);
    check("внутренний клип canRelink = false", itemInt.crossHost && itemInt.crossHost.canRelink, false);
})();

/* ========================================================================= */
group("Межхостовое сопоставление: регистронезависимость Windows, вариации имен и кириллица");
/* ========================================================================= */
(function () {
    var wsMixed = testDir + "/ws_Mixed_Case_Проект";
    mkdir(wsMixed + "/03_audio/music");
    mkdir(wsMixed + "/01_assets/_SHARED/VIDEO");
    mkdir(wsMixed + "/.parddefender/projects");

    var aeWavCanon = wsMixed + "/03_audio/music/Огни москвы.wav";
    writeFile(aeWavCanon, "WAV_AE_DATA");

    var aeDroneCanon = wsMixed + "/01_assets/_SHARED/VIDEO/Drone camera flying through buil 20260919175336.mp4";
    writeFile(aeDroneCanon, "DRONE_AE_DATA");

    // 1. Snapshot с host: "after-effects" (дефолт из workspace-store) и кириллическим именем
    var snapFile = wsMixed + "/.parddefender/projects/proj-ae-1.media.json";
    var snapData = {
        schemaVersion: 1,
        workspace: wsMixed,
        projectId: "proj-ae-1",
        host: "after-effects",
        items: [
            {
                id: "ae1",
                name: "Огни москвы.wav",
                path: aeWavCanon,
                oldPath: "i:/Download/Огни москвы.wav",
                size: 11
            }
        ]
    };
    writeFile(snapFile, JSON.stringify(snapData));

    // 2. assets.tsv с исходным файлом со пробелами
    var tsvFile = wsMixed + "/.parddefender/assets.tsv";
    var row = [
        new Date().toISOString(),
        "ae2",
        "i:/Download/Drone camera flying through buil 20260919175336.mp4",
        13,
        aeDroneCanon,
        "_SHARED",
        "video"
    ].join("\t") + "\n";
    writeFile(tsvFile, row);

    // Проект Premiere Pro открыт с иным регистром пути (Windows case insensitivity)
    var prprojMixed = wsMixed.toLowerCase() + "/04_edit/Edit.prproj";
    writeFile(prprojMixed, "MOCK_PRPROJ");
    var proj = new mock.MockProject("guid-case-match", prprojMixed, "Edit.prproj");

    // Клип 1: кириллица, сопоставление по snapshot oldPath
    var clipWav = new mock.MockClipProjectItem("Огни москвы.wav", "i:/Download/Огни москвы.wav");
    proj.getRootItem().addItem(clipWav);

    // Клип 2: имя клипа в монтаже содержит подчеркивания, а путь и assets.tsv содержат пробелы
    var clipDrone = new mock.MockClipProjectItem(
        "Drone_camera_flying_through_buil..._20260919175336.mp4",
        "i:/Download/Drone camera flying through buil 20260919175336.mp4"
    );
    proj.getRootItem().addItem(clipDrone);

    // Клип 3: оффлайн-клип без mediaPath, но имя совпадает со снимком AE
    var clipOffline = new mock.MockClipProjectItem("Огни москвы.wav", "");
    proj.getRootItem().addItem(clipOffline);

    mockPpro.setActiveProject(proj);

    var auditRes = null;
    PardPremiereAdapter.auditMedia(proj, function (err, res) {
        auditRes = res;
    });

    check("аудит смешанного регистра успешен", auditRes && auditRes.ok, true);
    check("найдено 3 элемента", auditRes && auditRes.items && auditRes.items.length, 3);

    var itemWav = auditRes.items[0];
    check("кириллический wav распознал защиту AE", !!(itemWav.crossHost && itemWav.crossHost.isAeProtected), true);
    check("аудио не перелинковывается назад на путь AE", itemWav.crossHost && itemWav.crossHost.canRelink, false);
    check("wav канонический путь совпадает", itemWav.crossHost && itemWav.crossHost.canonicalPath.toLowerCase(), PardPremiereAdapter.normalizePath(aeWavCanon).toLowerCase());

    var itemDrone = auditRes.items[1];
    check("совпадение имени в общем TSV не доказывает защиту AE", !!(itemDrone.crossHost && itemDrone.crossHost.isAeProtected), false);
    check("drone canRelink = true", itemDrone.crossHost && itemDrone.crossHost.canRelink, true);

    var itemOffline = auditRes.items[2];
    check("оффлайн-клип сопоставился по имени с AE", !!(itemOffline.crossHost && itemOffline.crossHost.isAeProtected), true);
    check("оффлайн canRelink = true", itemOffline.crossHost && itemOffline.crossHost.canRelink, true);
})();

/* ========================================================================= */
group("Межхостовое сопоставление: DLSS/AI-апскейл, тайминг-суффиксы, многоточие и копии");
/* ========================================================================= */
(function () {
    var wsAi = testDir + "/ws_ai_match";
    mkdir(wsAi + "/03_audio/sfx");
    mkdir(wsAi + "/01_assets/_SHARED/VIDEO");
    mkdir(wsAi + "/.parddefender/projects");
    mkdir(wsAi + "/04_edit");

    var aeCanonCamera = wsAi + "/01_assets/_SHARED/VIDEO/Camera_flying_through_room_window_20260919174815_DLSS5_20260919-185859-711700.mp4";
    var aeCanonTimelapse = wsAi + "/01_assets/_SHARED/VIDEO/Timelapse_of_building_lighting_a…_20260919175706_DLSS5_20260919-185556-833000.mp4";
    var aeCanonAudio = wsAi + "/03_audio/sfx/Огни Москвы - 15.wav";
    var aeCanonFamily = wsAi + "/01_assets/_SHARED/VIDEO/Family_eating_dinner_20260919185037_DLSS5_20260919-185425-883200.mp4";

    writeFile(aeCanonCamera, "AE_CAMERA");
    writeFile(aeCanonTimelapse, "AE_TIMELAPSE");
    writeFile(aeCanonAudio, "AE_AUDIO");
    writeFile(aeCanonFamily, "AE_FAMILY");

    var snapFile = wsAi + "/.parddefender/projects/proj-ae.media.json";
    var snapData = {
        schemaVersion: 1,
        host: "aftereffects",
        items: [
            {
                id: "ae_cam",
                name: "Camera_flying_through_room_window_20260919174815_DLSS5_20260919-185859-711700.mp4",
                path: aeCanonCamera,
                oldPath: "i:/Download/Camera_flying_through_room_window_20260919174815_DLSS5_20260919-185859-711700.mp4",
                size: 100
            },
            {
                id: "ae_time",
                name: "Timelapse_of_building_lighting_a…_20260919175706_DLSS5_20260919-185556-833000.mp4",
                path: aeCanonTimelapse,
                oldPath: "i:/Download/Timelapse_of_building_lighting_a…_20260919175706_DLSS5_20260919-185556-833000.mp4",
                size: 200
            },
            {
                id: "ae_snd",
                name: "Огни Москвы - 15.wav",
                path: aeCanonAudio,
                oldPath: "i:/Download/Огни Москвы - 15.wav",
                size: 300
            },
            {
                id: "ae_fam",
                name: "Family_eating_dinner_20260919185037_DLSS5_20260919-185425-883200.mp4",
                path: aeCanonFamily,
                oldPath: "i:/Download/Family_eating_dinner_20260919185037_DLSS5_20260919-185425-883200.mp4",
                size: 400
            }
        ]
    };
    writeFile(snapFile, JSON.stringify(snapData));

    var prproj = wsAi + "/04_edit/Edit.prproj";
    writeFile(prproj, "MOCK_PRPROJ");
    var proj = new mock.MockProject("guid-ai-match", prproj, "Edit.prproj");

    // 1. Клип без DLSS-суффикса в имени/пути Premiere
    var clipStem = new mock.MockClipProjectItem(
        "Camera_flying_through_room_window_20260919174815.mp4",
        "i:/Download/Camera_flying_through_room_window_20260919174815.mp4"
    );
    proj.getRootItem().addItem(clipStem);

    // 2. Клип с 3 точками в имени Premiere против символа многоточия '…' в AE
    var clipDots = new mock.MockClipProjectItem(
        "Timelapse_of_building_lighting_a..._20260919175706_DLSS5_20260919-185556-833000.mp4",
        "i:/Download/Timelapse_of_building_lighting_a..._20260919175706_DLSS5_20260919-185556-833000.mp4"
    );
    proj.getRootItem().addItem(clipDots);

    // 3. Аудио без суффикса хронометража (' - 15')
    var clipAudio = new mock.MockClipProjectItem(
        "Огни москвы.wav",
        "i:/Download/Огни москвы.wav"
    );
    proj.getRootItem().addItem(clipAudio);

    // 4. Клип с суффиксом копии Premiere (' 2')
    var clipCopy = new mock.MockClipProjectItem(
        "Family_eating_dinner_20260919185037 2.mp4",
        "i:/Download/Family_eating_dinner_20260919185037 2.mp4"
    );
    proj.getRootItem().addItem(clipCopy);

    // 5. Внутренний клип, уже перелинкованный в проект
    var clipShared = new mock.MockClipProjectItem(
        "Camera_flying_through_room_window_20260919174815_DLSS5_20260919-185859-711700.mp4",
        aeCanonCamera
    );
    proj.getRootItem().addItem(clipShared);

    mockPpro.setActiveProject(proj);

    var auditRes = null;
    PardPremiereAdapter.auditMedia(proj, function (err, res) {
        auditRes = res;
    });

    check("аудит AI/DLSS/суффиксов успешен", auditRes && auditRes.ok, true);
    check("собрано 5 элементов", auditRes && auditRes.items && auditRes.items.length, 5);

    var itCamera = auditRes.items[0];
    check("клип без DLSS распознал DLSS-защиту в AE", !!(itCamera.crossHost && itCamera.crossHost.isAeProtected), true);
    check("клип без DLSS canRelink = true", itCamera.crossHost && itCamera.crossHost.canRelink, true);
    check("клип без DLSS sharedInProject = false", itCamera.crossHost && itCamera.crossHost.sharedInProject, false);
    check("путь перелинковки указывает на канонический DLSS файл AE", itCamera.crossHost && itCamera.crossHost.canonicalPath, PardPremiereAdapter.normalizePath(aeCanonCamera));

    var itDots = auditRes.items[1];
    check("клип с тремя точками '...' сопоставился с многоточием '…' в AE", !!(itDots.crossHost && itDots.crossHost.isAeProtected), true);
    check("клип с '...' canRelink = true", itDots.crossHost && itDots.crossHost.canRelink, true);

    var itAudio = auditRes.items[2];
    check("аудио без суффикса '- 15' сопоставилось с версией AE", !!(itAudio.crossHost && itAudio.crossHost.isAeProtected), true);
    check("приоритет Premiere запрещает обратный relink аудио в AE", itAudio.crossHost && itAudio.crossHost.canRelink, false);

    var itCopy = auditRes.items[3];
    check("клип с суффиксом копии ' 2' сопоставился с оригиналом AE", !!(itCopy.crossHost && itCopy.crossHost.isAeProtected), true);
    check("копия canRelink = true", itCopy.crossHost && itCopy.crossHost.canRelink, true);

    var itShared = auditRes.items[4];
    check("внутренний общий клип распознал защиту AE", !!(itShared.crossHost && itShared.crossHost.isAeProtected), true);
    check("внутренний общий клип sharedInProject = true", itShared.crossHost && itShared.crossHost.sharedInProject, true);
    check("внутренний общий клип canRelink = false", itShared.crossHost && itShared.crossHost.canRelink, false);
})();

/* ========================================================================= */
group("Фильтрация медиа по использованию на таймлайне секвенций (usedOnTimeline)");
/* ========================================================================= */
(function () {
    var wsTl = testDir + "/ws_timeline_filter";
    mkdir(wsTl + "/04_edit");
    mkdir(wsTl + "/05_shot_production");
    mkdir(wsTl + "/03_audio");

    var prproj = wsTl + "/04_edit/Edit.prproj";
    writeFile(prproj, "MOCK_PRPROJ");
    var proj = new mock.MockProject("guid-timeline-test", prproj, "Edit.prproj");

    var clipVideoTl = new mock.MockClipProjectItem("Hero_take1.mp4", wsTl + "/05_shot_production/Hero_take1.mp4");
    var clipAudioTl = new mock.MockClipProjectItem("Music_track.mp3", wsTl + "/03_audio/Music_track.mp3");
    var clipBinOnly = new mock.MockClipProjectItem("Unused_broll.mp4", wsTl + "/05_shot_production/Unused_broll.mp4");

    proj.getRootItem().addItem(clipVideoTl);
    proj.getRootItem().addItem(clipAudioTl);
    proj.getRootItem().addItem(clipBinOnly);

    // Создаём секвенцию и добавляем clipVideoTl и clipAudioTl на дорожки
    var seq = new mock.MockSequence("MainSequence");
    seq.addClipToTrack(clipVideoTl, false); // video track
    seq.addClipToTrack(clipAudioTl, true);  // audio track

    proj.addSequence(seq);
    mockPpro.setActiveProject(proj);

    var auditRes = null;
    PardPremiereAdapter.auditMedia(proj, function (err, res) {
        auditRes = res;
    });

    check("аудит с фильтрацией таймлайна успешен", auditRes && auditRes.ok, true);
    check("всего элементов в аудите: 4 (3 клипа + 1 секвенция)", auditRes && auditRes.items && auditRes.items.length, 4);

    var itemVideo = auditRes.items[0];
    var itemAudio = auditRes.items[1];
    var itemUnused = auditRes.items[2];

    check("видео на дорожке sequence: usedOnTimeline = true", itemVideo.usedOnTimeline, true);
    check("аудио на дорожке sequence: usedOnTimeline = true", itemAudio.usedOnTimeline, true);
    check("клип, лежащий только в bin: usedOnTimeline = false", itemUnused.usedOnTimeline, false);
    check("статистика timelineClips = 2", auditRes.stats.timelineClips, 2);
    check("статистика clips = 3", auditRes.stats.clips, 3);

    // Проверка с timelineOnly: true (требование: сбор только медиа, присутствующих на таймлайнах)
    var auditTlOnly = null;
    PardPremiereAdapter.auditMedia(proj, { timelineOnly: true }, function (err, res) {
        auditTlOnly = res;
    });
    check("аудит с timelineOnly: true успешен", auditTlOnly && auditTlOnly.ok, true);
    check("собрано ровно 2 клипа с таймлайна (неиспользуемый в bin отфильтрован)", auditTlOnly && auditTlOnly.items && auditTlOnly.items.length, 2);
    check("первый элемент - видео с таймлайна", auditTlOnly.items[0].name, "Hero_take1.mp4");
    check("второй элемент - аудио с таймлайна", auditTlOnly.items[1].name, "Music_track.mp3");
    check("все элементы имеют usedOnTimeline = true", auditTlOnly.items.every(function (it) { return it.usedOnTimeline === true; }), true);
})();

/* ========================================================================= */
group("Устойчивое обнаружение аудиоклипов на таймлайне по имени, стему и метаданным");
/* ========================================================================= */
(function () {
    var wsAudio = testDir + "/ws_audio_timeline";
    mkdir(wsAudio + "/03_audio/voice");
    mkdir(wsAudio + "/04_edit");

    var audioPath = wsAudio + "/03_audio/voice/ElevenLabs_2026-09-21T04.mp3";
    writeFile(audioPath, "MOCK_AUDIO_DATA_ELEVENLABS");
    var prproj = wsAudio + "/04_edit/EditAudio.prproj";
    writeFile(prproj, "MOCK_PRPROJ_AUDIO");
    var proj = new mock.MockProject("guid-audio-test", prproj, "EditAudio.prproj");

    var clipAudio = new mock.MockClipProjectItem("ElevenLabs_2026-09-21T04.mp3", audioPath);
    proj.getRootItem().addItem(clipAudio);

    // Track item has matching name but getProjectItem returns null (simulates UXP detached track item)
    var seq = new mock.MockSequence("1080p");
    var trackItemNoDirectPath = new mock.MockTrackItem("ElevenLabs_2026-09-21T04.mp3", null);
    seq.audioTracks.push(new mock.MockTrack());
    seq.audioTracks.item(0).clips.push(trackItemNoDirectPath);

    proj.addSequence(seq);
    mockPpro.setActiveProject(proj);

    var auditTlOnly = null;
    PardPremiereAdapter.auditMedia(proj, { timelineOnly: true }, function (err, res) {
        auditTlOnly = res;
    });

    check("аудит с аудиоклипом по имени успешен", auditTlOnly && auditTlOnly.ok, true);
    check("аудиоклип найден на таймлайне по имени", auditTlOnly && auditTlOnly.items && auditTlOnly.items.length, 1);
    check("имя клипа совпадает", auditTlOnly && auditTlOnly.items[0] && auditTlOnly.items[0].name, "ElevenLabs_2026-09-21T04.mp3");
    check("клип помечен usedOnTimeline = true", auditTlOnly && auditTlOnly.items[0] && auditTlOnly.items[0].usedOnTimeline, true);
})();

/* ========================================================================= */
group("Межхостовое сопоставление по name+size, hash и строгое исключение 3D файлов");
/* ========================================================================= */
(function () {
    var ws3D = testDir + "/ws_3d_match";
    mkdir(ws3D + "/01_assets/_SHARED/VIDEO");
    mkdir(ws3D + "/01_assets/_SHARED/3D");
    mkdir(ws3D + "/.parddefender/projects");

    var canonVideo = ws3D + "/01_assets/_SHARED/VIDEO/Scene_hero_exact.mp4";
    var canon3D = ws3D + "/01_assets/_SHARED/3D/Model_scene.c4d";
    writeFile(canonVideo, "EXACT_VIDEO_PAYLOAD_12345");
    writeFile(canon3D, "C4D_MODEL_DATA");

    var snapWith3D = {
        host: "aftereffects",
        items: [
            {
                id: "ae_exact_vid",
                name: "Scene_hero_exact.mp4",
                path: canonVideo,
                size: 25,
                contentId: "hash_hero_vid_exact",
                classification: "clip"
            },
            {
                id: "ae_c4d",
                name: "Model_scene.c4d",
                path: canon3D,
                size: 14,
                contentId: "hash_c4d_model",
                classification: "model"
            }
        ]
    };
    writeFile(ws3D + "/.parddefender/projects/ae_snap_3d.media.json", JSON.stringify(snapWith3D));

    var prproj = ws3D + "/04_edit/Edit.prproj";
    mkdir(ws3D + "/04_edit");
    writeFile(prproj, "MOCK_PRPROJ");
    var proj = new mock.MockProject("guid-3d-test", prproj, "Edit.prproj");

    var clipMatchNameSize = new mock.MockClipProjectItem("Scene_hero_exact.mp4", "i:/Download/Scene_hero_exact.mp4");
    var clip3D = new mock.MockClipProjectItem("Model_scene.c4d", "i:/Download/Model_scene.c4d");

    proj.getRootItem().addItem(clipMatchNameSize);
    proj.getRootItem().addItem(clip3D);

    mockPpro.setActiveProject(proj);

    var auditRes = null;
    PardPremiereAdapter.auditMedia(proj, function (err, res) {
        auditRes = res;
    });

    check("аудит 3D и name+size успешен", auditRes && auditRes.ok, true);

    var itVid = auditRes.items[0];
    check("видео сопоставилось с AE", !!(itVid.crossHost && itVid.crossHost.isAeProtected), true);
    check("видео каноникал указывает на AE", itVid.crossHost && itVid.crossHost.canonicalPath, PardPremiereAdapter.normalizePath(canonVideo));

    var it3D = auditRes.items[1];
    check("3D файл (.c4d) строго исключён из защиты AE (crossHost = null)", it3D.crossHost, null);
})();

/* ========================================================================= */
group("Межхостовое сопоставление дубликатов: файлы в shot_production и суффиксы копий/дубликатов");
/* ========================================================================= */
(function () {
    var wsDup = testDir + "/ws_dup_matching";
    mkdir(wsDup + "/01_assets/_SHARED/VIDEO");
    mkdir(wsDup + "/05_shot_production");
    mkdir(wsDup + "/.parddefender/projects");

    var aeCanon = wsDup + "/01_assets/_SHARED/VIDEO/Scene_hero.mp4";
    writeFile(aeCanon, "CANONICAL_BYTES");

    var aeSnap = {
        host: "aftereffects",
        items: [{
            id: "ae_hero",
            name: "Scene_hero.mp4",
            path: aeCanon,
            size: 500,
            classification: "clip"
        }]
    };
    writeFile(wsDup + "/.parddefender/projects/ae_proj.media.json", JSON.stringify(aeSnap));

    var prproj = wsDup + "/04_edit/Edit.prproj";
    mkdir(wsDup + "/04_edit");
    writeFile(prproj, "MOCK_PRPROJ");
    var proj = new mock.MockProject("guid-dup-match", prproj, "Edit.prproj");

    // 1. Клип в 05_shot_production с суффиксом ' - копия'
    var clipCopyRu = new mock.MockClipProjectItem("Scene_hero - копия.mp4", wsDup + "/05_shot_production/Scene_hero - копия.mp4");
    // 2. Клип с суффиксом '_copy'
    var clipCopyEn = new mock.MockClipProjectItem("Scene_hero_copy.mp4", wsDup + "/05_shot_production/Scene_hero_copy.mp4");
    // 3. Клип с суффиксом '_01'
    var clipNum = new mock.MockClipProjectItem("Scene_hero_01.mp4", wsDup + "/05_shot_production/Scene_hero_01.mp4");
    // 4. Клип, уже связанный с каноникалом AE
    var clipCanon = new mock.MockClipProjectItem("Scene_hero.mp4", aeCanon);

    proj.getRootItem().addItem(clipCopyRu);
    proj.getRootItem().addItem(clipCopyEn);
    proj.getRootItem().addItem(clipNum);
    proj.getRootItem().addItem(clipCanon);

    mockPpro.setActiveProject(proj);

    var auditRes = null;
    PardPremiereAdapter.auditMedia(proj, function (err, res) {
        auditRes = res;
    });

    check("аудит дубликатов успешен", auditRes && auditRes.ok, true);

    var itCopyRu = auditRes.items[0];
    check("дубликат ' - копия' сопоставился с AE", !!(itCopyRu.crossHost && itCopyRu.crossHost.isAeProtected), true);
    check("дубликат ' - копия' canRelink = true (даже находясь в 05_shot_production)", itCopyRu.crossHost && itCopyRu.crossHost.canRelink, true);
    check("дубликат ' - копия' sharedInProject = false", itCopyRu.crossHost && itCopyRu.crossHost.sharedInProject, false);

    var itCopyEn = auditRes.items[1];
    check("дубликат '_copy' сопоставился с AE", !!(itCopyEn.crossHost && itCopyEn.crossHost.isAeProtected), true);
    check("дубликат '_copy' canRelink = true", itCopyEn.crossHost && itCopyEn.crossHost.canRelink, true);

    var itNum = auditRes.items[2];
    check("дубликат '_01' сопоставился с AE", !!(itNum.crossHost && itNum.crossHost.isAeProtected), true);
    check("дубликат '_01' canRelink = true", itNum.crossHost && itNum.crossHost.canRelink, true);

    var itCanon = auditRes.items[3];
    check("каноникал sharedInProject = true", itCanon.crossHost && itCanon.crossHost.sharedInProject, true);
    check("каноникал canRelink = false", itCanon.crossHost && itCanon.crossHost.canRelink, false);
})();

/* ========================================================================= */
group("Распознавание нестандартных папок как внешних/незащищённых (Footage, Raw, Downloads)");
/* ========================================================================= */
(function () {
    var ws = "d:/Projects/MyVideo";
    check("Footage/ внутри проекта считается НЕ проектным медиа (требует защиты)", PardPremiereAdapter.isInProjectMediaFolder(ws + "/Footage/clip.mp4", ws), false);
    check("Raw/ внутри проекта считается НЕ проектным медиа", PardPremiereAdapter.isInProjectMediaFolder(ws + "/Raw/clip.mp4", ws), false);
    check("Downloads/ внутри проекта считается НЕ проектным медиа", PardPremiereAdapter.isInProjectMediaFolder(ws + "/Downloads/clip.mp4", ws), false);
    check("05_shot_production внутри проекта является проектным медиа", PardPremiereAdapter.isInProjectMediaFolder(ws + "/05_shot_production/clip.mp4", ws), true);
    check("01_assets/_SHARED внутри проекта является проектным медиа", PardPremiereAdapter.isInProjectMediaFolder(ws + "/01_assets/_SHARED/VIDEO/clip.mp4", ws), true);
    check("03_audio внутри проекта является проектным медиа", PardPremiereAdapter.isInProjectMediaFolder(ws + "/03_audio/voice/clip.wav", ws), true);
    check("sound внутри проекта является проектным медиа", PardPremiereAdapter.isInProjectMediaFolder(ws + "/sound/music/clip.mp3", ws), true);
})();

/* ========================================================================= */
group("Обнаружение аудио- и видеодорожек через официальные UXP API (getAudioTrackCount, getAudioTrack, getTrackItems, getId)");
/* ========================================================================= */
(function () {
    var wsUxp = testDir + "/ws_uxp_tracks";
    var prprojUxp = wsUxp + "/UxpTracks.prproj";
    mkdir(wsUxp);
    writeFile(prprojUxp, "UXP_TRACKS_PROJECT");

    var proj = new mock.MockProject("guid-uxp-tracks", prprojUxp, "UxpTracks.prproj");

    // 1. Audio clip in project (outside project media folder, e.g. Downloads)
    var audioExtPath = "c:/Users/Artist/Downloads/ElevenLabs_VoiceOver_Hero.mp3";
    var audioClipItem = new mock.MockClipProjectItem("ElevenLabs_VoiceOver_Hero.mp3", audioExtPath);
    audioClipItem.nodeId = "audio_node_unique_42";
    audioClipItem.getId = function () { return "audio_node_unique_42"; };

    // 2. Video clip in project
    var videoExtPath = "d:/Footage/RawCameraShot_001.mov";
    var videoClipItem = new mock.MockClipProjectItem("RawCameraShot_001.mov", videoExtPath);
    videoClipItem.nodeId = "video_node_unique_99";
    videoClipItem.getId = function () { return "video_node_unique_99"; };

    // 3. Unused clip (not on timeline)
    var unusedClip = new mock.MockClipProjectItem("Unused_Ambient.wav", "c:/Users/Artist/Downloads/Unused_Ambient.wav");
    unusedClip.nodeId = "unused_node_777";
    unusedClip.getId = function () { return "unused_node_777"; };

    proj.getRootItem().addItem(audioClipItem);
    proj.getRootItem().addItem(videoClipItem);
    proj.getRootItem().addItem(unusedClip);

    // 4. Create Sequence with modern UXP methods only
    var seq = new mock.MockSequence("MainTimeline");
    seq.nodeId = "seq_node_100";
    seq.getId = function () { return "seq_node_100"; };

    // Add audio and video clips to tracks
    seq.addClipToTrack(audioClipItem, true);
    seq.addClipToTrack(videoClipItem, false);

    // Delete legacy properties to strictly test official UXP methods
    delete seq.audioTracks;
    delete seq.videoTracks;

    proj.addSequence(seq);
    mockPpro.setActiveProject(proj);

    // Run audit without timelineOnly
    var auditAll = null;
    PardPremiereAdapter.auditMedia(proj, function (err, res) {
        auditAll = res;
    });

    check("UXP tracks audit: ok=true", auditAll && auditAll.ok, true);
    check("UXP tracks audit: stats.clips=3", auditAll && auditAll.stats && auditAll.stats.clips, 3);
    check("UXP tracks audit: stats.timelineClips=2", auditAll && auditAll.stats && auditAll.stats.timelineClips, 2);

    var foundAudio = auditAll.items.filter(function (it) { return it.id === "audio_node_unique_42"; })[0];
    check("аудиоклип найден в аудите", !!foundAudio, true);
    check("аудиоклип usedOnTimeline=true", foundAudio && foundAudio.usedOnTimeline, true);

    var foundVideo = auditAll.items.filter(function (it) { return it.id === "video_node_unique_99"; })[0];
    check("видеоклип найден в аудите", !!foundVideo, true);
    check("видеоклип usedOnTimeline=true", foundVideo && foundVideo.usedOnTimeline, true);

    var foundUnused = auditAll.items.filter(function (it) { return it.id === "unused_node_777"; })[0];
    check("неиспользуемый клип usedOnTimeline=false", foundUnused && foundUnused.usedOnTimeline, false);

    // Run audit WITH timelineOnly: true
    var auditTlOnly = null;
    PardPremiereAdapter.auditMedia(proj, { timelineOnly: true }, function (err, res) {
        auditTlOnly = res;
    });

    check("UXP timelineOnly: ok=true", auditTlOnly && auditTlOnly.ok, true);
    check("UXP timelineOnly: ровно 2 клипа отобраны для защиты", auditTlOnly && auditTlOnly.items && auditTlOnly.items.length, 2);
    check("UXP timelineOnly: аудиоклип ElevenLabs присутствует среди отобранных", auditTlOnly.items.some(function (it) { return it.name === "ElevenLabs_VoiceOver_Hero.mp3"; }), true);
    check("UXP timelineOnly: видеоклип присутствует среди отобранных", auditTlOnly.items.some(function (it) { return it.name === "RawCameraShot_001.mov"; }), true);
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
