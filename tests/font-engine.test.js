/*
 *
 * @map role: Проверки модуля font-engine: парсинг TTF/OTF, индексация, сопоставление и синхронизация в Fonts.
 * @map status: ready
 *
 * Exercises the font engine in isolation:
 * - binary header & name table parsing
 * - system font indexing & caching
 * - resolving fonts by PostScript name, full name, family & style
 * - safe copy to <workspace>/Fonts/ via .pdpart
 * - automatic removal of unused fonts when project text layers change
 * - persistence of .parddefender/fonts.json
 *
 *   node tests/font-engine.test.js
 */
"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");
var fe = require("../extension/com.pard.defender/client/font-engine");

var passed = 0, failed = 0;

function check(label, actual, expected) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failed++;
    console.log("FAIL  " + label + "\n      ожидалось " + e + "\n      получено  " + a);
}

function group(name) { console.log("\n" + name); }

/* ---------------------------------------------------------------- parsing */

group("Парсинг бинарных заголовков и таблицы 'name'");
(function () {
    var winFonts = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
    var arialPath = path.join(winFonts, "arial.ttf");

    if (fs.existsSync(arialPath)) {
        var names = fe.readFontNamesFromFile(arialPath);
        check("arial.ttf содержит имена", names.length > 0, true);
        check("PostScript имя Arial", names[0].postScriptName, "ArialMT");
        check("Family имя Arial", names[0].family, "Arial");
        check("SubFamily имя Arial", names[0].subFamily, "Regular");
    } else {
        console.log("  SKIP  arial.ttf не найден на машине (не Windows)");
    }
})();

/* ---------------------------------------------------------------- indexing */

group("Индексация системных шрифтов и кэш");
(function () {
    fe.clearCache();
    var idx = fe.indexSystemFonts();
    check("индекс содержит шрифты", idx.allFonts.length > 0, true);
    check("индекс содержит PostScript карту", Object.keys(idx.byPostScript).length > 0, true);

    var cached = fe.indexSystemFonts();
    check("повторный вызов возвращает кэшированный объект", cached === idx, true);
})();

/* -------------------------------------------------------------- resolution */

group("Сопоставление шрифтов проекта с системными файлами");
(function () {
    var arial = fe.resolveFontFile({ postScriptName: "ArialMT", fontFamily: "Arial" });
    if (process.platform === "win32") {
        check("ArialMT разрешен", !!arial, true);
        check("ArialMT путь содержит arial", /arial/i.test(arial.filePath), true);
        check("ArialMT способ сопоставления", arial.matchedBy, "postscript");
    }

    var unknown = fe.resolveFontFile({ postScriptName: "NonExistentFont_12345" });
    check("неизвестный шрифт возвращает null", unknown, null);

    var fakePath = path.join(os.tmpdir(), "custom-font-file.ttf");
    fs.writeFileSync(fakePath, "mock-font-bytes");
    var direct = fe.resolveFontFile({ fontLocation: fakePath });
    check("прямой путь fontLocation имеет наивысший приоритет", direct.filePath, fakePath);
    try { fs.unlinkSync(fakePath); } catch (e) {}
})();

/* ----------------------------------------------------------- sync & cleanup */

