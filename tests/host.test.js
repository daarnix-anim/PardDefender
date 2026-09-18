/*
 *
 * @map role: 186 проверок хоста: рабочая папка, ветки, маршруты,
 *           многослойные PSD/AI, секвенции, границы раскладки.
 * @map status: ready
 * Exercises the parts of the host that decide WHERE something goes. These are
 * the rules that would quietly misfile assets across a whole project, and they
 * are the only parts that can be verified without After Effects running.
 *
 *   node tests/host.test.js
 */
"use strict";

var fs = require("fs");
var path = require("path");
var mock = require("./mock-ae");

var passed = 0, failed = 0;

function check(label, actual, expected) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failed++;
    console.log("FAIL  " + label + "\n      ожидалось " + e + "\n      получено  " + a);
}

function group(name) { console.log("\n" + name); }

/* ---------------------------------------------------------- source safety */

group("Исходники ExtendScript безопасны для $.evalFile");
(function () {
    var hostDir = path.join(__dirname, "..", "extension", "com.pard.defender", "host");
    var names = fs.readdirSync(hostDir).filter(function (name) { return /\.jsx$/i.test(name); });
    names.forEach(function (name) {
        var bytes = fs.readFileSync(path.join(hostDir, name));
        var ascii = true, i;
        for (i = 0; i < bytes.length; i++) {
            if (bytes[i] > 127) { ascii = false; break; }
        }
        check(name + " содержит только ASCII", ascii, true);
    });
})();

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

    main.addLayer(intro);
    main.addLayer(case1);
    main.addLayer(final);
    teaser.addLayer(intro);
    case1.addLayer(case1bg);

    if (opts.teaserNested) { main.addLayer(teaser); }

    return {
        env: env, project: p, host: env.host,
        main: main, teaser: teaser, intro: intro,
        case1: case1, case1bg: case1bg, final: final
    };
}

