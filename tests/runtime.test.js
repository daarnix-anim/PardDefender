/*
 * Exercises the four client modules that decide what the owner sees and when
 * PardDefender tries again: the issue store, the counters, protected-file
 *
 * @map role: 102 проверки клиентских модулей: ошибки, метрики, сверка,
 *           обновления.
 * @map status: ready
 * verification, and update-version comparison.
 *
 * No network is touched. The updater is tested through its pure parts only.
 *
 *   node tests/runtime.test.js
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

var root = path.join(os.tmpdir(), "parddefender-runtime-" + Date.now())
    .replace(/\\/g, "/");
var workspace = root + "/Soul";

function loadModules() {
    var sandbox = {
        require: require, console: console, Date: Date, Math: Math, JSON: JSON,
        String: String, Number: Number, Array: Array, Object: Object,
        isNaN: isNaN, parseInt: parseInt, isFinite: isFinite, process: process,
        setInterval: setInterval, clearInterval: clearInterval,
        setTimeout: setTimeout, clearTimeout: clearTimeout
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);

    var dir = path.join(__dirname, "..", "extension", "com.pard.defender", "client");
    ["copy-queue.js", "issues.js", "stats.js", "verify.js", "housekeeping.js", "updater.js"]
        .forEach(function (name) {
            vm.runInContext(fs.readFileSync(path.join(dir, name), "utf8"),
                sandbox, { filename: name });
        });
    return sandbox;
}

var mod = loadModules();
var Issues = mod.PardIssues;
var Stats = mod.PardStats;
var Verify = mod.PardVerify;
var Updater = mod.PardUpdater;
var Queue = mod.PardCopyQueue;

fs.mkdirSync(workspace.replace(/\//g, path.sep), { recursive: true });

/* ------------------------------------------------------- классификация */

group("Классы ошибок");
check("занятый файл — временная", Issues.describe("SOURCE_BUSY").klass, "transient");
check("нет доступа — требует владельца", Issues.describe("ACCESS_DENIED").klass, "owner");
check("прокси — постоянная", Issues.describe("RELINK_PROXY").klass, "permanent");
check("нет места — системная", Issues.describe("DISK_FULL").klass, "system");
check("неизвестный код не роняет", Issues.describe("WAT").klass, "transient");
check("isSystem", [Issues.isSystem("DISK_FULL"), Issues.isSystem("SOURCE_BUSY")],
    [true, false]);

/* ------------------------------------------------------------- повторы */

group("Расписание повторов");
(function () {
    Issues.attach(workspace);

    /* record() mutates and returns the SAME object, so the scheduled time has
     * to be captured as a number before the next call overwrites it. */
    var first = Issues.record({
        key: "i1", id: "1", name: "clip.mp4", code: "SOURCE_BUSY", sourceSize: 100
    });
    var firstAttemptAt = first.nextAttemptAt;
    check("первая попытка засчитана", first.attempts, 1);
    check("повтор запланирован", first.nextAttemptAt > Date.now(), true);
    check("сразу повторять нельзя", Issues.isDue("i1"), false);

    var second = Issues.record({
        key: "i1", id: "1", name: "clip.mp4", code: "SOURCE_BUSY", sourceSize: 100
    });
    check("та же ситуация наращивает счётчик", second.attempts, 2);
    check("пауза растёт", second.nextAttemptAt - firstAttemptAt > 0, true);

    /* Пять шагов расписания, дальше — только вручную. */
    var i;
    for (i = 0; i < 6; i++) {
        Issues.record({
            key: "i1", id: "1", name: "clip.mp4", code: "SOURCE_BUSY", sourceSize: 100
        });
    }
    var exhausted = Issues.get("i1");
    check("расписание исчерпано", exhausted.nextAttemptAt, 0);
    check("помечено как требующее внимания", Issues.needsAttention(exhausted), true);

    /* Изменился размер исходника — это новая ситуация. */
    var reset = Issues.record({
        key: "i1", id: "1", name: "clip.mp4", code: "SOURCE_BUSY", sourceSize: 200
    });
    check("другой размер сбрасывает счётчик", reset.attempts, 1);

    /* Другой код — тоже новая ситуация. */
    var changed = Issues.record({
        key: "i1", id: "1", name: "clip.mp4", code: "ACCESS_DENIED", sourceSize: 200
    });
    check("другой код сбрасывает счётчик", changed.attempts, 1);
    check("класс обновился", changed.klass, "owner");
})();