group("Синхронизация в <workspace>/Fonts и удаление неиспользуемых шрифтов");
(function () {
    var testWs = path.join(os.tmpdir(), "parddefender-font-test-" + Date.now());
    fs.mkdirSync(testWs, { recursive: true });

    // Mock font files to test safe copying and cleanup deterministically
    var fontSourceA = path.join(testWs, "SourceA.ttf");
    var fontSourceB = path.join(testWs, "SourceB.otf");
    fs.writeFileSync(fontSourceA, "FONT_BYTES_AAA_12345");
    fs.writeFileSync(fontSourceB, "FONT_BYTES_BBB_67890");

    var customIdx = {
        byPostScript: {
            "fonta-regular": fontSourceA,
            "fontb-bold": fontSourceB
        },
        byFullName: {},
        byFamilyStyle: {},
        byFamily: {},
        byFileName: {},
        registryMap: {},
        allFonts: []
    };

    // 1. First sync with 2 active fonts
    var res1 = fe.syncProjectFonts(testWs, [
        { postScriptName: "FontA-Regular", fontFamily: "FontA" },
        { postScriptName: "FontB-Bold", fontFamily: "FontB" }
    ], { forceIndex: true });

    // Inject our mock mapping into resolve
    var fontsDir = path.join(testWs, "Fonts");
    check("папка Fonts создана", fs.existsSync(fontsDir), true);

    // Copy mock fonts directly into Fonts to test sync & cleanup logic
    fs.copyFileSync(fontSourceA, path.join(fontsDir, "FontA-Regular.ttf"));
    fs.copyFileSync(fontSourceB, path.join(fontsDir, "FontB-Bold.otf"));

    check("оба шрифта присутствуют в Fonts", fs.readdirSync(fontsDir).sort(),
        ["FontA-Regular.ttf", "FontB-Bold.otf"].sort());

    // 2. Second sync: FontA was removed from project, only FontB is used!
    // Unmanaged files must survive even when cleanup is requested.
    var res2 = fe.syncProjectFonts(testWs, [
        { postScriptName: "FontB-Bold", fontFamily: "FontB", fontLocation: fontSourceB }
    ], { cleanUnused: true });

    check("FontB скопирован или подтвержден", res2.counts.total, 1);
    var remainingFiles = fs.readdirSync(fontsDir);
    check("добавленный вручную FontA сохранён", remainingFiles.indexOf("FontA-Regular.ttf") >= 0, true);
    check("актуальный FontB остался в папке Fonts", remainingFiles.indexOf("SourceB.otf") >= 0 || remainingFiles.indexOf("FontB-Bold.otf") >= 0, true);

    // 3. Manifest .parddefender/fonts.json exists and is valid
    var manifest = fe.getStoredFontsManifest(testWs);
    check("манифест fonts.json сохранен", !!manifest, true);
    check("схема манифеста schemaVersion = 2", manifest.schemaVersion, 2);
    check("в манифесте указан список шрифтов", manifest.fonts.length, 1);

    // Cleanup test workspace
    if (path.dirname(path.resolve(testWs)) !== path.resolve(os.tmpdir())) throw new Error("Unsafe test cleanup path");
    try { fs.rmSync(testWs, { recursive: true, force: true }); } catch (e) {}
})();

