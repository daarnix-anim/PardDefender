/*
 *
 * @map role: 77 проверок хоста: рабочая папка, ветки, маршруты,
 *           секвенции, границы раскладки.
 * @map status: ready
 * Exercises the parts of the host that decide WHERE something goes. These are
 * the rules that would quietly misfile assets across a whole project, and they
 * are the only parts that can be verified without After Effects running.
 *
 *   node tests/host.test.js
 */
"use strict";

var mock = require("./mock-ae");

var passed = 0, failed = 0;

function check(label, actual, expected) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failed++;
    console.log("FAIL  " + label + "\n      ожидалось " + e + "\n      получено  " + a);
}

function group(name) { console.log("\n" + name); }

/* --------------------------------------------------------------- workspace */

group("Определение рабочей папки");
(function () {
    var env = mock.loadHost();
    var host = env.host;

    check("scaffold 04_edit",
        host.resolveWorkspace("D:/Projects/2026/Soul/04_edit/Soul.aep").workspace,
        "D:/Projects/2026/Soul");
    check("legacy Edit",
        host.resolveWorkspace("D:/Projects/2026/Soul/Edit/Soul.aep").workspace,
        "D:/Projects/2026/Soul");
    check("проект в корне папки",
        host.resolveWorkspace("D:/Projects/2026/Soul/Soul.aep").workspace,
        "D:/Projects/2026/Soul");
    check("backslashes",
        host.resolveWorkspace("D:\\Projects\\2026\\Soul\\PRJ\\Soul.aep").workspace,
        "D:/Projects/2026/Soul");

    check("Desktop как рабочая папка отвергается",
        host.unsafeWorkspaceReason("C:/Users/tester/Desktop") !== "", true);
    check("обычная папка принимается",
        host.unsafeWorkspaceReason("D:/Projects/2026/Soul"), "");
    check("корень диска отвергается",
        host.unsafeWorkspaceReason("D:/") !== "", true);
    check("Auto-Save отвергается",
        host.unsafeWorkspaceReason(
            "D:/Projects/Soul/Adobe After Effects Auto-Save/x") !== "", true);
})();

/* ---------------------------------------------------------- classification */

group("Классификация форматов");
(function () {
    var host = mock.loadHost().host;
    check("mp4", host.categoryForExtension("mp4"), "video");
    check("PNG в верхнем регистре", host.categoryForExtension("PNG"), "image");
    check("ai", host.categoryForExtension("ai"), "vector");
    check("pdf", host.categoryForExtension("pdf"), "vector");
    check("psd", host.categoryForExtension("psd"), "design");
    check("c4d", host.categoryForExtension("c4d"), "model");
    check("obj", host.categoryForExtension("obj"), "model");
    check("wav", host.categoryForExtension("wav"), "audio");
    check("aep", host.categoryForExtension("aep"), "project");
    check("mgjson", host.categoryForExtension("mgjson"), "data");
    check("неизвестное", host.categoryForExtension("qqq"), "other");
})();

/* -------------------------------------------------------- имена на диске */

group("Санитизация имён папок");
(function () {
    var host = mock.loadHost().host;
    check("запрещённые символы",
        host.sanitizeSegment("Кейс: 1/2 <тест>"), "Кейс_ 1_2 _тест_");
    check("хвостовая точка снимается", host.sanitizeSegment("Финал."), "Финал");
    check("хвостовой пробел снимается", host.sanitizeSegment("Интро  "), "Интро");
    check("зарезервированное имя экранируется", host.sanitizeSegment("CON"), "_CON");
    check("пустое имя", host.sanitizeSegment("   "), "");
})();

/* ------------------------------------------------- дерево композиций */

/*
 * Строим типичный проект владельца:
 *
 *   MAIN            (рендерная: её никто не использует)
 *   ├── Интро
 *   ├── Кейс_1
 *   │   └── Кейс_1_фон
 *   └── Финал
 *   TEASER          (вторая рендерная)
 */
function buildProject(options) {
    var opts = options || {};
    var env = mock.loadHost("D:/Projects/2026/Soul/04_edit/Soul.aep");
    var p = env.project;

    var main = p.add(new mock.CompItem("MAIN"));
    var teaser = p.add(new mock.CompItem("TEASER"));
    var intro = p.add(new mock.CompItem("Интро"));
    var case1 = p.add(new mock.CompItem("Кейс_1"));
    var case1bg = p.add(new mock.CompItem("Кейс_1_фон"));
    var final = p.add(new mock.CompItem("Финал"));

    main.layers = [intro, case1, final];
    teaser.layers = [intro];
    case1.layers = [case1bg];

    if (opts.teaserNested) { main.layers.push(teaser); }

    return {
        env: env, project: p, host: env.host,
        main: main, teaser: teaser, intro: intro,
        case1: case1, case1bg: case1bg, final: final
    };
}