group("Право на попытку");
(function () {
    Issues.attach(workspace);
    check("незнакомый элемент пробуем сразу", Issues.isDue("i99"), true);

    Issues.record({ key: "i2", id: "2", name: "a", code: "RELINK_PROXY" });
    check("постоянная — автоповтора нет", Issues.isDue("i2"), false);

    Issues.record({ key: "i3", id: "3", name: "b", code: "ACCESS_DENIED" });
    check("требует владельца — автоповтора нет", Issues.isDue("i3"), false);

    Issues.retryNow("i3");
    check("ручной повтор разрешает попытку", Issues.isDue("i3"), true);

    Issues.record({ key: "i4", id: "4", name: "c", code: "SOURCE_BUSY" });
    Issues.ignore("i4");
    check("скрытое не повторяем", Issues.isDue("i4"), false);
    check("скрытое не считается открытым", Issues.openCount(), 2);
})();

group("Уборка списка");
(function () {
    Issues.attach(workspace);
    Issues.record({ key: "i5", id: "5", name: "gone.mp4", code: "SOURCE_BUSY" });
    Issues.record({ key: "i6", id: "6", name: "here.mp4", code: "SOURCE_BUSY" });
    Issues.record({ key: "sys:DISK_FULL", id: "", name: "Авто", code: "DISK_FULL" });

    var removed = Issues.pruneMissing({ i6: true });
    check("удалён элемент выпадает из списка", removed, 1);
    check("оставшийся на месте", !!Issues.get("i6"), true);
    check("системная строка не выпадает по этому правилу",
        !!Issues.get("sys:DISK_FULL"), true);
})();

group("Сортировка по важности");
(function () {
    Issues.attach(workspace);
    Issues.record({ key: "a", id: "1", name: "a", code: "RELINK_PROXY" });
    Issues.record({ key: "b", id: "2", name: "b", code: "SOURCE_BUSY" });
    Issues.record({ key: "c", id: "3", name: "c", code: "DISK_FULL" });
    Issues.record({ key: "d", id: "4", name: "d", code: "ACCESS_DENIED" });

    check("системная, затем владелец, затем временная, затем постоянная",
        Issues.all().map(function (r) { return r.klass; }),
        ["system", "owner", "transient", "permanent"]);
})();

/* ------------------------------------------------------- предохранитель */

group("Предохранитель");
(function () {
    check("две однотипных не срывают",
        Issues.evaluateBreaker([
            { ok: false, code: "SOURCE_BUSY" },
            { ok: false, code: "SOURCE_BUSY" },
            { ok: true }
        ], 3).tripped, false);

    var tripped = Issues.evaluateBreaker([
        { ok: false, code: "SOURCE_BUSY" },
        { ok: true },
        { ok: false, code: "SOURCE_BUSY" },
        { ok: false, code: "SOURCE_BUSY" }
    ], 3);
    check("три однотипных срывают", tripped.tripped, true);
    check("код назван", tripped.code, "SOURCE_BUSY");

    check("разные коды не складываются",
        Issues.evaluateBreaker([
            { ok: false, code: "SOURCE_BUSY" },
            { ok: false, code: "ACCESS_DENIED" },
            { ok: false, code: "SIZE_MISMATCH" }
        ], 3).tripped, false);

    var system = Issues.evaluateBreaker([{ ok: false, code: "DISK_FULL" }], 3);
    check("системная ошибка срывает с первой", system.tripped, true);
    check("причина по-русски", system.reason, "на диске не хватает места");
})();

group("Сохранение проблем");
(function () {
    Issues.attach(workspace);
    Issues.record({
        key: "i7", id: "7", name: "keep.mp4", code: "ACCESS_DENIED", sourceSize: 42
    });
    Issues.save();

    Issues.attach(workspace);
    var restored = Issues.get("i7");
    check("строка пережила перезапуск", !!restored, true);
    check("имя сохранено", restored.name, "keep.mp4");
    check("класс восстановлен", restored.klass, "owner");
    check("счётчик попыток сохранён", restored.attempts, 1);
})();

/* ------------------------------------------------------------- метрики */