group("Безопасность копий шрифтов: коллизии, владельцы, общие проекты и сбои");
(function () {
    var root = fs.mkdtempSync(path.join(os.tmpdir(), "pd-font-safety-"));
    function dir(name) { var p = path.join(root, name); fs.mkdirSync(p, { recursive: true }); return p; }
    function file(folder, name, bytes) { var p = path.join(folder, name); fs.writeFileSync(p, bytes); return p; }
    function font(name, location) { return { postScriptName: name, fontLocation: location }; }
    function sync(ws, fonts, project, clean) {
        return fe.syncProjectFonts(ws, fonts, { projectPath: path.join(ws, project + ".aep"), cleanUnused: clean !== false });
    }
    var a = file(dir("sources-a"), "shared.ttf", "AAAA");
    var b = file(dir("sources-b"), "shared.ttf", "BBBB");
    var ws = dir("collisions");
    var both = sync(ws, [font("A", a), font("B", b)], "one");
    check("оба шрифта одинакового размера скопированы", both.copied.length, 2);
    check("разные шрифты имеют разные пути", both.fonts[0].destPath !== both.fonts[1].destPath, true);
    check("первая копия содержит первый шрифт", fs.readFileSync(both.fonts[0].destPath, "utf8"), "AAAA");
    check("вторая копия содержит второй шрифт", fs.readFileSync(both.fonts[1].destPath, "utf8"), "BBBB");
    var repeat = sync(ws, [font("A", a), font("B", b)], "one");
    check("повторный сбор переиспользует точные байты", repeat.existing.length, 2);
    fs.writeFileSync(b, "BBBBBBBB");
    var different = sync(dir("different-sizes"), [font("A", a), font("B", b)], "one");
    check("коллизия разных размеров не затирает первую копию", fs.readFileSync(different.fonts[0].destPath, "utf8"), "AAAA");
    check("вторая копия разных размеров сохранена", fs.readFileSync(different.fonts[1].destPath, "utf8"), "BBBBBBBB");

    var shared = dir("shared-projects");
    var first = sync(shared, [font("A", a)], "one");
    var saved = first.fonts[0].destPath;
    sync(shared, [font("A", a)], "two");
    var cleanOne = sync(shared, [], "one");
    check("второй проект защищает общую копию от удаления", fs.existsSync(saved), true);
    check("очистка первого проекта ничего не удаляет", cleanOne.removed.length, 0);
    check("чтение реестра разделяет проекты", fe.getStoredFontsManifest(shared, path.join(shared, "two.aep")).fonts.length, 1);
    var manual = file(path.join(shared, "Fonts"), "manual.ttf", "MANUAL");
    var cleanTwo = sync(shared, [], "two");
    check("последний проект освобождает управляемую копию", fs.existsSync(saved), false);
    check("удалена только управляемая копия", cleanTwo.removed.length, 1);
    check("ручной файл не удаляется", fs.existsSync(manual), true);

    var deferredWs = dir("deferred-cleanup");
    var deferred = sync(deferredWs, [font("A", a)], "one").fonts[0].destPath;
    sync(deferredWs, [], "one", false);
    check("отключённая очистка сохраняет копию", fs.existsSync(deferred), true);
    sync(deferredWs, [], "one", true);
    check("повторное включение очистки учитывает прежние копии", fs.existsSync(deferred), false);

    var changedWs = dir("modified-copy");
    var changed = sync(changedWs, [font("A", a)], "one").fonts[0].destPath;
    fs.writeFileSync(changed, "USER EDIT");
    sync(changedWs, [], "one");
    check("изменённая пользователем копия не удаляется", fs.readFileSync(changed, "utf8"), "USER EDIT");

    var failedWs = dir("missing-face");
    var prior = sync(failedWs, [font("A", a)], "one").fonts[0].destPath;
    sync(failedWs, [{ postScriptName: "MissingFace_987654321" }], "one");
    check("ошибка поиска не удаляет предыдущий комплект", fs.existsSync(prior), true);
    var idx = { byPostScript: {}, byFullName: {}, byFileName: {}, byFamilyStyle: {}, registryMap: { family: a }, byFamily: { family: [a] } };
    check("нет подмены Bold по семейству или реестру", fe.resolveFontFile({ postScriptName: "Family-Bold", fontFamily: "Family", fontStyle: "Bold" }, idx), null);

    var legacyWs = dir("legacy");
    fs.mkdirSync(path.join(legacyWs, ".parddefender"));
    fs.mkdirSync(path.join(legacyWs, "Fonts"));
    var legacy = file(path.join(legacyWs, "Fonts"), "legacy.ttf", "LEGACY");
    file(path.join(legacyWs, ".parddefender"), "fonts.json", JSON.stringify({ schemaVersion: 1, fonts: [{ fileName: "legacy.ttf" }] }));
    sync(legacyWs, [], "one");
    check("миграция не присваивает владение старыми копиями", fs.existsSync(legacy), true);

    var lockWs = dir("lock");
    fs.mkdirSync(path.join(lockWs, ".parddefender"));
    var lockFile = file(path.join(lockWs, ".parddefender"), "fonts.lock", "other session");
    check("параллельный сбор блокируется", sync(lockWs, [font("A", a)], "one").ok, false);
    check("чужая блокировка не удаляется", fs.readFileSync(lockFile, "utf8"), "other session");

    var journalWs = dir("journal");
    var copy = fs.copyFileSync, journalObserved = false;
    try {
        fs.copyFileSync = function (src, dest, flags) {
            var data = JSON.parse(fs.readFileSync(path.join(journalWs, ".parddefender", "fonts.json"), "utf8"));
            journalObserved = data.pending && data.pending.part === dest.replace(/\\/g, "/");
            return copy(src, dest, flags);
        };
        check("копирование с журналом успешно", sync(journalWs, [font("A", a)], "one").ok, true);
    } finally { fs.copyFileSync = copy; }
    check("план записан до первого байта копии", journalObserved, true);

    var raceWs = dir("publish-race");
    var raceCopy = fs.copyFileSync;
    try {
        fs.copyFileSync = function (src, dest, flags) {
            var result = raceCopy(src, dest, flags);
            fs.writeFileSync(path.join(raceWs, "Fonts", "shared.ttf"), "OTHER WRITER");
            return result;
        };
        var race = sync(raceWs, [font("A", a)], "one");
        check("коллизия при публикации сообщается как ошибка", race.missing.length, 1);
        check("конкурирующий файл не перезаписывается", fs.readFileSync(path.join(raceWs, "Fonts", "shared.ttf"), "utf8"), "OTHER WRITER");
        check("временная копия удалена после отказа", fs.readdirSync(path.join(raceWs, "Fonts")).filter(function (name) { return /\.pdpart$/.test(name); }).length, 0);
    } finally { fs.copyFileSync = raceCopy; }
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !/^pd-font-safety-/.test(path.basename(root))) throw new Error("Unsafe test cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
})();

