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

/* ========================================================================= */
steps.push(function (next) {
    group("Проектные папки и маршрутизация медиа в Premiere Pro");

    var ws = testDir + "/routing-project";
    mkdir(ws + "/01_assets/_SHARED/VIDEO");
    mkdir(ws + "/03_audio/voice");
    mkdir(ws + "/03_audio/music");
    mkdir(ws + "/03_audio/sfx");
    mkdir(ws + "/04_edit");
    mkdir(ws + "/05_shot_production");
    mkdir(ws + "/.parddefender");

    // Записываем assets.tsv с известным видео из After Effects
    var knownAeVideo = ws + "/01_assets/_SHARED/VIDEO/ae_render_pass.mp4";
    writeFile(ws + "/.parddefender/assets.tsv",
        "2026-09-19T00:00:00.000Z\ti101\tD:/Old/ae_render_pass.mp4\t1000\t" + knownAeVideo + "\t_SHARED\tvideo\n");

    // 1. Проверка распознавания проектных папок
    check("файл в 05_shot_production внутри проекта", PardPremiereCopyEngine.isInProjectMediaFolder(ws + "/05_shot_production/clip.mp4", ws), true);
    check("файл в 03_audio внутри проекта", PardPremiereCopyEngine.isInProjectMediaFolder(ws + "/03_audio/music/track.mp3", ws), true);
    check("файл в 01_assets внутри проекта", PardPremiereCopyEngine.isInProjectMediaFolder(ws + "/01_assets/_SHARED/DESIGN/art.psd", ws), true);
    check("файл в 04_edit НЕ является проектным медиа (должен быть перенесён)", PardPremiereCopyEngine.isInProjectMediaFolder(ws + "/04_edit/misplaced.mp4", ws), false);
    check("файл в корне проекта НЕ является проектным медиа", PardPremiereCopyEngine.isInProjectMediaFolder(ws + "/root_misplaced.mp4", ws), false);
    check("внешний файл из Загрузок вне проекта", PardPremiereCopyEngine.isInProjectMediaFolder("c:/Users/Downloads/clip.mp4", ws), false);

    // 2. Маршрутизация видео
    var meta = PardPremiereCopyEngine.loadWorkspaceMeta(ws);
    check("loadWorkspaceMeta обнаружил 05_shot_production", meta.existingFolders.shotProd05, true);
    check("loadWorkspaceMeta обнаружил 03_audio", meta.existingFolders.audio, true);

    // Новое видео вне проекта (не используется в AE) -> в 01_assets (согласно требованиям пользователя)
    var routeVideo = PardPremiereCopyEngine.resolveDestination({ path: "i:/Download/new_footage.mp4" }, ws, meta);
    check("новое видео направляется в 01_assets", routeVideo.destPath, PardPremiereCopyEngine.normalizePath(ws + "/01_assets/_SHARED/VIDEO/new_footage.mp4"));
    check("категория видео", routeVideo.category, "video");

    // Импортированные секвенции изображений (рендер 3D) -> в 05_shot_production
    var routeSeq = PardPremiereCopyEngine.resolveDestination({
        name: "render_0001.exr",
        path: "i:/Download/3d_render/render_0001.exr",
        isSequence: true
    }, ws, meta);
    check("секвенция 3D рендера направляется в 05_shot_production", routeSeq.destPath, PardPremiereCopyEngine.normalizePath(ws + "/05_shot_production/3d_render/render_0001.exr"));

    // Видео, уже зарегистрированное в After Effects -> направляется в 01_assets
    var routeAeVideo = PardPremiereCopyEngine.resolveDestination({ path: "d:/Old/ae_render_pass.mp4" }, ws, meta);
    check("видео из AE направляется в каноникал 01_assets", routeAeVideo.destPath, PardPremiereCopyEngine.normalizePath(knownAeVideo));

    // 3. Маршрутизация аудио (голос, музыка, sfx)
    var routeVoice = PardPremiereCopyEngine.resolveDestination({ path: "c:/Downloads/VO_scene1.wav" }, ws, meta);
    check("голос (VO_) направляется в 03_audio/voice", routeVoice.destPath, PardPremiereCopyEngine.normalizePath(ws + "/03_audio/voice/VO_scene1.wav"));

    var routeVoiceRu = PardPremiereCopyEngine.resolveDestination({ path: "c:/Downloads/Диктор_финал.mp3" }, ws, meta);
    check("голос (Диктор) направляется в 03_audio/voice", routeVoiceRu.destPath, PardPremiereCopyEngine.normalizePath(ws + "/03_audio/voice/Диктор_финал.mp3"));

    var routeMusic = PardPremiereCopyEngine.resolveDestination({ path: "c:/Downloads/summer_track.mp3" }, ws, meta);
    check("музыка (track) направляется в 03_audio/music", routeMusic.destPath, PardPremiereCopyEngine.normalizePath(ws + "/03_audio/music/summer_track.mp3"));

    var routeSfx = PardPremiereCopyEngine.resolveDestination({ path: "c:/Downloads/whoosh_transition.wav" }, ws, meta);
    check("эффект (whoosh) направляется в 03_audio/sfx", routeSfx.destPath, PardPremiereCopyEngine.normalizePath(ws + "/03_audio/sfx/whoosh_transition.wav"));

    // 4. Маршрутизация в проект с папкой "sound" вместо "03_audio"
    var wsSound = testDir + "/sound-project";
    mkdir(wsSound + "/sound");
    mkdir(wsSound + "/shot production");
    var metaSound = PardPremiereCopyEngine.loadWorkspaceMeta(wsSound);
    check("metaSound обнаружил sound", metaSound.existingFolders.sound, true);
    check("metaSound обнаружил shot production", metaSound.existingFolders.shotProdSpace, true);

    var routeSoundVoice = PardPremiereCopyEngine.resolveDestination({ path: "c:/Downloads/voiceover.mp3" }, wsSound, metaSound);
    check("голос всегда направляется в 03_audio/voice", routeSoundVoice.destPath, PardPremiereCopyEngine.normalizePath(wsSound + "/03_audio/voice/voiceover.mp3"));

    var routeSoundVideo = PardPremiereCopyEngine.resolveDestination({ path: "c:/Downloads/raw_shot.mov" }, wsSound, metaSound);
    check("обычное видео всегда направляется в 01_assets", routeSoundVideo.destPath, PardPremiereCopyEngine.normalizePath(wsSound + "/01_assets/_SHARED/VIDEO/raw_shot.mov"));

    next();
});