group("Накопительные метрики");
(function () {
    Stats.attach(workspace);
    Stats.add({ filesProcessed: 3, bytesCopied: 1000, filesReused: 1, bytesSaved: 500 });
    Stats.markPass();
    Stats.save();

    var total = Stats.total();
    check("файлы посчитаны", total.filesProcessed, 3);
    check("байты посчитаны", total.bytesCopied, 1000);
    check("проход отмечен", total.passes, 1);
    check("за сессию столько же", Stats.session().filesProcessed, 3);

    /* Новая сессия:总 накапливается, сессионная дельта обнуляется. */
    Stats.attach(workspace);
    check("итог пережил перезапуск", Stats.total().filesProcessed, 3);
    check("сессия началась с нуля", Stats.session().filesProcessed, 0);

    Stats.add({ filesProcessed: 2 });
    check("итог растёт", Stats.total().filesProcessed, 5);
    check("сессия считает только новое", Stats.session().filesProcessed, 2);

    Stats.add({ somethingUnknown: 5 });
    check("неизвестный ключ игнорируется",
        Stats.total().somethingUnknown === undefined, true);
})();

/* -------------------------------------------------------------- сверка */

group("Сверка защищённых файлов");
(function () {
    var assetDir = workspace + "/01_assets/Intro/VIDEO";
    fs.mkdirSync(assetDir.replace(/\//g, path.sep), { recursive: true });

    var goodPath = assetDir + "/good.mp4";
    var changedPath = assetDir + "/changed.mp4";
    fs.writeFileSync(goodPath.replace(/\//g, path.sep), "12345");
    fs.writeFileSync(changedPath.replace(/\//g, path.sep), "1234567890");

    /* Манифест утверждает, что changed.mp4 был на 5 байт. */
    Queue.writeText(workspace + "/.parddefender/assets.tsv", [
        ["2026-08-28", "1", "E:/src/good.mp4", "5", goodPath, "Intro", "video"].join("\t"),
        ["2026-08-28", "2", "E:/src/changed.mp4", "5", changedPath, "Intro", "video"].join("\t"),
        ["2026-08-28", "3", "E:/src/gone.mp4", "5", assetDir + "/gone.mp4", "Intro", "video"]
            .join("\t")
    ].join("\n") + "\n");

    Verify.attach(workspace);
    check("манифест прочитан", Verify.manifestSize(), 3);

    var items = [
        { id: "1", name: "good.mp4", path: goodPath, state: "protected", size: 5 },
        { id: "2", name: "changed.mp4", path: changedPath, state: "protected", size: 5 },
        { id: "3", name: "gone.mp4", path: assetDir + "/gone.mp4", state: "protected", size: 5 },
        { id: "4", name: "outside.mp4", path: "E:/x.mp4", state: "pending", size: 5 }
    ];

    var outcome = Verify.sweepAll(items);
    var codes = {};
    outcome.findings.forEach(function (f) { codes[f.name] = f.code; });

    check("целый файл не в находках", codes["good.mp4"] === undefined, true);
    check("изменившийся пойман", codes["changed.mp4"], "PROTECTED_CHANGED");
    check("пропавший пойман", codes["gone.mp4"], "PROTECTED_GONE");
    check("незащищённый не проверяется", codes["outside.mp4"] === undefined, true);
    check("проверено ровно три защищённых", outcome.checked, 3);
})();

group("Сверка идёт порциями");
(function () {
    var assetDir = workspace + "/01_assets/Bulk";
    fs.mkdirSync(assetDir.replace(/\//g, path.sep), { recursive: true });

    var items = [], i, p;
    for (i = 0; i < 10; i++) {
        p = assetDir + "/f" + i + ".mp4";
        fs.writeFileSync(p.replace(/\//g, path.sep), "x");
        items.push({ id: "b" + i, name: "f" + i, path: p, state: "protected", size: 1 });
    }

    Verify.attach(workspace);
    Verify.reset();
    check("первая порция ограничена бюджетом", Verify.sweep(items, 4).checked, 4);
    check("вторая порция продолжает с того же места", Verify.sweep(items, 4).checked, 4);
    var third = Verify.sweep(items, 4);
    check("третья добирает остаток и заворачивается", third.checked >= 2, true);
})();

/* ---------------------------------------------------------- обновления */

group("Сравнение версий");
check("новее по минорной", Updater.compareVersions("1.1.0", "1.0.0"), 1);
check("одинаковые", Updater.compareVersions("1.0.0", "1.0.0"), 0);
check("старее", Updater.compareVersions("0.9.9", "1.0.0"), -1);
check("числовое, не строковое: 1.10 > 1.9",
    Updater.compareVersions("1.10.0", "1.9.0"), 1);
check("префикс v не мешает", Updater.compareVersions("v1.2.0", "1.1.0"), 1);
check("короткая версия дополняется нулями",
    Updater.compareVersions("1.1", "1.1.0"), 0);

group("Однострочное описание релиза");
check("первая непустая строка",
    Updater.summaryFrom("Добавлены метрики и повторы.\n\nПодробности ниже."),
    "Добавлены метрики и повторы.");
check("markdown-разметка снимается",
    Updater.summaryFrom("## Что нового\n"), "Что нового");
check("маркер списка снимается",
    Updater.summaryFrom("- Починена сверка секвенций."),
    "Починена сверка секвенций.");
check("пустое тело не роняет",
    Updater.summaryFrom(""), "Подробности — на странице релиза.");
check("длинная строка обрезается",
    Updater.summaryFrom(new Array(300).join("a")).length, 160);

group("Источники обновления и безопасность URL");
(function () {
    check("свой хост разрешён",
        !!Updater.parseUrl("https://gist.githubusercontent.com/u/1/raw/f.json"), true);
    check("чужой хост отклонён",
        Updater.parseUrl("https://evil.example.com/f.json"), null);
    check("http отклонён",
        Updater.parseUrl("http://github.com/x"), null);
    check("подделка поддомена отклонена",
        Updater.parseUrl("https://github.com.evil.tld/x"), null);

    var feed = Updater.normalizeFeed({
        version: "v1.2.0",
        summary: "Добавлены метрики и повторы.",
        url: "https://evil.example.com/pwn"
    });
    check("версия нормализована", feed.version, "1.2.0");
    check("описание взято", feed.summary, "Добавлены метрики и повторы.");
    check("недоверенная ссылка заменена на страницу релизов",
        feed.url, "https://github.com/daarnix-anim/PardDefender/releases");

    var release = Updater.normalizeRelease({
        tag_name: "v1.3.0",
        body: "# Заголовок\nПервая строка описания.",
        html_url: "https://github.com/daarnix-anim/PardDefender/releases/tag/v1.3.0"
    });
    check("релиз: версия", release.version, "1.3.0");
    check("релиз: первая непустая строка как описание", release.summary, "Заголовок");
    check("релиз: своя ссылка сохранена",
        release.url, "https://github.com/daarnix-anim/PardDefender/releases/tag/v1.3.0");

    check("пустой ответ не роняет", Updater.normalizeFeed(null), null);
    check("ответ без версии не роняет", Updater.normalizeFeed({ summary: "x" }), null);
})();

group("Показывать ли баннер");
(function () {
    Updater.configure("1.0.0");
    var state = { dismissedVersion: "" };

    check("новее — показываем",
        !!Updater.evaluate({ version: "1.1.0", summary: "s" }, state), true);
    check("та же версия — молчим",
        Updater.evaluate({ version: "1.0.0", summary: "s" }, state), null);
    check("старее — молчим",
        Updater.evaluate({ version: "0.9.0", summary: "s" }, state), null);
    check("скрытая версия — молчим",
        Updater.evaluate({ version: "1.1.0", summary: "s" },
            { dismissedVersion: "1.1.0" }), null);
    check("следующая после скрытой — показываем",
        !!Updater.evaluate({ version: "1.2.0", summary: "s" },
            { dismissedVersion: "1.1.0" }), true);
})();

group("Показать в проводнике");
(function () {
    var House = mod.PardHousekeeping;
    var base = workspace + "/reveal тест";
    fs.mkdirSync(base.replace(/\//g, path.sep), { recursive: true });

    var present = base + "/clip name.mp4";
    fs.writeFileSync(present.replace(/\//g, path.sep), "x");

    /*
     * Регресс 2026-08-29: кнопка молча ничего не делала. explorer.exe
     * читает сырую командную строку, а Node берёт в кавычки весь аргумент с пробелами,
     * и ключ /select перестаёт распознаваться. Пробелы есть в каждом пути
     * этого проекта, поэтому кнопка не работала ни разу.
     */
    check("существующий файл с пробелами — выделяется",
        House.revealFile(present).code, "selected");
    check("пропавший файл, папка жива — говорим об этом",
        House.revealFile(base + "/удалён.mp4").code, "fileGone");
    check("нет ни файла, ни папки",
        House.revealFile(workspace + "/нету/ничего.mp4").code, "missing");
    check("пустой путь не роняет", House.revealFile("").code, "none");

    /* Кавычка или %VAR% в имени — открываем папку, а не рискуем командной строкой. */
    var percent = base + "/100%_готово.mp4";
    fs.writeFileSync(percent.replace(/\//g, path.sep), "x");
    check("опасное имя — только папка, без /select",
        House.revealFile(percent).code, "folder");

    check("старый reveal продолжает работать", House.reveal(present), true);
})();

group("Код DEST_BLOCKED");
(function () {
    check("класс — требует владельца",
        Issues.describe("DEST_BLOCKED").klass, "owner");
    check("не системная — не ставит весь режим на паузу",
        Issues.isSystem("DEST_BLOCKED"), false);

    Issues.attach(workspace);
    var r = Issues.record({
        key: "i90", id: "90", name: "blocked.mp4", code: "DEST_BLOCKED",
        path: "E:/src/blocked.mp4", destPath: "D:/ws/01_assets/A/VIDEO/blocked.mp4"
    });
    check("путь копии сохранён",
        r.destPath, "D:/ws/01_assets/A/VIDEO/blocked.mp4");
    Issues.save();
    Issues.attach(workspace);
    check("и переживает перезапуск",
        Issues.get("i90").destPath, "D:/ws/01_assets/A/VIDEO/blocked.mp4");
})();

group("Облачная папка и закрепление файлов");
(function () {
    /*
     * Синхронизация остаётся включённой: облако — это резервная копия.
     * Опасность в другом: клиент облака выгружает локальный файл ради места,
     * и он превращается в заглушку, которая открывается, но не отдаёт байты.
     */
    var House = mod.PardHousekeeping;

    var yandex = House.cloudInfo("D:/Yandex.Disk/MyPrograms/Soul");
    check("Яндекс.Диск узнаётся по пути", yandex.cloud, true);
    check("и называется по-человечески", yandex.label, "Яндекс.Диск");
    check("корень синхронизации найден", yandex.root, "D:/Yandex.Disk");

    check("папка с точкой в имени тоже",
        House.cloudInfo("D:/Yandex Disk/Soul").label, "Яндекс.Диск");
    check("OneDrive узнаётся",
        House.cloudInfo("C:/Users/t/OneDrive - Studio/Soul").label, "OneDrive");

    check("обычный диск облаком не считается",
        House.cloudInfo("D:/Projects/2026/Soul").cloud, false);
    /* Слово внутри имени папки — не признак синхронизации. */
    check("совпадение в середине имени не срабатывает",
        House.cloudInfo("D:/Projects/yandex-brandbook/Soul").cloud, false);
    check("пустой путь не роняет", House.cloudInfo("").cloud, false);
})();

group("Сверка различает элемент и его прокси");
(function () {
    var dir = root + "/verify-keys";
    fs.mkdirSync(dir.replace(/\//g, path.sep), { recursive: true });
    Queue.writeText(dir + "/.parddefender/assets.tsv", "");
    Verify.attach(dir);

    var outcome = Verify.sweepAll([
        { key: "i7", id: "7", name: "shot.mov", state: "protected",
          path: dir + "/gone.mov", size: 10 },
        { key: "p7", id: "7", name: "shot.mov — прокси", state: "protected",
          path: dir + "/gone-proxy.mov", size: 10 }
    ]);

    check("обе пропажи замечены", outcome.findings.length, 2);
    check("и получили разные ключи",
        [outcome.findings[0].key, outcome.findings[1].key], ["i7", "p7"]);
})();

/* ------------------------------------------------------------------ итог */

try { fs.rmSync(root.replace(/\//g, path.sep), { recursive: true, force: true }); }
catch (e) {}

console.log("\n" + (failed === 0
    ? "Все проверки пройдены: " + passed
    : "Пройдено " + passed + ", провалено " + failed));

process.exit(failed === 0 ? 0 : 1);
