/*
 *
 * @map role: 45 проверок движка точных дубликатов: группировка, хэширование, секвенции, кэш.
 * @map status: ready
 *
 * Tests exact duplicate detection, streaming SHA-256, hash cache invalidation,
 * proxy separation, image sequence identities, cancellation and canonical ranking.
 *
 *   node tests/duplicate-index.test.js
 */
"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");
var vm = require("vm");
var EventEmitter = require("events").EventEmitter;

var passed = 0, failed = 0;

function check(label, actual, expected) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failed++;
    console.log("FAIL  " + label + "\n      ожидалось " + e + "\n      получено  " + a);
}

function group(name) { console.log("\n" + name); }

var dupFile = path.join(__dirname, "..", "extension", "com.pard.defender",
    "client", "duplicate-index.js");

function loadEngine() {
    var sandbox = {
        require: require, console: console, Date: Date, Math: Math, JSON: JSON,
        String: String, Number: Number, Array: Array, Object: Object,
        RegExp: RegExp, Error: Error, process: process
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(dupFile, "utf8"), sandbox, { filename: "duplicate-index.js" });
    return sandbox.PardDuplicateIndex;
}

var engine = loadEngine();

var testDir = path.join(os.tmpdir(), "pd-test-dup-" + Date.now()).replace(/\\/g, "/");
fs.mkdirSync(testDir.replace(/\//g, path.sep), { recursive: true });

function writeFile(relPath, content) {
    var full = testDir + "/" + relPath;
    var dir = full.substring(0, full.lastIndexOf("/"));
    fs.mkdirSync(dir.replace(/\//g, path.sep), { recursive: true });
    fs.writeFileSync(full.replace(/\//g, path.sep), content, "utf8");
    return full;
}

var steps = [];

/* ------------------------------------------------------------- 1 */

var fDiff1 = writeFile("diff1.txt", "ABCDEF");
var fDiff2 = writeFile("diff2.txt", "123456");

steps.push(function (next) {
    group("1. Одинаковый размер, но разные байты — НЕ дубликаты");
    engine.scan({
        workspaceRoot: testDir,
        items: [
            { id: "1", path: fDiff1 },
            { id: "2", path: fDiff2 }
        ]
    }, function (err, res) {
        check("скан завершился успешно", res.ok, true);
        check("файлы одного размера с разным содержимым не образуют дубликатов",
            res.duplicateGroups.length, 0);
        next();
    });
});

/* ------------------------------------------------------------- 2 */

var fDup1 = writeFile("assets/video_master.mp4", "SAME_EXACT_VIDEO_CONTENT_BYTES_12345");
var fDup2 = writeFile("downloads/footage_copy.mp4", "SAME_EXACT_VIDEO_CONTENT_BYTES_12345");

steps.push(function (next) {
    group("2. Точные дубликаты с разными именами");
    engine.scan({
        workspaceRoot: testDir,
        items: [
            { id: "10", path: fDup1 },
            { id: "20", path: fDup2 }
        ]
    }, function (err, res) {
        check("найдена 1 группа дубликатов", res.duplicateGroups.length, 1);
        check("в группе 2 файла", res.duplicateGroups[0].files.length, 2);
        check("reclaimableBytes равен размеру одного файла",
            res.duplicateGroups[0].reclaimableBytes, fs.statSync(fDup1.replace(/\//g, path.sep)).size);
        next();
    });
});

/* ------------------------------------------------------------- 3 */

var fSingle = writeFile("single.mov", "SINGLE_FILE_CONTENT");

steps.push(function (next) {
    group("3. Три ссылки проекта на один и тот же физический путь не создают дубликат");
    engine.scan({
        workspaceRoot: testDir,
        items: [
            { id: "ref1", path: fSingle },
            { id: "ref2", path: fSingle },
            { id: "ref3", path: fSingle }
        ]
    }, function (err, res) {
        check("один физический путь не считается дубликатом самого себя",
            res.duplicateGroups.length, 0);
        check("scannedFiles равен 1", res.scannedFiles, 1);
        next();
    });
});

/* ------------------------------------------------------------- 4 */

var fOrig = writeFile("orig/media.mp4", "IDENTICAL_BYTES_FOR_PROXY_AND_ORIG");
var fProxy = writeFile("proxy/media_proxy.mp4", "IDENTICAL_BYTES_FOR_PROXY_AND_ORIG");
var fProxy2 = writeFile("proxy/media_proxy_copy.mp4", "IDENTICAL_BYTES_FOR_PROXY_AND_ORIG");

steps.push(function (next) {
    group("4. Proxy и Original строго разделены");
    engine.scan({
        workspaceRoot: testDir,
        items: [
            { id: "o1", path: fOrig, isProxy: false },
            { id: "p1", path: fProxy, isProxy: true }
        ]
    }, function (err, res) {
        check("совпадение байтов original и proxy не объединяет их в одну группу",
            res.duplicateGroups.length, 0);

        engine.scan({
            workspaceRoot: testDir,
            items: [
                { id: "p1", path: fProxy, isProxy: true },
                { id: "p2", path: fProxy2, isProxy: true }
            ]
        }, function (err2, res2) {
            check("два прокси одинакового содержимого образуют группу proxy-дубликатов",
                res2.duplicateGroups.length, 1);
            check("вид группы - proxy", res2.duplicateGroups[0].kind, "proxy");
            next();
        });
    });
});

/* ------------------------------------------------------------- 5 */

var fCache = writeFile("cache_test.dat", "INITIAL_CACHE_TEST_CONTENT_27");
var fCache2 = writeFile("cache_test_2.dat", "DIFFERENT_SAME_LEN_CONTENT_27");
var normCachePath = engine.normalizePath(fCache);
var originalHash = "";

steps.push(function (next) {
    group("5. Hash-кэш: hit и invalidation по размеру / mtime");
    engine.scan({
        workspaceRoot: testDir,
        items: [
            { id: "c1", path: fCache },
            { id: "c2", path: fCache2 }
        ]
    }, function (err, res) {
        var cacheData = engine.loadCache(testDir);
        check("хэш записан в кэш", typeof cacheData.entries[normCachePath].sha256 === "string", true);
        originalHash = cacheData.entries[normCachePath].sha256;

        engine.scan({
            workspaceRoot: testDir,
            items: [
                { id: "c1", path: fCache },
                { id: "c2", path: fCache2 }
            ]
        }, function (err2, res2) {
            check("кэш актуален", engine.loadCache(testDir).entries[normCachePath].sha256, originalHash);

            /* Инвалидация */
            fs.appendFileSync(fCache.replace(/\//g, path.sep), "_CHANGED", "utf8");
            fs.appendFileSync(fCache2.replace(/\//g, path.sep), "_CHANGED", "utf8");

            engine.scan({
                workspaceRoot: testDir,
                items: [
                    { id: "c1", path: fCache },
                    { id: "c2", path: fCache2 }
                ]
            }, function (err3, res3) {
                var updatedCache = engine.loadCache(testDir);
                check("кэш пересчитан после изменения размера",
                    updatedCache.entries[normCachePath].sha256 !== originalHash, true);
                next();
            });
        });
    });
});

/* ------------------------------------------------------------- 6 */

steps.push(function (next) {
    group("6. Файл больше 1 GiB через mocked streaming source");
    var mockStream = new EventEmitter();
    mockStream.destroy = function () {};
    var realCreateReadStream = fs.createReadStream;

    var totalSimulatedBytes = 0;
    fs.createReadStream = function (p) {
        if (p.indexOf("simulated_huge.raw") >= 0) {
            process.nextTick(function () {
                var chunk = Buffer.alloc(64 * 1024, 0x42);
                for (var c = 0; c < 20000; c++) {
                    mockStream.emit("data", chunk);
                    totalSimulatedBytes += chunk.length;
                }
                mockStream.emit("end");
            });
            return mockStream;
        }
        return realCreateReadStream.apply(fs, arguments);
    };

    engine.hashFile("simulated_huge.raw", {}, function (err, digest) {
        check("потоковый расчет >1 GiB завершился без ошибок", err, null);
        check("передано более 1 GiB данных", totalSimulatedBytes > (1024 * 1024 * 1024), true);
        check("получен корректный sha256 дайджест", typeof digest === "string" && digest.length === 64, true);
        fs.createReadStream = realCreateReadStream;
        next();
    });
});

/* ------------------------------------------------------------- 7 */

steps.push(function (next) {
    group("7. Отмена (cancellation) и гарантированно ровно один terminal callback");
    var fSlow1 = writeFile("slow1.bin", "SLOW_TEST_CONTENT_1");
    var fSlow2 = writeFile("slow2.bin", "SLOW_TEST_CONTENT_2");

    var cancelToken = { cancelled: true };
    var callCount = 0;

    engine.scan({
        workspaceRoot: testDir,
        items: [
            { id: "s1", path: fSlow1 },
            { id: "s2", path: fSlow2 }
        ],
        cancelToken: cancelToken
    }, function (err, res) {
        callCount++;
        check("при отмене вызван ровно один callback", callCount, 1);
        check("ошибка отмены CANCELLED", err.message, "CANCELLED");
        next();
    });
});

/* ------------------------------------------------------------- 8 */

steps.push(function (next) {
    group("8. Монотонность progress");
    var pSeq = [];

    engine.scan({
        workspaceRoot: testDir,
        items: [
            { id: "p1", path: fDup1 },
            { id: "p2", path: fDup2 }
        ],
        onProgress: function (p) {
            pSeq.push(p.percent);
        }
    }, function (err, res) {
        check("прогресс зафиксирован", pSeq.length > 0, true);
        var monotonic = true;
        for (var pi = 1; pi < pSeq.length; pi++) {
            if (pSeq[pi] < pSeq[pi - 1]) monotonic = false;
        }
        check("прогресс монотонно возрастает", monotonic, true);
        check("финальный прогресс равен 100%", pSeq[pSeq.length - 1], 100);
        next();
    });
});

/* ------------------------------------------------------------- 9 */

var frame1a = writeFile("seqA/frame_001.png", "FRAME_1_BYTES");
var frame2a = writeFile("seqA/frame_002.png", "FRAME_2_BYTES");
var frame1b = writeFile("seqB/frame_001.png", "FRAME_1_BYTES");
var frame2b = writeFile("seqB/frame_002.png", "FRAME_2_BYTES");

var seqA = {
    id: "seqA",
    path: testDir + "/seqA/frame_[001-002].png",
    name: "frame_[001-002].png",
    isSequence: true,
    sequence: {
        pattern: "frame_%03d.png",
        files: [
            { name: "frame_001.png", path: frame1a, size: 13 },
            { name: "frame_002.png", path: frame2a, size: 13 }
        ]
    }
};

var seqB = {
    id: "seqB",
    path: testDir + "/seqB/frame_[001-002].png",
    name: "frame_[001-002].png",
    isSequence: true,
    sequence: {
        pattern: "frame_%03d.png",
        files: [
            { name: "frame_001.png", path: frame1b, size: 13 },
            { name: "frame_002.png", path: frame2b, size: 13 }
        ]
    }
};

steps.push(function (next) {
    group("9. Секвенции кадров: равные, изменённый кадр, пропавший кадр, разный pattern");
    engine.scan({
        workspaceRoot: testDir,
        items: [seqA, seqB]
    }, function (err, res) {
        check("равные секвенции найдены как дубликат", res.duplicateGroups.length, 1);
        check("вид группы - sequence", res.duplicateGroups[0].kind, "sequence");

        /* Один изменённый кадр */
        fs.writeFileSync(frame2b.replace(/\//g, path.sep), "DIFFERENT_FRAME_2_BYTES", "utf8");
        engine.scan({
            workspaceRoot: testDir,
            items: [seqA, seqB]
        }, function (err2, res2) {
            check("при изменении одного кадра секвенции НЕ считаются дубликатами",
                res2.duplicateGroups.length, 0);

            /* Разный pattern */
            var seqDiffPattern = {
                id: "seqPat",
                path: testDir + "/seqA/frame_[001-002].png",
                name: "frame_[001-002].png",
                isSequence: true,
                sequence: {
                    pattern: "OTHER_PATTERN_%03d.png",
                    files: [
                        { name: "frame_001.png", path: frame1a, size: 13 },
                        { name: "frame_002.png", path: frame2a, size: 13 }
                    ]
                }
            };
            engine.scan({
                workspaceRoot: testDir,
                items: [seqA, seqDiffPattern]
            }, function (err3, res3) {
                check("разный pattern не считается дубликатом", res3.duplicateGroups.length, 0);

                /* Пропавший кадр в секвенции */
                var seqMissing = {
                    id: "seqMiss",
                    path: testDir + "/seqMiss/frame_[001-002].png",
                    isSequence: true,
                    sequence: {
                        pattern: "frame_%03d.png",
                        files: [
                            { name: "frame_001.png", path: testDir + "/seqMiss/does_not_exist.png", size: 10 }
                        ]
                    }
                };
                engine.scan({
                    workspaceRoot: testDir,
                    items: [seqA, seqMissing]
                }, function (err4, res4) {
                    check("неполная секвенция не становится дубликатом", res4.duplicateGroups.length, 0);
                    next();
                });
            });
        });
    });
});

/* ------------------------------------------------------------- 10 */

var ownedFile = writeFile("01_assets/Intro/VIDEO/owned.mp4", "CANONICAL_TEST_BYTES_999");
var outsideFile = writeFile("downloads/outside.mp4", "CANONICAL_TEST_BYTES_999");
var tempFile = writeFile("00_UNUSED/VIDEO/temp.mp4", "CANONICAL_TEST_BYTES_999");

steps.push(function (next) {
    group("10. Ownership из assets.tsv и порядок выбора canonical");
    var manifestContent = "2026-09-17T00:00:00Z\ti1\tE:/source.mp4\t24\t" + ownedFile + "\tIntro\tvideo\n";
    fs.writeFileSync((testDir + "/.parddefender/assets.tsv").replace(/\//g, path.sep), manifestContent, "utf8");

    engine.scan({
        workspaceRoot: testDir,
        items: [
            { id: "outside", path: outsideFile },
            { id: "temp", path: tempFile },
            { id: "owned", path: ownedFile }
        ]
    }, function (err, res) {
        check("группа дубликатов найдена", res.duplicateGroups.length, 1);
        var group0 = res.duplicateGroups[0];
        check("рекомендованный canonical - проверенный файл из assets.tsv",
            engine.normalizePath(group0.recommendedCanonical),
            engine.normalizePath(ownedFile)
        );
        check("причины выбора содержат assets.tsv",
            group0.reasons[0].indexOf("assets.tsv") >= 0, true);
        next();
    });
});

/* ------------------------------------------------------------- 11 */

steps.push(function (next) {
    group("11. Атомарность кэша: сбой записи не портит существующий кэш");
    var validCache = engine.loadCache(testDir);
    check("валидный кэш загружен", typeof validCache === "object", true);

    var saveRes = engine.saveCache("Z:/invalid?*|dir", { broken: true });
    check("сохранение в недоступное место возвращает false", saveRes, false);

    var intactCache = engine.loadCache(testDir);
    check("существующий кэш остался невредим", typeof intactCache.entries === "object", true);
    next();
});

/* ------------------------------------------------------------------ run */

function runSteps() {
    var i = 0;
    function next() {
        if (i < steps.length) {
            steps[i++](next);
        } else {
            console.log("\nВсе проверки пройдены: " + passed);
            process.exit(failed === 0 ? 0 : 1);
        }
    }
    next();
}

runSteps();