function addFootage(scope, name, filePath, comps, options) {
    var item = scope.project.add(new mock.FootageItem(name, filePath, options));
    mock.registerFile(filePath, (options && options.size) || 4096);
    (comps || []).forEach(function (c) { c.layers.push(item); });
    return item;
}

function auditOf(scope) {
    return scope.host.audit();
}

function itemNamed(report, name) {
    var i;
    for (i = 0; i < report.items.length; i++) {
        if (report.items[i].name === name) return report.items[i];
    }
    return null;
}

group("Рендер-композиции");
(function () {
    var s = buildProject();
    var report = auditOf(s);
    var names = report.renderComps.map(function (c) { return c.name; }).sort();
    check("обе вершины дерева найдены автоматически", names, ["MAIN", "TEASER"]);

    /* Вложенная композиция вершиной быть перестаёт. */
    var s2 = buildProject({ teaserNested: true });
    var r2 = auditOf(s2);
    check("вложенный TEASER больше не рендерная",
        r2.renderComps.map(function (c) { return c.name; }), ["MAIN"]);

    /* Очередь рендера возвращает её обратно. */
    var s3 = buildProject({ teaserNested: true });
    s3.project.setRenderQueue([s3.teaser]);
    var r3 = auditOf(s3);
    check("очередь рендера перекрывает вложенность",
        r3.renderComps.map(function (c) { return c.name; }).sort(), ["MAIN", "TEASER"]);
})();

group("Метки-переопределения");
(function () {
    /* Цвет PIN на вложенной композиции держит её в корне. */
    var s = buildProject({ teaserNested: true });
    s.teaser.label = 1;
    var report = auditOf(s);
    check("PIN делает вложенную композицию рендерной",
        report.renderComps.map(function (c) { return c.name; }).sort(), ["MAIN", "TEASER"]);

    /* Цвет SECTION поднимает третий уровень до уровня ветки. */
    var s2 = buildProject();
    s2.case1bg.label = 10;
    var f = addFootage(s2, "bg.mp4", "E:/Downloads/bg.mp4", [s2.case1bg]);
    var r2 = auditOf(s2);
    check("SECTION задаёт ветку вручную",
        itemNamed(r2, "bg.mp4").branch, "Кейс_1_фон");
})();

group("Ветки для футажа");
(function () {
    var s = buildProject();
    addFootage(s, "intro.mp4", "E:/Downloads/intro.mp4", [s.intro]);
    addFootage(s, "deep.mp4", "E:/Downloads/deep.mp4", [s.case1bg]);
    addFootage(s, "both.mp4", "E:/Downloads/both.mp4", [s.intro, s.final]);
    addFootage(s, "onmain.mp4", "E:/Downloads/onmain.mp4", [s.main]);
    addFootage(s, "loose.mp4", "E:/Downloads/loose.mp4", []);

    var r = auditOf(s);
    check("прямо в ветке", itemNamed(r, "intro.mp4").branch, "Интро");
    check("на третьем уровне поднимается до ветки",
        itemNamed(r, "deep.mp4").branch, "Кейс_1");
    check("в двух ветках сразу", itemNamed(r, "both.mp4").branch, "_SHARED");
    check("прямо в рендерной", itemNamed(r, "onmain.mp4").branch, "_SHARED");
    check("нигде не используется", itemNamed(r, "loose.mp4").branch, "");
    check("нигде не используется - помечен как unassigned",
        itemNamed(r, "loose.mp4").unassigned, true);
})();