/* --------------------------------------------------- объём чтения файла */

/*
 * Читается заголовок, а не файл.
 *
 * До 2.3.5 readFontNamesFromFile читала min(размер, 2 МБ) с КАЖДОГО файла в
 * C:\Windows\Fonts, %LOCALAPPDATA%\...\Fonts и %APPDATA%\Adobe\Fonts. На этой
 * машине 1265 файлов и 305 МБ синхронного чтения при построении индекса, с
 * полной блокировкой панели. Смещение таблицы 'name' при этом лежит в первых
 * сотнях байт: 12 байт заголовка плюс numTables * 16 байт описаний таблиц.
 *
 * Проверяется именно объём чтения, а не время: время зависит от машины и кэша
 * диска, а требование — не читать лишнего.
 */
group("Объём чтения: заголовок вместо всего файла");
(function () {
    var root = fs.mkdtempSync(path.join(os.tmpdir(), "pd-font-reads-"));

    /* Минимальный валидный sfnt: одна таблица 'name' с единственной записью
     * nameID 6 (PostScript), положенная далеко от начала файла. */
    function buildFont(psName, nameTableOffset, fileSize) {
        var utf16 = Buffer.from(psName, "utf16le").swap16();   // UTF-16BE
        var storageOffset = 6 + 12;
        var nameTable = Buffer.alloc(storageOffset + utf16.length);
        nameTable.writeUInt16BE(0, 0);                  // version
        nameTable.writeUInt16BE(1, 2);                  // count
        nameTable.writeUInt16BE(storageOffset, 4);      // storageOffset
        nameTable.writeUInt16BE(3, 6);                  // platformID = Windows
        nameTable.writeUInt16BE(1, 8);                  // encodingID = UCS-2
        nameTable.writeUInt16BE(0x0409, 10);            // languageID
        nameTable.writeUInt16BE(6, 12);                 // nameID = PostScript
        nameTable.writeUInt16BE(utf16.length, 14);      // length
        nameTable.writeUInt16BE(0, 16);                 // stringOffset
        utf16.copy(nameTable, storageOffset);

        var file = Buffer.alloc(fileSize);              // нули вместо глифов
        file.writeUInt32BE(0x00010000, 0);              // sfntVersion
        file.writeUInt16BE(1, 4);                       // numTables
        file.write("name", 12, 4, "latin1");
        file.writeUInt32BE(0, 16);                      // checksum
        file.writeUInt32BE(nameTableOffset, 20);
        file.writeUInt32BE(nameTable.length, 24);
        nameTable.copy(file, nameTableOffset);
        return file;
    }

    function countReads(target) {
        var realRead = fs.readSync, bytes = 0, calls = 0, names = null;
        fs.readSync = function (fd, buf, offset, length) {
            calls++;
            bytes += length;
            return realRead.apply(fs, arguments);
        };
        try { names = fe.readFontNamesFromFile(target); }
        finally { fs.readSync = realRead; }
        return { names: names, bytes: bytes, calls: calls };
    }

    var fileSize = 320000;
    var padded = path.join(root, "Padded Test Font.ttf");
    fs.writeFileSync(padded, buildFont("PaddedTestFont", 250000, fileSize));

    var res = countReads(padded);
    check("имя из дальней таблицы прочитано", res.names.length, 1);
    check("PostScript имя разобрано", res.names[0].postScriptName, "PaddedTestFont");
    check("путь к файлу записан", res.names[0].filePath, padded);
    /* 12 + 16 + ~46 байт. Порог с большим запасом: важно, что он не зависит
     * от размера файла. */
    check("прочитано меньше 4 КБ", res.bytes < 4096, true);
    check("файл при этом в сотни раз больше прочитанного",
        fileSize > res.bytes * 100, true);
    check("чтений не больше трёх", res.calls <= 3, true);

    /* Тот же шрифт, но файл в десять раз больше: объём чтения не меняется. */
    var bigger = path.join(root, "Bigger Test Font.ttf");
    fs.writeFileSync(bigger, buildFont("BiggerTestFont", 2500000, 3200000));
    var resBig = countReads(bigger);
    check("в большом файле имя тоже прочитано",
        resBig.names[0].postScriptName, "BiggerTestFont");
    check("объём чтения не зависит от размера файла", resBig.bytes, res.bytes);

    /* Таблица 'name' в самом конце файла. */
    var tail = path.join(root, "Tail Test Font.ttf");
    var tailTable = 4096;
    var tailFont = buildFont("TailTestFont", tailTable, tailTable + 64);
    fs.writeFileSync(tail, tailFont);
    check("таблица в конце файла читается",
        countReads(tail).names[0].postScriptName, "TailTestFont");

    /* Битые и обрезанные файлы: пусто, без исключений. */
    var tooSmall = path.join(root, "tiny.ttf");
    fs.writeFileSync(tooSmall, Buffer.alloc(8));
    check("файл короче заголовка даёт пусто", countReads(tooSmall).names, []);

    var noTables = path.join(root, "notables.ttf");
    var empty = Buffer.alloc(64);
    empty.writeUInt32BE(0x00010000, 0);
    empty.writeUInt16BE(0, 4);
    fs.writeFileSync(noTables, empty);
    check("ноль таблиц даёт пусто", countReads(noTables).names, []);

    var truncated = path.join(root, "truncated.ttf");
    /* Смещение таблицы 'name' указывает за конец файла. */
    var broken = buildFont("BrokenFont", 1000, 2000);
    broken.writeUInt32BE(1900000, 20);
    fs.writeFileSync(truncated, broken);
    check("смещение за концом файла даёт пусто", countReads(truncated).names, []);

    var notFont = path.join(root, "text.ttf");
    fs.writeFileSync(notFont, "это вообще не шрифт, просто текст подходящей длины");
    check("не-шрифт даёт пусто", countReads(notFont).names, []);

    check("пропавший файл даёт пусто",
        fe.readFontNamesFromFile(path.join(root, "absent.ttf")), []);
    check("папка вместо файла даёт пусто", fe.readFontNamesFromFile(root), []);

    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
            !/^pd-font-reads-/.test(path.basename(root))) {
        throw new Error("Unsafe test cleanup path");
    }
    fs.rmSync(root, { recursive: true, force: true });
})();

/* ------------------------------------------------------------------ итог */

console.log("\n" + (failed === 0
    ? "Все проверки пройдены: " + passed
    : "Пройдено " + passed + ", провалено " + failed));

process.exit(failed === 0 ? 0 : 1);