function addFootage(scope, name, filePath, comps, options) {
    var item = scope.project.add(new mock.FootageItem(name, filePath, options));
    mock.registerFile(filePath, (options && options.size) || 4096);
    (comps || []).forEach(function (c) { c.addLayer(item, options); });
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

group("Фиолетовая метка на композиции в корне");
(function () {
    /*
     * Живой случай владельца, 29.08.2026. Композиции RA_01, RO_00 и прочие
     * лежат в корне проекта, помечены фиолетовым и никем не используются.
     *
     * До 1.2.2 метка не читалась ВООБЩЕ: проверка «композиция никем не
     * используется → она рендерная» стояла раньше проверки цвета и выходила
     * из функции. Дальше срабатывало правило «ветка = композиция сразу под
     * рендерной», и веткой становился РЕБЁНОК, а не помеченный родитель.
     * Композиции владельца оказывались навалом в корне 01_COMPS вместо папки
     * с именем раздела, к которому они относятся.
     *
     * Проверки ниже описывают требование, а не то, что код делал раньше.
     */
    function build() {
        var env = mock.loadHost("D:/Projects/2026/Soul/04_edit/Soul.aep");
        var p = env.project;
        var ra01 = p.add(new mock.CompItem("RA_01"));
        var ra02 = p.add(new mock.CompItem("RA_02"));
        ra01.label = 10;
        ra02.label = 10;
        var inner = p.add(new mock.CompItem("logo_prob4 Comp 1"));
        var deep = p.add(new mock.CompItem("glass_waves"));
        ra01.addLayer(inner);
        inner.addLayer(deep);
        return { env: env, project: p, host: env.host,
            ra01: ra01, ra02: ra02, inner: inner, deep: deep };
    }

    function put(s, name, path, comps) {
        var item = s.project.add(new mock.FootageItem(name, path, {}));
        mock.registerFile(path, 4096);
        (comps || []).forEach(function (c) { c.addLayer(item); });
        return item;
    }

    var s = build();
    put(s, "shot.mp4", "E:/raw/shot.mp4", [s.inner]);
    put(s, "direct.mp4", "E:/raw/direct.mp4", [s.ra01]);
    put(s, "common.mp4", "E:/raw/common.mp4", [s.ra01, s.ra02]);
    var r = s.host.audit();

    function compNamed(report, name) {
        var i;
        for (i = 0; i < report.comps.length; i++) {
            if (report.comps[i].name === name) return report.comps[i];
        }
        return null;
    }

    /* Ответ владельца: помеченная композиция остаётся в корне. Она же
     * рендерная, а в корне лежит только то, что рендерится. */
    check("сама фиолетовая остаётся в корне",
        compNamed(r, "RA_01").panelTarget, "");
    check("и по-прежнему считается рендерной",
        r.renderComps.map(function (c) { return c.name; }).sort(),
        ["RA_01", "RA_02"]);
    check("но отмечена как раздел",
        r.renderComps[0].isSection, true);

    /* Главное требование. */
    check("композиция внутри неё уезжает в папку раздела",
        compNamed(r, "logo_prob4 Comp 1").panelTarget, "01_COMPS/RA_01");
    check("и вложенная на два уровня — туда же",
        compNamed(r, "glass_waves").panelTarget, "01_COMPS/RA_01");

    check("футаж внутри раздела — в папку раздела",
        itemNamed(r, "shot.mp4").destRel, "01_assets/RA_01/VIDEO");
    /* Раньше уезжал в _SHARED: «футаж на рендерной композиции ветки не
     * имеет». Метка — это ровно владелец, говорящий, какая это папка. */
    check("футаж прямо на помеченной композиции — тоже её",
        itemNamed(r, "direct.mp4").destRel, "01_assets/RA_01/VIDEO");
    check("а тот, что в двух разделах сразу — в общую папку",
        itemNamed(r, "common.mp4").destRel, "01_assets/_SHARED/VIDEO");

    /* Папка раздела должна считаться нашей, иначе панель не сможет ничего из
     * неё вынести, а опустевшую — убрать. */
    check("имя раздела попадает в список веток",
        r.branches.indexOf("RA_01") >= 0, true);

    /* Раздел, у которого только футаж и ни одной вложенной композиции: имя
     * ветки некому подсказать, кроме самой метки. */
    var s2 = build();
    put(s2, "only.mp4", "E:/raw/only.mp4", [s2.ra02]);
    var r2 = s2.host.audit();
    check("раздел без вложенных композиций тоже даёт ветку",
        r2.branches.indexOf("RA_02") >= 0, true);
    check("и его футаж лежит в ней",
        itemNamed(r2, "only.mp4").destRel, "01_assets/RA_02/VIDEO");
})();

group("Фиолетовая композиция не попадает в «выключено и забыто»");
(function () {
    /*
     * Решение владельца: фиолетовая метка — это утверждение о композиции,
     * значит она же отвечает на вопрос «рендерная ли?» — да. Помеченную
     * композицию незачем спрашивать «вы забыли её пометить?»: она помечена.
     */
    var s = buildProject();
    var marked = s.project.add(new mock.CompItem("RA_01"));
    var plain = s.project.add(new mock.CompItem("Забытая_без_метки"));
    marked.label = 10;

    var comps = s.host.scanLayers().findings
        .filter(function (f) { return f.kind === "comp"; })
        .map(function (f) { return f.compName; })
        .sort();
    check("помеченная не попадает в список", comps.indexOf("RA_01") < 0, true);
    check("а непомеченная — попадает", comps.indexOf("Забытая_без_метки") >= 0, true);

    var r = auditOf(s);
    var reasons = {};
    r.renderComps.forEach(function (c) { reasons[c.name] = c.reason; });
    check("и помечена как раздел, а не как сирота", reasons["RA_01"], "section");
    check("непомеченная остаётся сиротой",
        reasons["Забытая_без_метки"], "orphan");
})();

group("Фиолетовая метка перебивает автоматику, но не отменяет её");
(function () {
    /*
     * Ответ владельца: где метки нет — работает прежнее правило «ветка =
     * композиция сразу под рендерной». Оба уживаются, фиолетовый выигрывает
     * там, где он есть.
     */
    var s = buildProject();
    addFootage(s, "auto.mp4", "E:/Downloads/auto.mp4", [s.case1bg]);
    check("без метки ветка определяется сама",
        itemNamed(auditOf(s), "auto.mp4").branch, "Кейс_1");

    /* Та же расстановка, но третий уровень помечен. */
    var s2 = buildProject();
    s2.case1bg.label = 10;
    addFootage(s2, "auto.mp4", "E:/Downloads/auto.mp4", [s2.case1bg]);
    check("метка перебивает автоматику",
        itemNamed(auditOf(s2), "auto.mp4").branch, "Кейс_1_фон");

    /* Метка на промежуточном уровне забирает всё, что ниже. */
    var s3 = buildProject();
    s3.case1.label = 10;
    addFootage(s3, "deep.mp4", "E:/Downloads/deep.mp4", [s3.case1bg]);
    check("ближайшая метка сверху выигрывает на любой глубине",
        itemNamed(auditOf(s3), "deep.mp4").branch, "Кейс_1");

    /* Выключить метки целиком - и всё считается по-старому. */
    var s4 = buildProject();
    s4.case1bg.label = 10;
    var off = s4.host.normalizeSettings({ sectionLabel: 0 });
    s4.host.loadSettings = function () { return off; };
    addFootage(s4, "auto.mp4", "E:/Downloads/auto.mp4", [s4.case1bg]);
    check("sectionLabel=0 полностью отключает метку",
        itemNamed(auditOf(s4), "auto.mp4").branch, "Кейс_1");
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

group("Забытые выключенные слои");
(function () {
    /*
     * Каждая проверка ниже — про ОТСЕЧЕНИЕ. Найти выключенный слой легко;
     * ценность списка в том, чтобы в нём не было слоёв, выключенных по делу.
     */
    var s = buildProject();

    function put(name, file, comp, layerOptions) {
        var item = s.project.add(new mock.FootageItem(name, file, {}));
        mock.registerFile(file, 2048);
        return comp.addLayer(item, layerOptions);
    }

    var forgotten = put("forgotten.mp4", "E:/d/forgotten.mp4", s.intro, { enabled: false });
    put("visible.mp4", "E:/d/visible.mp4", s.intro, { enabled: true });
    put("adjust.mp4", "E:/d/adjust.mp4", s.intro, { enabled: false, adjustmentLayer: true });
    put("matte.mp4", "E:/d/matte.mp4", s.intro, { enabled: false, isTrackMatte: true });
    put("guide.mp4", "E:/d/guide.mp4", s.intro, { enabled: false, guideLayer: true });
    put("pinned.mp4", "E:/d/pinned.mp4", s.intro, { enabled: false, label: 1 });

    /* Выключен, но держит трансформацию другого слоя. */
    var parentLayer = put("parent.mp4", "E:/d/parent.mp4", s.case1, { enabled: false });
    put("child.mp4", "E:/d/child.mp4", s.case1, { enabled: true, parent: parentLayer });

    /* Выключен, но его читает параметр эффекта (Set Matte и подобные). */
    var effectTarget = put("setmatte.mp4", "E:/d/setmatte.mp4", s.final, { enabled: false });
    var reader = put("reader.mp4", "E:/d/reader.mp4", s.final, { enabled: true });
    reader.referenceLayer(effectTarget.index);

    /* Выключен, но назван в выражении. */
    put("expr.mp4", "E:/d/expr.mp4", s.case1bg, { enabled: false, name: "ExprSource" });
    var writer = put("writer.mp4", "E:/d/writer.mp4", s.case1bg, { enabled: true });
    writer.addExpression('thisComp.layer("ExprSource").transform.opacity');

    var report = s.host.scanLayers();
    var found = {};
    report.findings.forEach(function (f) { found[f.layerName || f.compName] = f; });

    check("выключенный и ничем не занятый — найден", !!found["forgotten.mp4"], true);
    check("включённый — не найден", found["visible.mp4"] === undefined, true);
    check("корректирующий — не найден", found["adjust.mp4"] === undefined, true);
    check("трек-матовый (AE гасит его сам) — не найден",
        found["matte.mp4"] === undefined, true);
    check("направляющий — не найден", found["guide.mp4"] === undefined, true);
    check("с меткой PIN — не найден", found["pinned.mp4"] === undefined, true);
    check("родитель другого слоя — не найден", found["parent.mp4"] === undefined, true);
    check("цель параметра эффекта — не найден",
        found["setmatte.mp4"] === undefined, true);
    check("назван в выражении — не найден", found["ExprSource"] === undefined, true);

    check("в находке указана композиция", found["forgotten.mp4"].compName, "Интро");
    check("и номер слоя", found["forgotten.mp4"].layerIndex, forgotten.index);
    check("и путь к файлу", found["forgotten.mp4"].path, "E:/d/forgotten.mp4");
    check("статус по умолчанию — не разобран", found["forgotten.mp4"].status, "open");
})();

group("Композиция, которая никуда не входит");
(function () {
    /* Решение владельца: это скорее будущая рендерная, которую забыли пометить
     * цветом, чем шум — поэтому о ней сообщаем. */
    var s = buildProject();
    var comps = s.host.scanLayers().findings
        .filter(function (f) { return f.kind === "comp"; })
        .map(function (f) { return f.compName; })
        .sort();
    check("вершины дерева помечаются", comps, ["MAIN", "TEASER"]);

    var s2 = buildProject();
    s2.project.setRenderQueue([s2.teaser]);
    var comps2 = s2.host.scanLayers().findings
        .filter(function (f) { return f.kind === "comp"; })
        .map(function (f) { return f.compName; });
    check("та, что уже в очереди рендера, не беспокоит", comps2, ["MAIN"]);
})();

group("Исключение обязано нести комментарий");
(function () {
    var s = buildProject();
    var item = s.project.add(new mock.FootageItem("spare.mp4", "E:/d/spare.mp4", {}));
    mock.registerFile("E:/d/spare.mp4", 2048);
    s.intro.addLayer(item, { enabled: false });

    var before = s.host.scanLayers().findings
        .filter(function (f) { return f.kind === "layer"; });
    check("сначала находится", before.length, 1);
    var key = before[0].key;

    check("исключение без комментария отбрасывается",
        s.host.normalizeSettings({
            disabledLayerExceptions: [{ key: key, comment: "   " }]
        }).disabledLayerExceptions.length, 0);

    var settings = s.host.normalizeSettings({
        disabledLayerExceptions: [{ key: key, comment: "запасной дубль, ждём правок" }]
    });
    check("с комментарием — сохраняется", settings.disabledLayerExceptions.length, 1);
    check("комментарий сохранён дословно",
        settings.disabledLayerExceptions[0].comment, "запасной дубль, ждём правок");

    /* Подменяем источник настроек, чтобы не трогать диск. */
    s.host.loadSettings = function () { return settings; };
    var after = s.host.scanLayers().findings
        .filter(function (f) { return f.kind === "layer"; });
    check("исключённый слой из списка исчезает", after.length, 0);
})();

group("Отправка файла в 00_UNUSED без правки композиции");
(function () {
    var s = buildProject();
    var item = s.project.add(new mock.FootageItem("keep.mp4", "E:/d/keep.mp4", {}));
    mock.registerFile("E:/d/keep.mp4", 2048);
    s.intro.addLayer(item, { enabled: false });

    var row = itemNamed(auditOf(s), "keep.mp4");
    check("обычно файл принадлежит своей ветке", row.branch, "Интро");
    check("и не считается неиспользуемым", row.unassigned, false);

    /* Владелец нажал «в 00_UNUSED». Слой в композиции не трогается. */
    var forcedSettings = s.host.normalizeSettings({ forcedUnused: [String(item.id)] });
    s.host.loadSettings = function () { return forcedSettings; };

    var row2 = itemNamed(auditOf(s), "keep.mp4");
    check("файл уезжает в 00_UNUSED", row2.destRel, "01_assets/00_UNUSED/VIDEO");
    check("помечен как принудительный", row2.forcedUnused, true);
    check("слой остался в композиции", s.intro.layers.length > 0, true);
    /*
     * Самое важное здесь: такой файл ВСЁ ЕЩЁ используется композицией.
     * Кнопка очистки обязана отличать его от по-настоящему ненужного,
     * иначе удаление порвёт проект.
     */
    check("и по-прежнему используется — удалять нельзя", item.usedIn.length > 0, true);
})();

group("Прокси");
(function () {
    /*
     * До 1.2.0 элемент с прокси пропускался целиком и висел «постоянной»
     * проблемой, с которой владельцу нечего было делать. Решение владельца:
     * прокси — автоматическое исключение, которое всё равно переезжает
     * внутрь проекта, в папку ветки своей композиции.
     */
    var s = buildProject();
    var item = addFootage(s, "shot.mov", "E:/raw/shot.mov", [s.intro], {
        useProxy: true,
        proxy: "E:/raw/proxies/shot_proxy.mov"
    });
    mock.registerFile("E:/raw/proxies/shot_proxy.mov", 512);

    var report = auditOf(s);
    var rows = report.items.filter(function (r) { return r.id === String(item.id); });
    check("элемент и его прокси — две строки", rows.length, 2);

    var main = rows.filter(function (r) { return !r.isProxy; })[0];
    var proxy = rows.filter(function (r) { return r.isProxy; })[0];

    check("у строк разные ключи", main.key !== proxy.key, true);
    check("ключ элемента", main.key, "i" + item.id);
    check("ключ прокси", proxy.key, "p" + item.id);

    check("сам файл идёт в VIDEO своей ветки",
        main.destRel, "01_assets/Интро/VIDEO");
    check("прокси — в PROXY той же ветки",
        proxy.destRel, "01_assets/Интро/PROXY");
    check("и путь прокси включает имя файла",
        proxy.destPath, "D:/Projects/2026/Soul/01_assets/Интро/PROXY/shot_proxy.mov");
    check("прокси указывает на свой файл, а не на исходник",
        proxy.path, "E:/raw/proxies/shot_proxy.mov");
    check("и знает свой размер", proxy.size, 512);

    /*
     * Прокси не бывает «нераспределённым»: композиция использует элемент,
     * которому он принадлежит. Иначе кнопка очистки утащила бы его в корзину.
     */
    check("прокси никогда не считается неиспользуемым", proxy.unassigned, false);
    check("и не двигается в панели проекта", proxy.panelEligible, false);
})();

group("Перелинковка прокси");
(function () {
    var s = buildProject();
    var item = addFootage(s, "shot.mov", "E:/raw/shot.mov", [s.intro], {
        useProxy: true,
        proxy: "E:/raw/proxies/shot_proxy.mov"
    });
    mock.registerFile("E:/raw/proxies/shot_proxy.mov", 512);

    var copyMain = "D:/Projects/2026/Soul/01_assets/Интро/VIDEO/shot.mov";
    var copyProxy = "D:/Projects/2026/Soul/01_assets/Интро/PROXY/shot_proxy.mov";
    mock.registerFile(copyMain, 4096);
    mock.registerFile(copyProxy, 512);

    /* Хост пишет план в настоящую временную папку, а не в мок. */
    require("fs").mkdirSync(s.host.tempFolder(), { recursive: true });
    var plan = s.host.tempFolder() + "/relink-test.json";
    s.host.writeTextFile(plan, s.host.jsonEncode({
        items: [
            { key: "i" + item.id, id: String(item.id), isProxy: false,
              expectPath: "E:/raw/shot.mov", destPath: copyMain, isSequence: false },
            { key: "p" + item.id, id: String(item.id), isProxy: true,
              expectPath: "E:/raw/proxies/shot_proxy.mov",
              destPath: copyProxy, isSequence: false }
        ]
    }));

    var result = s.host.commitFromFile(plan);
    check("обе строки перелинкованы", result.relinked, 2);
    check("отказов нет", result.failures.length, 0);
    check("основной источник переехал на копию",
        s.host.slashes(item.mainSource.file.fsName), copyMain);
    check("прокси переехал на свою копию",
        s.host.slashes(item.proxySource.file.fsName), copyProxy);
    /* Самое важное: элемент по-прежнему СМОТРИТ в прокси. Сбросить этот
     * флажок значит молча переключить проект на тяжёлый исходник. */
    check("и остался включённым", item.useProxy, true);
})();

group("Многослойные PSD/AI: аудит и перелинковка без схлопывания слоев");
(function () {
    var s = buildProject();
    var psdSrc = "E:/design/character.psd";
    var head = addFootage(s, "Head/character.psd", psdSrc, [s.intro]);
    var body = addFootage(s, "Body/character.psd", psdSrc, [s.intro]);
    var arm = addFootage(s, "Arm/character.psd", psdSrc, [s.intro]);

    var report = auditOf(s);
    var headRep = itemNamed(report, "Head/character.psd");
    var bodyRep = itemNamed(report, "Body/character.psd");
    var armRep = itemNamed(report, "Arm/character.psd");

    check("слой Head найден в аудите", headRep !== null, true);
    check("слой Body найден в аудите", bodyRep !== null, true);
    check("слой Arm найден в аудите", armRep !== null, true);

    check("все слои одного PSD получают единый destPath",
        headRep.destPath, bodyRep.destPath);
    check("третий слой тоже совпадает по destPath",
        armRep.destPath, headRep.destPath);
    check("destPath не содержит суффиксов дублирования (2)",
        headRep.destPath.indexOf("(2)") === -1, true);

    var destPsd = headRep.destPath;
    mock.registerFile(destPsd, 4096);

    var plan = s.host.tempFolder() + "/relink-psd-test.json";
    s.host.writeTextFile(plan, s.host.jsonEncode({
        items: [
            { key: "i" + head.id, id: String(head.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false },
            { key: "i" + body.id, id: String(body.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false },
            { key: "i" + arm.id, id: String(arm.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false }
        ]
    }));

    // Lock one layer in the composition to verify safe unlocking/relocking
    s.intro.layer(1).locked = true;

    var relinkResult = s.host.commitFromFile(plan);
    check("все 3 слоя перелинкованы", relinkResult.relinked, 3);
    check("нет отказов при перелинковке слоев", relinkResult.failures.length, 0);
    check("заблокированный слой сохранил состояние блокировки", s.intro.layer(1).locked, true);

    // Verify comp layers in s.intro were repointed via replaceSource to the new footage items
    var introComp = s.intro;
    var sources = [];
    for (var l = 1; l <= introComp.numLayers; l++) {
        var layer = introComp.layer(l);
        if (layer && layer.source && layer.source !== head && layer.source !== body && layer.source !== arm) {
            sources.push(layer.source);
        }
    }
    check("в композиции заменены все 3 слоя", sources.length, 3);
    check("новые источники указывают на скопированный destPath",
        s.host.slashes(sources[0].mainSource.file.fsName), destPsd);
    check("источники слоев не схлопнулись в один (каждый слой уникален)",
        sources[0] !== sources[1] && sources[1] !== sources[2], true);
    check("старый элемент head удален из проекта",
        s.project.items.indexOf(head), -1);
    check("старый элемент body удален из проекта",
        s.project.items.indexOf(body), -1);
    check("старый элемент arm удален из проекта",
        s.project.items.indexOf(arm), -1);
})();

group("PSD с кириллическими именами слоёв (реальный кейс)");
(function () {
    var s = buildProject();
    var psdSrc = "E:/design/garden.psd";

    var mockLayers = [
        { name: "\u0440\u0443\u043a\u0438 \u0441 \u0446\u0432\u0435\u0442\u043a\u043e\u043c", width: 400, height: 300 },
        { name: "\u0437\u0435\u043c\u043b\u044f", width: 1920, height: 200 },
        { name: "\u0433\u043e\u0440\u0448\u043a\u0438", width: 350, height: 250 }
    ];

    /* Register _mockLayers on ImportOptions for this PSD */
    var origImport = s.project.importFile.bind(s.project);
    s.project.importFile = function (options) {
        if (options && options.file) {
            var fp = String(options.file._slash || options.file.fsName);
            if (/garden\.psd$/i.test(fp)) {
                options._mockLayers = mockLayers;
            }
        }
        return origImport(options);
    };

    var hands = addFootage(s, "\u0440\u0443\u043a\u0438 \u0441 \u0446\u0432\u0435\u0442\u043a\u043e\u043c/garden.psd", psdSrc, [s.intro],
        { width: 400, height: 300 });
    var ground = addFootage(s, "\u0437\u0435\u043c\u043b\u044f/garden.psd", psdSrc, [s.intro],
        { width: 1920, height: 200 });
    var pots = addFootage(s, "\u0433\u043e\u0440\u0448\u043a\u0438/garden.psd", psdSrc, [s.intro],
        { width: 350, height: 250 });

    var report = auditOf(s);
    var destPsd = null;
    for (var ri = 0; ri < report.items.length; ri++) {
        if (report.items[ri].name.indexOf("garden.psd") !== -1) {
            destPsd = report.items[ri].destPath;
            break;
        }
    }
    check("destPath для кириллического PSD определён", destPsd !== null, true);

    mock.registerFile(destPsd, 8192);

    var plan = s.host.tempFolder() + "/relink-cyrillic-psd.json";
    s.host.writeTextFile(plan, s.host.jsonEncode({
        items: [
            { key: "i" + hands.id, id: String(hands.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false },
            { key: "i" + ground.id, id: String(ground.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false },
            { key: "i" + pots.id, id: String(pots.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false }
        ]
    }));

    var result = s.host.commitFromFile(plan);
    check("все 3 кириллических слоя перелинкованы", result.relinked, 3);
    check("нет отказов при перелинковке кириллических слоев", result.failures.length, 0);

    var introComp = s.intro;
    var sources = [];
    for (var l = 1; l <= introComp.numLayers; l++) {
        var layer = introComp.layer(l);
        if (layer && layer.source && layer.source !== hands && layer.source !== ground && layer.source !== pots) {
            sources.push(layer.source);
        }
    }
    check("в композиции заменены все 3 кириллических слоя", sources.length, 3);
    check("кириллические источники не схлопнулись в один",
        sources[0] !== sources[1] && sources[1] !== sources[2], true);
})();

group("PSD: несовпадающие слои не подставляются случайно");
(function () {
    var s = buildProject();
    var psdSrc = "E:/design/mismatch.psd";

    /* Layer names in the new import won't match the existing item names */
    var mockLayers = [
        { name: "Alpha", width: 100, height: 100 },
        { name: "Beta", width: 200, height: 200 }
    ];

    var origImport = s.project.importFile.bind(s.project);
    s.project.importFile = function (options) {
        if (options && options.file) {
            var fp = String(options.file._slash || options.file.fsName);
            if (/mismatch\.psd$/i.test(fp)) {
                options._mockLayers = mockLayers;
            }
        }
        return origImport(options);
    };

    /* Items have completely different names/dimensions from the mock layers */
    var itemX = addFootage(s, "Gamma/mismatch.psd", psdSrc, [s.intro],
        { width: 500, height: 500 });
    var itemY = addFootage(s, "Delta/mismatch.psd", psdSrc, [s.intro],
        { width: 600, height: 600 });

    var report = auditOf(s);
    var destPsd = null;
    for (var ri = 0; ri < report.items.length; ri++) {
        if (report.items[ri].name.indexOf("mismatch.psd") !== -1) {
            destPsd = report.items[ri].destPath;
            break;
        }
    }
    mock.registerFile(destPsd, 4096);

    var plan = s.host.tempFolder() + "/relink-mismatch-psd.json";
    s.host.writeTextFile(plan, s.host.jsonEncode({
        items: [
            { key: "i" + itemX.id, id: String(itemX.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false },
            { key: "i" + itemY.id, id: String(itemY.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false }
        ]
    }));

    var result = s.host.commitFromFile(plan);
    check("при несовпадении слоёв relinked = 0", result.relinked, 0);
    check("при несовпадении слоёв все 2 помечены как failures", result.failures.length, 2);

    var hasMatchFailed = result.failures.some(function (f) {
        return f.code === "LAYER_MATCH_FAILED";
    });
    check("код ошибки — LAYER_MATCH_FAILED", hasMatchFailed, true);

    /* Originals must remain untouched */
    check("элемент X остался в проекте", s.project.items.indexOf(itemX) !== -1, true);
    check("элемент Y остался в проекте", s.project.items.indexOf(itemY) !== -1, true);
})();

group("PSD: сохранение transform (position/anchorPoint) при replaceSource");
(function () {
    var s = buildProject();
    var psdSrc = "E:/design/posed.psd";

    var mockLayers = [
        { name: "Hand", width: 200, height: 150 },
        { name: "Pot", width: 300, height: 180 }
    ];

    var origImport = s.project.importFile.bind(s.project);
    s.project.importFile = function (options) {
        if (options && options.file) {
            var fp = String(options.file._slash || options.file.fsName);
            if (/posed\.psd$/i.test(fp)) {
                options._mockLayers = mockLayers;
            }
        }
        return origImport(options);
    };

    var hand = addFootage(s, "Hand/posed.psd", psdSrc, [s.intro],
        { width: 200, height: 150 });
    var pot = addFootage(s, "Pot/posed.psd", psdSrc, [s.intro],
        { width: 300, height: 180 });

    /* Set custom transform values on the composition layers */
    var handLayer = s.intro.layer(s.intro.numLayers - 1);
    var potLayer = s.intro.layer(s.intro.numLayers);
    handLayer.transform.position.value = [250, 300];
    handLayer.transform.anchorPoint.value = [100, 75];
    potLayer.transform.position.value = [600, 400];
    potLayer.transform.anchorPoint.value = [150, 90];

    var report = auditOf(s);
    var destPsd = null;
    for (var ri = 0; ri < report.items.length; ri++) {
        if (report.items[ri].name.indexOf("posed.psd") !== -1) {
            destPsd = report.items[ri].destPath;
            break;
        }
    }
    mock.registerFile(destPsd, 4096);

    var plan = s.host.tempFolder() + "/relink-transform-psd.json";
    s.host.writeTextFile(plan, s.host.jsonEncode({
        items: [
            { key: "i" + hand.id, id: String(hand.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false },
            { key: "i" + pot.id, id: String(pot.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false }
        ]
    }));

    var result = s.host.commitFromFile(plan);
    check("оба слоя перелинкованы", result.relinked, 2);
    check("нет отказов", result.failures.length, 0);

    /* Find the relinked layers — they should now point to new sources */
    var handNewLayer = null, potNewLayer = null;
    for (var l = 1; l <= s.intro.numLayers; l++) {
        var layer = s.intro.layer(l);
        if (layer && layer.source && layer.source !== hand && layer.source !== pot) {
            if (!handNewLayer) handNewLayer = layer;
            else potNewLayer = layer;
        }
    }

    check("hand слой найден после relink", handNewLayer !== null, true);
    check("pot слой найден после relink", potNewLayer !== null, true);

    if (handNewLayer) {
        check("position hand сохранена",
            JSON.stringify(handNewLayer.transform.position.value), JSON.stringify([250, 300]));
        check("anchorPoint hand сохранена",
            JSON.stringify(handNewLayer.transform.anchorPoint.value), JSON.stringify([100, 75]));
    }
    if (potNewLayer) {
        check("position pot сохранена",
            JSON.stringify(potNewLayer.transform.position.value), JSON.stringify([600, 400]));
        check("anchorPoint pot сохранена",
            JSON.stringify(potNewLayer.transform.anchorPoint.value), JSON.stringify([150, 90]));
    }
})();

group("PSD: повторный импорт / дубликаты слоёв перелинковываются на тот же источник без LAYER_MATCH_FAILED");
(function () {
    var s = buildProject();
    var psdSrc = "E:/design/duplicate_layers.psd";

    var mockLayers = [
        { name: "Leaf", width: 200, height: 100 },
        { name: "Cup", width: 150, height: 150 }
    ];

    var origImport = s.project.importFile.bind(s.project);
    s.project.importFile = function (options) {
        if (options && options.file) {
            var fp = String(options.file._slash || options.file.fsName);
            if (/duplicate_layers\.psd$/i.test(fp)) {
                options._mockLayers = mockLayers;
            }
        }
        return origImport(options);
    };

    /* First set of footage items (e.g. from first import or folder A) */
    var leaf1 = addFootage(s, "Leaf/duplicate_layers.psd", psdSrc, [s.intro],
        { width: 200, height: 100 });
    var cup1 = addFootage(s, "Cup/duplicate_layers.psd", psdSrc, [s.intro],
        { width: 150, height: 150 });

    /* Second set of duplicate footage items (e.g. from second import or folder B) */
    var leaf2 = addFootage(s, "Leaf/duplicate_layers.psd", psdSrc, [s.intro],
        { width: 200, height: 100 });
    var cup2 = addFootage(s, "Cup/duplicate_layers.psd", psdSrc, [s.intro],
        { width: 150, height: 150 });

    var report = auditOf(s);
    var destPsd = null;
    for (var ri = 0; ri < report.items.length; ri++) {
        if (report.items[ri].name.indexOf("duplicate_layers.psd") !== -1) {
            destPsd = report.items[ri].destPath;
            break;
        }
    }
    mock.registerFile(destPsd, 8192);

    var plan = s.host.tempFolder() + "/relink-dup-psd.json";
    s.host.writeTextFile(plan, s.host.jsonEncode({
        items: [
            { key: "i" + leaf1.id, id: String(leaf1.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false },
            { key: "i" + cup1.id, id: String(cup1.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false },
            { key: "i" + leaf2.id, id: String(leaf2.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false },
            { key: "i" + cup2.id, id: String(cup2.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false }
        ]
    }));

    var result = s.host.commitFromFile(plan);
    check("все 4 элемента (включая дубликаты) успешно перелинкованы", result.relinked, 4);
    check("нет отказов LAYER_MATCH_FAILED при дубликатах", result.failures.length, 0);
})();

group("PSD: повторный импорт при нескольких одинаково названных слоях (Pass 5) и плоские PSD-футажи");
(function () {
    var s = buildProject();
    var psdSrc = "E:/design/multi_leaf.psd";

    /* PSD has 2 layers named "Leaf" with different sizes */
    var mockLayers = [
        { name: "Leaf", width: 200, height: 100 },
        { name: "Leaf", width: 300, height: 150 }
    ];

    var origImport = s.project.importFile.bind(s.project);
    s.project.importFile = function (options) {
        if (options && options.file) {
            var fp = String(options.file._slash || options.file.fsName);
            if (/multi_leaf\.psd$/i.test(fp)) {
                options._mockLayers = mockLayers;
            }
        }
        return origImport(options);
    };

    /* Project has 4 footage items named "Leaf" (more items than layers in PSD) without exact dimensions */
    var leaf1 = addFootage(s, "Leaf/multi_leaf.psd", psdSrc, [s.intro], { width: 0, height: 0 });
    var leaf2 = addFootage(s, "Leaf/multi_leaf.psd", psdSrc, [s.intro], { width: 0, height: 0 });
    var leaf3 = addFootage(s, "Leaf/multi_leaf.psd", psdSrc, [s.intro], { width: 0, height: 0 });
    var leaf4 = addFootage(s, "Leaf/multi_leaf.psd", psdSrc, [s.intro], { width: 0, height: 0 });

    /* Flat PSD footage item without layer prefix */
    var flatPsd = addFootage(s, "multi_leaf.psd", psdSrc, [s.intro], { width: 500, height: 500 });

    var report = auditOf(s);
    var destPsd = null;
    for (var ri = 0; ri < report.items.length; ri++) {
        if (report.items[ri].name.indexOf("multi_leaf.psd") !== -1) {
            destPsd = report.items[ri].destPath;
            break;
        }
    }
    mock.registerFile(destPsd, 16384);

    var plan = s.host.tempFolder() + "/relink-multi-leaf.json";
    s.host.writeTextFile(plan, s.host.jsonEncode({
        items: [
            { key: "i" + leaf1.id, id: String(leaf1.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false },
            { key: "i" + leaf2.id, id: String(leaf2.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false },
            { key: "i" + leaf3.id, id: String(leaf3.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false },
            { key: "i" + leaf4.id, id: String(leaf4.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false },
            { key: "i" + flatPsd.id, id: String(flatPsd.id), isProxy: false,
              expectPath: psdSrc, destPath: destPsd, isSequence: false }
        ]
    }));

    var result = s.host.commitFromFile(plan);
    check("все 5 элементов (слои и плоский футаж) успешно перелинкованы", result.relinked, 5);
    check("нет отказов LAYER_MATCH_FAILED при переполнении слоев и плоском PSD", result.failures.length, 0);
})();

group("Старый проект: оставить как есть");
(function () {
    /*
     * Решение владельца, 2026-08-29: одна кнопка объявляет всё, что сейчас
     * лежит внутри рабочей папки, неприкосновенным — и файл, и место в
     * панели. Новые импорты защищаются как обычно.
     */
    var s = buildProject();
    var inside = addFootage(s, "old.mp4",
        "D:/Projects/2026/Soul/old.mp4", [s.intro]);
    var outside = addFootage(s, "new.mp4", "E:/downloads/new.mp4", [s.intro]);

    var before = itemNamed(auditOf(s), "old.mp4");
    check("до решения файл в корне считается лежащим не там",
        before.misplaced, true);

    var settings = s.host.normalizeSettings({ adoptedItems: [String(inside.id)] });
    check("список принятых сохраняется", settings.adoptedItems.length, 1);
    s.host.loadSettings = function () { return settings; };

    var report = auditOf(s);
    var kept = itemNamed(report, "old.mp4");
    check("файл помечен принятым", kept.adopted, true);
    check("и больше не считается лежащим не там", kept.misplaced, false);
    check("состояние — доверенный, а не в очереди", kept.state, "trusted");
    check("и в панели он не двигается", kept.panelEligible, false);

    /* Файл ЗА пределами рабочей папки не принимается никогда: оставить его
     * в «Загрузках» — это ровно та потеря, ради которой всё написано. */
    var still = itemNamed(report, "new.mp4");
    check("внешний файл всё равно в очереди на защиту", still.state, "pending");
})();

group("Старый проект: разложить всё по местам");
(function () {
    var s = buildProject();
    addFootage(s, "dump.mp4", "D:/Projects/2026/Soul/dump.mp4", [s.intro]);
    addFootage(s, "ok.mp4",
        "D:/Projects/2026/Soul/01_assets/Интро/VIDEO/ok.mp4", [s.intro]);

    var report = auditOf(s);
    var dump = itemNamed(report, "dump.mp4");
    var ok = itemNamed(report, "ok.mp4");

    check("сваленный в корень — не на месте", dump.misplaced, true);
    check("уже разложенный — на месте", ok.misplaced, false);
    check("счётчик считает только первый", report.counts.misplaced, 1);

    /*
     * Сравниваются ПАПКИ, а не пути целиком. Копия, которой пришлось взять
     * другое имя из-за совпадения, лежит там, где надо. Сравнение по имени
     * держало бы её «не на месте» вечно, и проход копировал бы её снова на
     * каждом запуске — каждый раз под новым именем.
     */
    var s2 = buildProject();
    addFootage(s2, "ok.mp4",
        "D:/Projects/2026/Soul/01_assets/Интро/VIDEO/ok (2).mp4", [s2.intro]);
    var renamed = itemNamed(auditOf(s2), "ok.mp4");
    check("копия с другим именем в правильной папке — на месте",
        renamed.misplaced, false);
})();

group("Забытая композиция отвечает за то, что внутри");
(function () {
    /*
     * Решение владельца, 2026-08-29: если композиция помечена забытой,
     * перечислять её выключенные слои незачем — одно решение не должно
     * превращаться в десяток строк о композиции, которая и так уходит.
     */
    var s = buildProject();
    var item = s.project.add(new mock.FootageItem("inside.mp4", "E:/d/inside.mp4", {}));
    mock.registerFile("E:/d/inside.mp4", 2048);
    /* Слой внутри TEASER — композиции, которую никто не использует. */
    s.teaser.addLayer(item, { enabled: false });

    var before = s.host.scanLayers().findings;
    check("сначала видно и композицию, и слой в ней",
        before.filter(function (f) { return f.compName === "TEASER"; }).length, 2);

    var settings = s.host.normalizeSettings({
        disabledLayerForgotten: [s.host.compKey(s.teaser)]
    });
    s.host.loadSettings = function () { return settings; };

    var after = s.host.scanLayers().findings
        .filter(function (f) { return f.compName === "TEASER"; });
    check("после пометки остаётся одна строка — сама композиция", after.length, 1);
    check("и это композиция, а не слой", after[0].kind, "comp");
    check("со статусом «забытая»", after[0].status, "forgotten");

    /* Исключение говорит обратное — «композиция в порядке» — и о слоях
     * внутри неё не сообщает ничего. */
    var s3 = buildProject();
    var item3 = s3.project.add(new mock.FootageItem("in3.mp4", "E:/d/in3.mp4", {}));
    mock.registerFile("E:/d/in3.mp4", 2048);
    s3.teaser.addLayer(item3, { enabled: false });
    var excepted = s3.host.normalizeSettings({
        disabledLayerExceptions: [
            { key: s3.host.compKey(s3.teaser), comment: "это будущая рендерная" }
        ]
    });
    s3.host.loadSettings = function () { return excepted; };
    var rows = s3.host.scanLayers().findings
        .filter(function (f) { return f.compName === "TEASER"; });
    check("исключение убирает композицию, но слой остаётся виден", rows.length, 1);
    check("и это слой", rows[0].kind, "layer");
})();

group("JSON хоста");
(function () {
    var host = mock.loadHost().host;
    /*
     * Список должен оставаться списком. Проверка instanceof Array
     * не работает на массиве, созданном в другом контексте, и кодировщик
     * молча выдавал {"0":..,"1":..} вместо [..]. План, собранный
     * так, хост объявляет испорченным и не делает ничего.
     */
    check("массив из другого контекста остаётся массивом",
        host.jsonEncode({ items: [1, 2] }), "{\"items\":[1,2]}");
    check("строка массивом не становится",
        host.jsonEncode("ab"), "\"ab\"");
    check("вложенные объекты целы",
        host.jsonDecode(host.jsonEncode({ a: [{ b: 1 }] })).a[0].b, 1);
})();

group("Нормализация новых настроек");
(function () {
    var host = mock.loadHost().host;
    var d = host.defaultSettings();

    check("маршрут прокси есть по умолчанию", d.routes.proxy, "01_assets/{branch}/PROXY");
    check("легенда цветов открыта у нового проекта", d.legendOpen, true);
    check("перераспределение выключено по умолчанию", d.legacyRedistribute, false);
    check("старые копии по умолчанию уезжают в корзину", d.legacyRecycleOld, true);

    var n = host.normalizeSettings({
        legendOpen: false,
        legacyRedistribute: true,
        legacyRecycleOld: false,
        adoptedItems: ["11", "", "12"]
    });
    check("свёрнутая легенда запоминается", n.legendOpen, false);
    check("режим перераспределения запоминается", n.legacyRedistribute, true);
    check("отказ от корзины запоминается", n.legacyRecycleOld, false);
    check("пустые идентификаторы отбрасываются", n.adoptedItems, ["11", "12"]);

    /* Маршрут прокси — такой же маршрут: побег вверх по дереву
     * заменяется значением по умолчанию, а не отвергается. */
    var escaped = host.normalizeSettings({ routes: { proxy: "../../куда-нибудь" } });
    check("побег из рабочей папки не проходит и здесь",
        escaped.routes.proxy, "01_assets/{branch}/PROXY");
})();

/* ------------------------------------------------------------------ итог */

console.log("\n" + (failed === 0
    ? "Все проверки пройдены: " + passed
    : "Пройдено " + passed + ", провалено " + failed));

process.exit(failed === 0 ? 0 : 1);