group("Маршруты на диске");
(function () {
    var s = buildProject();
    addFootage(s, "intro.mp4", "E:/Downloads/intro.mp4", [s.intro]);
    addFootage(s, "logo.png", "E:/Downloads/logo.png", [s.case1]);
    addFootage(s, "model.obj", "E:/Downloads/model.obj", [s.final]);
    addFootage(s, "track.wav", "E:/Downloads/track.wav", [s.main], { duration: 120 });
    addFootage(s, "whoosh.wav", "E:/Downloads/whoosh.wav", [s.intro], { duration: 1.2 });
    addFootage(s, "loose.mp4", "E:/Downloads/loose.mp4", []);

    var r = auditOf(s);
    check("видео в ветку", itemNamed(r, "intro.mp4").destRel,
        "01_assets/Интро/VIDEO");
    check("картинка в ветку", itemNamed(r, "logo.png").destRel,
        "01_assets/Кейс_1/IMAGES");
    check("3D в ветку", itemNamed(r, "model.obj").destRel,
        "01_assets/Финал/3D");
    check("длинное аудио - в music, без ветки",
        itemNamed(r, "track.wav").destRel, "03_audio/music");
    check("короткое аудио - в sfx, без ветки",
        itemNamed(r, "whoosh.wav").destRel, "03_audio/sfx");
    check("без композиции - в отдельную папку",
        itemNamed(r, "loose.mp4").destRel, "01_assets/00_UNUSED/VIDEO");

    /*
     * Регресс на живой баг 2026-08-29: маршрут задаёт ПАПКУ, и без имени
     * файла копия ложится файлом с именем "VIDEO" без расширения. After
     * Effects такой файл перелинковать отказывается, а следующие файлы
     * разводятся как "VIDEO (2)", "VIDEO (3)" — именно это и произошло.
     */
    check("полный путь включает имя файла",
        itemNamed(r, "intro.mp4").destPath,
        "D:/Projects/2026/Soul/01_assets/Интро/VIDEO/intro.mp4");
    check("маршрут остаётся папкой",
        itemNamed(r, "intro.mp4").destRel, "01_assets/Интро/VIDEO");
    check("имя файла сохранено отдельно",
        itemNamed(r, "intro.mp4").destFile, "intro.mp4");
    check("аудио тоже с именем файла",
        itemNamed(r, "track.wav").destPath,
        "D:/Projects/2026/Soul/03_audio/music/track.wav");
})();

group("Секвенции");
(function () {
    var s = buildProject();
    addFootage(s, "shot_a", "E:/Downloads/frames/shot_a_00012.png", [s.intro],
        { isStill: false });
    var r = auditOf(s);
    var item = itemNamed(r, "shot_a");
    check("распознана как секвенция", item.isSequence, true);
    check("папка названа по шаблону, а не по первому кадру",
        item.destRel, "01_assets/Интро/SEQUENCES/shot_a");
    /* У секвенции назначение — именно папка: кадры кладёт слой копирования. */
    check("у секвенции destPath — папка, без имени файла",
        item.destPath, "D:/Projects/2026/Soul/01_assets/Интро/SEQUENCES/shot_a");
    check("у секвенции имени файла нет", item.destFile, "");
    check("шаблон нумерации разобран",
        [item.sequence.prefix, item.sequence.padding, item.sequence.suffix],
        ["shot_a_", 5, ".png"]);
})();

group("Состояние источников");
(function () {
    var s = buildProject();
    addFootage(s, "outside.mp4", "E:/Downloads/outside.mp4", [s.intro]);
    addFootage(s, "inside.mp4",
        "D:/Projects/2026/Soul/01_assets/Интро/VIDEO/inside.mp4", [s.intro]);
    addFootage(s, "gone.mp4", "E:/Gone/gone.mp4", [s.intro], { missing: true });

    var r = auditOf(s);
    check("внешний файл ждёт копирования", itemNamed(r, "outside.mp4").state, "pending");
    check("файл внутри проекта уже защищён", itemNamed(r, "inside.mp4").state, "protected");
    check("отсутствующий помечен", itemNamed(r, "gone.mp4").state, "missing");
    check("счётчики", [r.counts.pending, r.counts.protected_, r.counts.missing], [1, 1, 1]);
})();

group("Границы группировки в панели");
(function () {
    var s = buildProject();
    var userFolder = s.project.add(new mock.FolderItem("Мои картинки"));
    var managed = s.project.add(new mock.FolderItem("02_ASSETS"));
    var branchFolder = s.project.add(new mock.FolderItem("Интро"), managed);
    var categoryFolder = s.project.add(new mock.FolderItem("VIDEO"), branchFolder);

    var atRoot = addFootage(s, "root.mp4", "E:/Downloads/root.mp4", [s.intro]);
    var inUser = addFootage(s, "mine.mp4", "E:/Downloads/mine.mp4", [s.intro]);
    inUser.parentFolder = userFolder;
    var inManaged = addFootage(s, "managed.mp4", "E:/Downloads/managed.mp4", [s.intro]);
    inManaged.parentFolder = categoryFolder;
    var pinned = addFootage(s, "pinned.mp4", "E:/Downloads/pinned.mp4", [s.intro]);
    pinned.label = 1;

    var r = auditOf(s);
    check("элемент в корне подлежит раскладке",
        itemNamed(r, "root.mp4").panelEligible, true);
    check("элемент в папке владельца не трогается",
        itemNamed(r, "mine.mp4").panelEligible, false);
    check("элемент в нашей папке остаётся управляемым",
        itemNamed(r, "managed.mp4").panelEligible, true);
    check("метка PIN снимает элемент с раскладки",
        itemNamed(r, "pinned.mp4").panelEligible, false);

    check("цель в панели для видео",
        itemNamed(r, "root.mp4").panelTarget, "02_ASSETS/Интро/VIDEO");
})();