/* ========================================================================= */
steps.push(function (next) {
    group("Межхостовая координация AE/Premiere: Zero-Copy переиспользование защищённых файлов");

    var wsCross = testDir + "/ws_cross_protect";
    mkdir(wsCross + "/05_shot_production");
    mkdir(wsCross + "/01_assets/_SHARED/VIDEO");
    mkdir(wsCross + "/.parddefender/projects");

    var aeCanonFile = wsCross + "/05_shot_production/interview_shared.mp4";
    var externalSrc = testDir + "/downloads/interview_shared.mp4";
    writeFile(aeCanonFile, "IDENTICAL_SHARED_CLIP_BYTES");
    writeFile(externalSrc, "IDENTICAL_SHARED_CLIP_BYTES");

    // 1. Снимок проекта After Effects
    var aeSnap = {
        schemaVersion: 1,
        projectId: "ae_cross_42",
        host: "aftereffects",
        items: [
            {
                id: "ae_node_1",
                path: "05_shot_production/interview_shared.mp4",
                size: 28,
                classification: "clip"
            }
        ]
    };
    writeFile(wsCross + "/.parddefender/projects/ae_cross_42.media.json", JSON.stringify(aeSnap, null, 2));

    var metaCross = PardPremiereCopyEngine.loadWorkspaceMeta(wsCross);
    check("loadWorkspaceMeta загрузил aeAssets", !!(metaCross.aeAssets && metaCross.aeAssets["interview_shared.mp4"]), true);

    // 2. Маршрутизация клипа в Premiere: находит файл AE и помечает isAeCanonical=true
    var routeRes = PardPremiereCopyEngine.resolveDestination({ path: externalSrc }, wsCross, metaCross);
    check("destPath направлен в файл AE", routeRes.destPath, PardPremiereCopyEngine.normalizePath(aeCanonFile));
    check("флаг isAeCanonical установлен", routeRes.isAeCanonical, true);

    // 3. Запуск очереди runQueue с allowReuse / isAeCanonical
    var tasks = [{
        id: "pr_clip_1",
        sourcePath: externalSrc,
        destPath: routeRes.destPath,
        allowReuse: true,
        isAeCanonical: true,
        branch: routeRes.branch,
        category: routeRes.category
    }];

    PardPremiereCopyEngine.runQueue(wsCross, tasks, {}, {
        onDone: function (qRes) {
            check("очередь завершилась успешно", qRes.ok, true);
            check("задача выполнена", qRes.results && qRes.results[0] && qRes.results[0].ok, true);
            check("файл переиспользован БЕЗ повторного копирования (reused=true)", qRes.results[0].reused, true);
            check("destPath сохранён", qRes.results[0].destPath, routeRes.destPath);

            // 4. Перелинковка клипа на канонический файл AE
            var clipMock = new mock.MockClipProjectItem("interview_shared.mp4", externalSrc);
            var relRes = PardPremiereCopyEngine.relinkClip(clipMock, qRes.results[0].destPath);
            check("перелинковка на файл AE успешна", relRes.ok, true);
            check("клип теперь ссылается на защищённый файл AE", PardPremiereCopyEngine.normalizePath(clipMock.getMediaFilePath()), routeRes.destPath);

            next();
        }
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Межхостовая координация через assets.tsv: мгновенное Zero-Copy переиспользование без зависания");

    var wsTsvOnly = testDir + "/ws_tsv_only";
    mkdir(wsTsvOnly + "/01_assets/_SHARED/VIDEO");
    mkdir(wsTsvOnly + "/.parddefender");

    var canonFile = wsTsvOnly + "/01_assets/_SHARED/VIDEO/Voiceover_rec.mp4";
    writeFile(canonFile, "VOICEOVER_CANONICAL_CONTENT");

    var extSrc = testDir + "/sources/Voiceover_rec.mp4";
    writeFile(extSrc, "VOICEOVER_CANONICAL_CONTENT");

    var tsvFile = wsTsvOnly + "/.parddefender/assets.tsv";
    var row = [new Date().toISOString(), "ae_vo_1", "d:/Old/Voiceover_rec.mp4", 27, canonFile, "_SHARED", "video"].join("\t") + "\n";
    writeFile(tsvFile, row);

    var meta = PardPremiereCopyEngine.loadWorkspaceMeta(wsTsvOnly);
    check("assetsTsv загружен в метаданные", !!(meta.assetsTsv && meta.assetsTsv["voiceover_rec.mp4"]), true);

    var route = PardPremiereCopyEngine.resolveDestination({ path: extSrc }, wsTsvOnly, meta);
    check("маршрут направлен на канонический файл", route.destPath, PardPremiereCopyEngine.normalizePath(canonFile));
    check("флаг isAeCanonical установлен", route.isAeCanonical, true);

    var tasks = [{
        id: "pr_vo_1",
        sourcePath: extSrc,
        destPath: route.destPath,
        allowReuse: true,
        isAeCanonical: true,
        branch: route.branch,
        category: route.category
    }];

    PardPremiereCopyEngine.runQueue(wsTsvOnly, tasks, {}, {
        onDone: function (qRes) {
            check("runQueue завершился без зависания", qRes.ok, true);
            check("задача выполнена", qRes.results && qRes.results[0] && qRes.results[0].ok, true);
            check("файл переиспользован (reused=true)", qRes.results[0].reused, true);

            var tsvContent = fs.readFileSync(nativePath(tsvFile), "utf8");
            check("переиспользование не присваивает Premiere авторство копии AE", tsvContent.indexOf("pr_vo_1") !== -1, false);

            next();
        }
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Шаг 10: Межхостовое переиспользование: host after-effects, вариации пробелов/подчеркиваний и кириллица");

    var wsVar = testDir + "/ws_var_match";
    mkdir(wsVar + "/03_audio/music");
    mkdir(wsVar + "/.parddefender/projects");

    var canonWav = wsVar + "/03_audio/music/Огни москвы.wav";
    writeFile(canonWav, "WAV_AE_DATA_CANON");

    // Snapshot с host: "after-effects"
    var snapFile = wsVar + "/.parddefender/projects/proj-ae-var.media.json";
    writeFile(snapFile, JSON.stringify({
        schemaVersion: 1,
        workspace: wsVar,
        projectId: "proj-ae-var",
        host: "after-effects",
        items: [
            {
                id: "1",
                name: "Огни москвы.wav",
                path: canonWav,
                oldPath: "i:/Download/Огни москвы.wav"
            }
        ]
    }));

    var meta = PardPremiereCopyEngine.loadWorkspaceMeta(wsVar);
    check("snapshot с host after-effects загружен в aeAssets", !!meta.aeAssets[canonWav.toLowerCase()], true);

    // 1. Поиск по имени с другим регистром / путем
    var route1 = PardPremiereCopyEngine.resolveDestination({
        name: "Огни москвы.wav",
        path: "i:/Download/Огни москвы.wav"
    }, wsVar, meta);
    check("неопределённое аудио не подчиняется маршруту AE", route1.destPath, PardPremiereCopyEngine.normalizePath(wsVar + "/03_audio/Огни москвы.wav"));

    // 2. assets.tsv с подчеркиваниями, поиск по имени с пробелами
    var canonDrone = wsVar + "/01_assets/_SHARED/VIDEO/Drone_camera_flying.mp4";
    mkdir(wsVar + "/01_assets/_SHARED/VIDEO");
    writeFile(canonDrone, "DRONE_CANON");

    var tsvFile = wsVar + "/.parddefender/assets.tsv";
    writeFile(tsvFile, [
        new Date().toISOString(), "drone_id", "i:/Download/Drone camera flying.mp4", 11, canonDrone, "_SHARED", "video"
    ].join("\t") + "\n");

    var meta2 = PardPremiereCopyEngine.loadWorkspaceMeta(wsVar);
    var route2 = PardPremiereCopyEngine.resolveDestination({
        name: "Drone_camera_flying.mp4",
        path: "i:/Download/Drone camera flying.mp4"
    }, wsVar, meta2);
    check("route2 сопоставил пробелы/подчеркивания и направил на каноникал", route2.destPath, PardPremiereCopyEngine.normalizePath(canonDrone));

    next();
});

steps.push(function (next) {
    group("Шаг 11: Межхостовая маршрутизация: распознавание DLSS/AI-апскейла, тайминг-суффиксов и многоточий");
    var wsAi = testDir + "/ws_ai_routing";
    var canonCam = wsAi + "/01_assets/_SHARED/VIDEO/Camera_flying_through_room_window_20260919174815_DLSS5_20260919-185859-711700.mp4";
    var canonAudio = wsAi + "/03_audio/sfx/Огни Москвы - 15.wav";
    var canonTimelapse = wsAi + "/01_assets/_SHARED/VIDEO/Timelapse_of_building_lighting_a…_20260919175706_DLSS5_20260919-185556-833000.mp4";

    mkdir(wsAi + "/01_assets/_SHARED/VIDEO");
    mkdir(wsAi + "/03_audio/sfx");
    mkdir(wsAi + "/.parddefender/projects");

    writeFile(canonCam, "CAM_DATA");
    writeFile(canonAudio, "AUDIO_DATA");
    writeFile(canonTimelapse, "TIME_DATA");

    writeFile(wsAi + "/.parddefender/projects/proj-ai.media.json", JSON.stringify({
        schemaVersion: 1,
        host: "aftereffects",
        items: [
            { id: "c1", path: canonCam, name: "Camera_flying_through_room_window_20260919174815_DLSS5_20260919-185859-711700.mp4" },
            { id: "a1", path: canonAudio, name: "Огни Москвы - 15.wav" },
            { id: "t1", path: canonTimelapse, name: "Timelapse_of_building_lighting_a…_20260919175706_DLSS5_20260919-185556-833000.mp4" }
        ]
    }));

    var meta = PardPremiereCopyEngine.loadWorkspaceMeta(wsAi);

    // 1. Исходный клип без DLSS направляется на канонический файл AE
    var r1 = PardPremiereCopyEngine.resolveDestination({
        name: "Camera_flying_through_room_window_20260919174815.mp4",
        path: "i:/Download/Camera_flying_through_room_window_20260919174815.mp4"
    }, wsAi, meta);
    check("исходный клип без DLSS разрешается в канонический DLSS файл AE", r1.destPath, PardPremiereCopyEngine.normalizePath(canonCam));
    check("isAeCanonical = true", r1.isAeCanonical, true);

    // 2. Аудио без суффикса '- 15'
    var r2 = PardPremiereCopyEngine.resolveDestination({
        name: "Огни москвы.wav",
        path: "i:/Download/Огни москвы.wav"
    }, wsAi, meta);
    check("аудио не подменяется нарезанной версией AE", r2.destPath, PardPremiereCopyEngine.normalizePath(wsAi + "/03_audio/Огни москвы.wav"));

    // 3. Клип с ASCII 3 точками против символа многоточия '…'
    var r3 = PardPremiereCopyEngine.resolveDestination({
        name: "Timelapse_of_building_lighting_a..._20260919175706_DLSS5_20260919-185556-833000.mp4",
        path: "i:/Download/Timelapse_of_building_lighting_a..._20260919175706_DLSS5_20260919-185556-833000.mp4"
    }, wsAi, meta);
    check("многоточие разрешается в канонический файл AE", r3.destPath, PardPremiereCopyEngine.normalizePath(canonTimelapse));

    next();
});

steps.push(function (next) {
    group("Шаг 12: Проверка папок проекта и асинхронный relinkClip");

    var ws = testDir + "/ws_folders";
    // Valid folders
    check("01_assets - валидная папка проекта", PardPremiereCopyEngine.isInProjectMediaFolder(ws + "/01_assets/video.mp4", ws), true);
    check("03_audio - валидная папка проекта", PardPremiereCopyEngine.isInProjectMediaFolder(ws + "/03_audio/track.wav", ws), true);
    check("05_shot_production - валидная папка проекта", PardPremiereCopyEngine.isInProjectMediaFolder(ws + "/05_shot_production/shot.mp4", ws), true);
    check("shot_production - валидная папка проекта", PardPremiereCopyEngine.isInProjectMediaFolder(ws + "/shot_production/shot.mp4", ws), true);

    // Non-standard/external folders inside workspace
    check("Footage/ внутри ws - НЕ валидная папка проекта (требует защиты)", PardPremiereCopyEngine.isInProjectMediaFolder(ws + "/Footage/clip.mp4", ws), false);
    check("Raw/ внутри ws - НЕ валидная папка проекта (требует защиты)", PardPremiereCopyEngine.isInProjectMediaFolder(ws + "/Raw/clip.mp4", ws), false);
    check("Downloads/ внутри ws - НЕ валидная папка проекта (требует защиты)", PardPremiereCopyEngine.isInProjectMediaFolder(ws + "/Downloads/clip.mp4", ws), false);
    check("04_edit/ - служебная папка монтажа (НЕ проектный медиа-путь)", PardPremiereCopyEngine.isInProjectMediaFolder(ws + "/04_edit/clip.mp4", ws), false);

    // Test async relinkClip with mock ProjectItem returning Promise
    var asyncItem = {
        canChangeMediaPath: function () {
            return Promise.resolve(true);
        },
        changeMediaFilePath: function (newPath, suppressUI) {
            this._mediaPath = newPath;
            return Promise.resolve(true);
        },
        getMediaFilePath: function () {
            return Promise.resolve(this._mediaPath || "old.mp4");
        },
        _mediaPath: "old.mp4"
    };

    PardPremiereCopyEngine.relinkClip(asyncItem, "new.mp4").then(function (res) {
        check("async relinkClip успешен", res.ok, true);
        check("async relinkClip путь обновлен", asyncItem._mediaPath, "new.mp4");
        next();
    }).catch(function (err) {
        check("async relinkClip без ошибок", err.message, "");
        next();
    });
});

steps.push(function (next) {
    group("Шаг 13: Симуляция Adobe Premiere Pro UXP (fs.existsSync is undefined)");

    // Create a mock UXP fs that has statSync / accessSync but NO existsSync
    var uxpFs = Object.create(fs);
    uxpFs.existsSync = undefined;

    PardPremiereCopyEngine.setFs(uxpFs);

    var existingFile = testDir + "/uxp_exist_test.txt";
    var missingFile = testDir + "/uxp_non_existent.txt";
    writeFile(existingFile, "hello uxp");

    check("fileExists определяет существующий файл без fs.existsSync", PardPremiereCopyEngine.fileExists(nativePath(existingFile)), true);
    check("fileExists определяет отсутствующий файл без fs.existsSync", PardPremiereCopyEngine.fileExists(nativePath(missingFile)), false);

    // loadWorkspaceMeta with UXP fs
    var wsUxp = testDir + "/ws_uxp";
    mkdir(wsUxp + "/05_shot_production");
    mkdir(wsUxp + "/03_audio");
    var metaUxp = PardPremiereCopyEngine.loadWorkspaceMeta(wsUxp);
    check("loadWorkspaceMeta без fs.existsSync определяет shotProd05", metaUxp.existingFolders.shotProd05, true);
    check("loadWorkspaceMeta без fs.existsSync определяет audio", metaUxp.existingFolders.audio, true);

    // runQueue with UXP fs
    var srcUxp = testDir + "/uxp_src.mp4";
    var dstUxp = wsUxp + "/05_shot_production/uxp_src.mp4";
    writeFile(srcUxp, "video-content-uxp-test");

    var uxpTasks = [{
        id: "uxp_1",
        sourcePath: srcUxp,
        destPath: dstUxp,
        allowReuse: true,
        isAeCanonical: false
    }];

    PardPremiereCopyEngine.runQueue(wsUxp, uxpTasks, {}, {
        onDone: function (qRes) {
            check("runQueue завершился успешно без fs.existsSync", qRes.ok, true);
            check("целевой файл скопирован в UXP режиме", PardPremiereCopyEngine.fileExists(nativePath(dstUxp)), true);

            // Restore standard fs
            PardPremiereCopyEngine.setFs(fs);
            next();
        }
    });
});

steps.push(function (next) {
    group("Шаг 14: Симуляция Adobe Premiere Pro UXP без модуля path (require('path') is undefined)");

    // Simulate UXP environment where path is not provided by host
    PardPremiereCopyEngine.setPath(null);

    var wsNoPath = testDir + "/ws_no_path";
    var srcNoPath = testDir + "/src_no_path.mp4";
    // Destination with non-existent nested subdirectories
    var dstNoPath = wsNoPath + "/01_assets/_SHARED/VIDEO/test_nested_copy.mp4";
    writeFile(srcNoPath, "payload-without-path-module");

    var noPathTasks = [{
        id: "no_path_1",
        sourcePath: srcNoPath,
        destPath: dstNoPath,
        allowReuse: true,
        isAeCanonical: false
    }];

    PardPremiereCopyEngine.runQueue(wsNoPath, noPathTasks, {}, {
        onDone: function (qRes) {
            check("runQueue успешен без Node path модуля", qRes.ok, true);
            check("результат задачи успешен", qRes.results && qRes.results[0] && qRes.results[0].ok, true);
            check("файл в глубоко вложенной папке скопирован", PardPremiereCopyEngine.fileExists(dstNoPath), true);
            check("содержимое скопированного файла верное", fs.readFileSync(dstNoPath.replace(/\//g, path.sep), "utf8"), "payload-without-path-module");

            // Restore standard path
            PardPremiereCopyEngine.setPath(path);
            next();
        }
    });
});

/* ========================================================================= */
steps.push(function (next) {
    group("Шаг 15: ArrayBuffer/Uint8Array хеширование и cross-slash path resolution");

    // 1. ArrayBuffer input in createSha256
    PardPremiereCopyEngine.setCrypto(null); // Force pure JS SHA-256
    var text = "Hello UXP ArrayBuffer World!";
    var expectedHash = "da62c9a8ba3a31c5810d116b30cf53c81214cbbd4a7741cec9afbf1b26651e6e"; // SHA-256 of text
    var ab = new ArrayBuffer(text.length);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < text.length; i++) {
        u8[i] = text.charCodeAt(i);
    }

    var hasherAb = PardPremiereCopyEngine.createSha256();
    hasherAb.update(ab);
    check("ArrayBuffer хешируется верно в pure JS", hasherAb.digest(), expectedHash);

    var hasherU8 = PardPremiereCopyEngine.createSha256();
    hasherU8.update(u8);
    check("Uint8Array хешируется верно в pure JS", hasherU8.digest(), expectedHash);

    // Restore crypto
    PardPremiereCopyEngine.setCrypto(crypto);

    // 2. Cross-slash resolveExistingPath
    var testCrossFile = testDir + "/cross_slash_test.txt";
    writeFile(testCrossFile, "CROSS_SLASH_TEST");
    var fwdPath = testCrossFile.replace(/\\/g, "/");
    var backPath = testCrossFile.replace(/\//g, "\\");

    check("resolveExistingPath находит forward slash", !!PardPremiereCopyEngine.resolveExistingPath(fwdPath), true);
    check("resolveExistingPath находит backslash", !!PardPremiereCopyEngine.resolveExistingPath(backPath), true);
    check("fileExists работает с обеими формами", PardPremiereCopyEngine.fileExists(fwdPath) && PardPremiereCopyEngine.fileExists(backPath), true);

    next();
});

/* ========================================================================= */
steps.push(function (next) {
    group("Шаг 16: Маршрутизация неиспользуемых файлов в папку unused в корне проекта");

    var ws = testDir + "/ws_unused_route";
    var normWs = ws.replace(/\\/g, "/");

    var vidItem = { name: "broll.mp4", path: "D:/Footage/broll.mp4" };
    var rVid = PardPremiereCopyEngine.resolveUnusedDestination(vidItem, normWs);
    check("видео маршрутизируется в unused/VIDEO", rVid.destPath, normWs + "/unused/VIDEO/broll.mp4");
    check("ветка unused", rVid.branch, "unused");
    check("категория video", rVid.category, "video");

    var audItem = { name: "foley.wav", path: "E:/Sounds/foley.wav" };
    var rAud = PardPremiereCopyEngine.resolveUnusedDestination(audItem, normWs);
    check("аудио маршрутизируется в unused/AUDIO", rAud.destPath, normWs + "/unused/AUDIO/foley.wav");
    check("категория audio", rAud.category, "audio");

    var imgItem = { name: "photo.jpg", path: "C:/Pics/photo.jpg" };
    var rImg = PardPremiereCopyEngine.resolveUnusedDestination(imgItem, normWs);
    check("изображение маршрутизируется в unused/IMAGES", rImg.destPath, normWs + "/unused/IMAGES/photo.jpg");
    check("категория images", rImg.category, "images");

    var seqItem = { name: "render_0001.exr", path: "D:/3D/pass/render_0001.exr", isSequence: true };
    var rSeq = PardPremiereCopyEngine.resolveUnusedDestination(seqItem, normWs);
    check("секвенция маршрутизируется в unused/SEQUENCES/<folder>", rSeq.destPath, normWs + "/unused/SEQUENCES/pass/render_0001.exr");
    check("категория sequence", rSeq.category, "sequence");

    var modItem = { name: "scene.c4d", path: "D:/Models/scene.c4d" };
    var rMod = PardPremiereCopyEngine.resolveUnusedDestination(modItem, normWs);
    check("3D модель маршрутизируется в unused/3D", rMod.destPath, normWs + "/unused/3D/scene.c4d");

    var datItem = { name: "data.json", path: "D:/Data/data.json" };
    var rDat = PardPremiereCopyEngine.resolveUnusedDestination(datItem, normWs);
    check("данные маршрутизируются в unused/DATA", rDat.destPath, normWs + "/unused/DATA/data.json");

    var othItem = { name: "archive.zip", path: "D:/Archive/archive.zip" };
    var rOth = PardPremiereCopyEngine.resolveUnusedDestination(othItem, normWs);
    check("прочее маршрутизируется в unused/OTHER", rOth.destPath, normWs + "/unused/OTHER/archive.zip");

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