group("Текущее положение в панели");
(function () {
    /*
     * Регресс на живой баг 2026-08-29: без panelPath клиент каждый проход
     * шлёт все элементы, хост честно пропускает их как no-op, проход считается
     * выполненным и тут же запускает следующий. На живом проекте это дало
     * 1873 прохода за 13 минут.
     */
    var s = buildProject();
    var assets = s.project.add(new mock.FolderItem("02_ASSETS"));
    var branch = s.project.add(new mock.FolderItem("Интро"), assets);
    var video = s.project.add(new mock.FolderItem("VIDEO"), branch);

    var atRoot = addFootage(s, "root.mp4", "E:/Downloads/root.mp4", [s.intro]);
    var filed = addFootage(s, "filed.mp4", "E:/Downloads/filed.mp4", [s.intro]);
    filed.parentFolder = video;

    var r = auditOf(s);
    check("в корне — пустой путь", itemNamed(r, "root.mp4").panelPath, "");
    check("уже разложенный знает свой путь",
        itemNamed(r, "filed.mp4").panelPath, "02_ASSETS/Интро/VIDEO");
    check("разложенный уже на месте — перемещать нечего",
        itemNamed(r, "filed.mp4").panelPath === itemNamed(r, "filed.mp4").panelTarget,
        true);
    check("лежащий в корне — перемещать надо",
        itemNamed(r, "root.mp4").panelPath === itemNamed(r, "root.mp4").panelTarget,
        false);

    function compNamed(name) {
        var i;
        for (i = 0; i < r.comps.length; i++) {
            if (r.comps[i].name === name) return r.comps[i];
        }
        return null;
    }
    check("рендерная в корне уже на месте",
        compNamed("MAIN").panelPath === compNamed("MAIN").panelTarget, true);
})();

group("Неиспользуемые в панели");
(function () {
    var s = buildProject();
    addFootage(s, "loose.mp4", "E:/Downloads/loose.mp4", []);
    addFootage(s, "loose.png", "E:/Downloads/loose.png", []);
    var r = auditOf(s);
    check("неиспользуемое видео — в отдельную папку",
        itemNamed(r, "loose.mp4").panelTarget, "02_ASSETS/00_UNUSED/VIDEO");
    check("неиспользуемая картинка — туда же",
        itemNamed(r, "loose.png").panelTarget, "02_ASSETS/00_UNUSED/IMAGES");
    check("счётчик нераспределённых", r.counts.unassigned, 2);
})();

group("Цели композиций в панели");
(function () {
    var s = buildProject();
    var r = auditOf(s);
    function compNamed(name) {
        var i;
        for (i = 0; i < r.comps.length; i++) {
            if (r.comps[i].name === name) return r.comps[i];
        }
        return null;
    }
    check("рендерная остаётся в корне", compNamed("MAIN").panelTarget, "");
    check("рендерная помечена", compNamed("MAIN").isRender, true);
    check("ветка ложится в корень COMPS", compNamed("Интро").panelTarget, "01_COMPS");
    check("вложенная ложится под свою ветку",
        compNamed("Кейс_1_фон").panelTarget, "01_COMPS/Кейс_1");
})();

group("Настройки");
(function () {
    var host = mock.loadHost().host;
    var normalized = host.normalizeSettings({
        scanIntervalMs: 5,
        settleDelayMs: 999999999,
        pinLabel: 7,
        sectionLabel: 7,
        routes: { video: "../../escape/VIDEO", image: "C:/Windows/IMAGES" },
        trustedPaths: ["D:/", "D:/Stock/Library"]
    });
    check("слишком частый интервал поднимается до минимума",
        normalized.scanIntervalMs, 30000);
    check("слишком долгая задержка обрезается", normalized.settleDelayMs, 86400000);
    check("совпадающие цвета разводятся", normalized.pinLabel !== normalized.sectionLabel, true);
    check("маршрут наружу отбрасывается", normalized.routes.video,
        "01_assets/{branch}/VIDEO");
    check("абсолютный маршрут отбрасывается", normalized.routes.image,
        "01_assets/{branch}/IMAGES");
    check("корень диска не может быть доверенным путём",
        normalized.trustedPaths, ["D:/Stock/Library"]);
})();

/* ------------------------------------------------------------------ итог */

console.log("\n" + (failed === 0
    ? "Все проверки пройдены: " + passed
    : "Пройдено " + passed + ", провалено " + failed));

process.exit(failed === 0 ? 0 : 1);
