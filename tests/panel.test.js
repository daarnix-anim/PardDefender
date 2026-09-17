/*
 *
 * @map role: Проверки самой панели: вкладки, кнопки, места блоков и
 *           дисциплина перерисовки. Первый набор, который запускает main.js.
 * @map status: ready
 *
 * Until this file existed, main.js had never been executed anywhere. It is the
 * largest file in the project, it owns every timer and every button, and
 * everything known about it came from reading it. This set switches it on.
 *
 * The markup comes from the real client/index.html through tests/mock-dom.js,
 * so a disagreement between the panel's markup and its code fails here rather
 * than in After Effects.
 *
 * The host is answered by a stub. That means item.replace(), setProxy() and the
 * rest of the ExtendScript surface are still unproven against AE - this set is
 * about the panel, not about the host.
 *
 *   node tests/panel.test.js
 */
"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");
var vm = require("vm");
var dom = require("./mock-dom");

var passed = 0, failed = 0;

function check(label, actual, expected) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failed++;
    console.log("FAIL  " + label + "\n      ожидалось " + e + "\n      получено  " + a);
}

function group(name) { console.log("\n" + name); }

/* --------------------------------------------------------------- scratch */

var root = path.join(os.tmpdir(), "parddefender-panel-" + Date.now())
    .replace(/\\/g, "/");
/* The workspace name carries "Yandex.Disk" on purpose: it is what makes the
 * cloud row appear, and that row is one of the things under test. */
var workspace = root + "/Yandex.Disk/Soul";
var meta = workspace + "/.parddefender";
var reportPath = root + "/audit.json";
var layersPath = root + "/layers.json";

/* The client writes its settings plan here; the stub host reads it back. */
var clientTemp = String(os.tmpdir()).replace(/\\/g, "/") + "/parddefender-client";

function native(p) { return String(p).replace(/\//g, path.sep); }

function mkdir(p) { fs.mkdirSync(native(p), { recursive: true }); }
function write(p, text) { mkdir(p.replace(/\/[^\/]*$/, "")); fs.writeFileSync(native(p), text, "utf8"); }

mkdir(meta);

/* ---------------------------------------------------------- synthetic host */

function settings(extra) {
    var out = {
        version: 1,
        autoEnabled: false,
        copyEnabled: true,
        organizePanelEnabled: true,
        /* Zero so a manual tick always re-reads the report: the harness changes
         * the project between assertions. */
        scanIntervalMs: 0,
        settleDelayMs: 0,
        inboxTimeoutMs: 0,
        audioSplitSeconds: 30,
        pinLabel: 1,
        sectionLabel: 10,
        reserveBytes: 0,
        maxItemsPerPass: 40,
        routes: {
            video: "01_assets/{branch}/VIDEO", image: "01_assets/{branch}/IMAGES",
            vector: "01_assets/{branch}/VECTOR", design: "01_assets/{branch}/DESIGN",
            model: "01_assets/{branch}/3D", data: "01_assets/{branch}/DATA",
            project: "01_assets/{branch}/PROJECTS", other: "01_assets/{branch}/OTHER",
            proxy: "01_assets/{branch}/PROXY",
            sequence: "01_assets/{branch}/SEQUENCES/{name}",
            music: "03_audio/music", sfx: "03_audio/sfx", voice: "03_audio/voice"
        },
        trustedPaths: [],
        scanLayersEnabled: true,
        disabledLayerExceptions: [],
        disabledLayerForgotten: [],
        forcedUnused: [],
        legendOpen: true,
        adoptedItems: [],
        legacyRedistribute: false,
        legacyRecycleOld: true
    };
    var k;
    for (k in (extra || {})) { if (extra.hasOwnProperty(k)) out[k] = extra[k]; }
    return out;
}

function baseReport(options) {
    var o = options || {};
    return {
        ok: true,
        hostVersion: "1.3.0",
        error: "",
        projectPath: workspace + "/04_edit/Soul.aep",
        projectSaved: o.saved === false ? false : true,
        workspace: o.saved === false ? "" : workspace,
        workspaceSource: "edit-folder",
        workspaceIssue: "",
        settings: settings(o.settings),
        renderComps: [{ id: "1", name: "MAIN", reason: "orphan", isSection: false }],
        branches: ["Интро", "00_UNUSED", "_SHARED"],
        items: o.items || [],
        comps: o.comps || [],
        counts: o.counts || {
            total: 0, protected_: 0, pending: 0, missing: 0, trusted: 0,
            unassigned: 0, panelMoves: 0, misplaced: 0, adopted: 0, proxies: 0
        }
    };
}

/* A real file inside the workspace plus a manifest row is what makes an item a
 * cleanup candidate - the manifest is the record of what the extension itself
 * put there, and nothing without a row can ever be deleted. */
function protectedItem(name, options) {
    var o = options || {};
    var dest = workspace + "/01_assets/00_UNUSED/VIDEO/" + name;
    write(dest, "bytes-" + name);
    return {
        key: "i" + (o.id || "10"), id: String(o.id || "10"), isProxy: false,
        name: name, path: dest, ext: "mp4", category: "video",
        routeKey: "video", isSequence: false, sequence: null,
        branch: "", branchResolved: "00_UNUSED",
        unassigned: o.unassigned === false ? false : true,
        forcedUnused: false, adopted: false,
        size: 12, state: "protected",
        destRel: "01_assets/00_UNUSED/VIDEO", destFile: name, destPath: dest,
        misplaced: o.misplaced === true,
        panelTarget: "02_ASSETS/00_UNUSED/VIDEO", panelPath: "",
        panelEligible: false, hasProxy: false
    };
}

/* The recorded size has to match the file on disk, or every sweep reports
 * PROTECTED_CHANGED and the fixture manufactures a problem of its own. */
function manifestRow(item) {
    var size = fs.statSync(native(item.path)).size;
    return [new Date().toISOString(), item.key, "E:/raw/" + item.name, size,
        item.path, item.branchResolved, item.category].join("\t");
}

function layersReport(findings) {
    return {
        ok: true, error: "", scannedComps: 3, scannedLayers: 12,
        findings: findings || [], truncated: false
    };
}

/* ---------------------------------------------------------------- harness */

function launch(options) {
    var o = options || {};
    var built = dom.build(dom.indexPath);
    var calls = {
        scripts: [], dismissed: [], recycled: [], pinned: 0,
        revealed: [], settings: []
    };
    var intervals = [], timeouts = [];

    write(reportPath, JSON.stringify(o.report || baseReport()));
    write(layersPath, JSON.stringify(o.layers || layersReport()));

    function evalScript(script, callback) {
        calls.scripts.push(script);
        function has(needle) { return script.indexOf(needle) >= 0; }

        if (has("$.evalFile")) { callback("OK"); return; }
        if (has("PardDefenderHost.version")) { callback("OK|1.3.0"); return; }
        if (has("auditToFile")) { callback("OK|" + reportPath); return; }
        if (has("scanLayersToFile")) { callback("OK|" + layersPath); return; }
        if (has("writeSettingsFromFile")) {
            var raw = null;
            try { raw = fs.readFileSync(native(clientTemp + "/settings.json"), "utf8"); }
            catch (e) { raw = null; }
            var parsed = raw ? JSON.parse(raw) : settings();
            calls.settings.push(parsed);
            callback(JSON.stringify({ ok: true, settings: parsed }));
            return;
        }
        if (has("revealWorkspace")) { calls.revealed.push("workspace"); callback("OK|"); return; }
        if (has("selectItemById")) { callback("OK|item|02_ASSETS"); return; }
        if (has("revealLayer") || has("revealComp")) { callback("OK|Интро|Слой 3"); return; }
        if (has("removeItemsFromFileJson")) {
            callback(JSON.stringify({ ok: true, removed: 1 }));
            return;
        }
        if (has("commitFromFileJson")) {
            callback(JSON.stringify({ ok: true, relinked: 0, skipped: 0, failures: [] }));
            return;
        }
        if (has("organizeFromFileJson")) {
            callback(JSON.stringify({ ok: true, moved: 0, pruned: 0 }));
            return;
        }
        callback("");
    }

    var sandbox = {
        require: require, console: console, Date: Date, Math: Math, JSON: JSON,
        String: String, Number: Number, Array: Array, Object: Object,
        isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
        isFinite: isFinite, process: process, RegExp: RegExp, Error: Error,
        document: built.document
    };
    sandbox.global = sandbox;

    /* Timers are recorded, never fired. The two-press confirmations arm on a
     * timeout and would cancel themselves instantly if it ran. */
    sandbox.setTimeout = function (fn, ms) { timeouts.push({ fn: fn, ms: ms }); return timeouts.length; };
    sandbox.clearTimeout = function () {};
    sandbox.setInterval = function (fn, ms) { intervals.push({ fn: fn, ms: ms }); return intervals.length; };
    sandbox.clearInterval = function () {};

    sandbox.window = {
        document: built.document,
        setTimeout: sandbox.setTimeout,
        clearTimeout: sandbox.clearTimeout,
        setInterval: sandbox.setInterval,
        clearInterval: sandbox.clearInterval,
        addEventListener: function () {},
        location: {
            pathname: "/" + path.join(__dirname, "..", "extension",
                "com.pard.defender", "client", "index.html").replace(/\\/g, "/")
        },
        __adobe_cep__: { evalScript: evalScript }
    };

    vm.createContext(sandbox);

    var dir = path.join(__dirname, "..", "extension", "com.pard.defender", "client");
    ["disk-space.js", "copy-queue.js", "issues.js", "stats.js", "verify.js",
        "housekeeping.js", "updater.js", "host-adapter.js", "workspace-store.js",
        "duplicate-index.js"].forEach(function (name) {
        vm.runInContext(fs.readFileSync(path.join(dir, name), "utf8"),
            sandbox, { filename: name });
    });

    /*
     * Everything that would touch the network, spawn a process or write into
     * the user profile is replaced. A test set that shells out to PowerShell or
     * asks GitHub for a release is not a test set.
     */
    sandbox.PardDiskSpace.query = function (target, callback) {
        callback({ ok: true, freeBytes: 214e9, totalBytes: 1800e9, usedRatio: 0.78 });
    };
    sandbox.PardHousekeeping.measure = function (target, callback) {
        callback({ ok: true, bytes: 48e9, files: 1204, folders: 40 });
    };
    sandbox.PardHousekeeping.pinState = function (target, callback) {
        callback({ ok: true, pinned: 10, sampled: 300, allPinned: false, error: "" });
    };
    sandbox.PardHousekeeping.pinAlways = function (target, callback) {
        calls.pinned++;
        callback({ ok: true, pinned: 300, sampled: 300, allPinned: true, error: "" });
    };
    sandbox.PardHousekeeping.recycle = function (paths, callback) {
        calls.recycled.push(paths.slice());
        callback({ ok: true, recycled: paths.length, failed: 0, error: "" });
    };
    sandbox.PardUpdater.check = function (force, callback) {
        callback(o.update === false ? null : {
            version: "9.9.9",
            summary: "Панель разложена по вкладкам.",
            url: "https://github.com/daarnix-anim/PardDefender/releases"
        });
    };
    sandbox.PardUpdater.dismiss = function (version) { calls.dismissed.push(version); };
    sandbox.PardUpdater.configure = function () {};
    sandbox.PardUpdater.openReleasePage = function (url) { calls.revealed.push(url); };

    dom.resetHtmlWrites();
    vm.runInContext(fs.readFileSync(path.join(dir, "main.js"), "utf8"),
        sandbox, { filename: "main.js" });

    function id(name) { return built.byId[name]; }

    function click(name) {
        var element = id(name);
        if (!element) throw new Error("нет элемента " + name);
        if (!element.onclick) throw new Error("нет обработчика у " + name);
        element.onclick();
        return element;
    }

    function change(name, apply) {
        var element = id(name);
        if (apply) apply(element);
        element.onchange();
        return element;
    }

    /* Re-reads the report and repaints, the way the five-second timer would. */
    function tick(report, layers) {
        if (report) write(reportPath, JSON.stringify(report));
        if (layers) write(layersPath, JSON.stringify(layers));
        intervals[0].fn();
    }

    function tabTitles() {
        return id("tabs").children.map(function (b) { return b.textContent; });
    }

    function activeTab() {
        var found = "";
        id("tabs").children.forEach(function (b) {
            if (b.hasClass("active")) found = b.textContent;
        });
        return found;
    }

    function visiblePanes() {
        return ["main", "layers", "unused", "duplicates", "legacy", "journal", "settings"]
            .filter(function (n) { return !id("pane-" + n).hidden; });
    }

    return {
        sandbox: sandbox, byId: built.byId, root: built.root, calls: calls,
        id: id, click: click, change: change, tick: tick,
        tabTitles: tabTitles, activeTab: activeTab, visiblePanes: visiblePanes,
        intervals: intervals, timeouts: timeouts
    };
}

/* ============================================================== запуск */

group("Панель поднимается");
(function () {
    var p = launch();

    check("хост загружен и версия показана", p.id("version").textContent, "v1.3.0");
    check("статус перестал быть «ЗАПУСК…»",
        p.id("status").textContent !== "ЗАПУСК…", true);
    check("таймер обхода заведён ровно один", p.intervals.length, 1);
    check("и он на пять секунд", p.intervals[0].ms, 5000);

    /*
     * Каждый элемент, который код собирается трогать, обязан существовать в
     * разметке. Раньше это ловилось только глазами, а один потерянный id
     * роняет bind() целиком — панель просто не открывается.
     */
    var ids = Object.keys(p.byId);
    check("разметка разобрана целиком", ids.length > 60, true);
})();

group("Кнопки: у каждой есть своё дело");
(function () {
    var p = launch();
    var controls = [];
    p.root.all().forEach(function (node) {
        if (node.tagName !== "BUTTON" && node.tagName !== "INPUT") return;
        if (!node.id) return;
        controls.push(node);
    });

    check("интерактивных элементов в разметке", controls.length, 24);

    var orphans = controls.filter(function (node) {
        return !node.onclick && !node.onchange;
    }).map(function (node) { return node.id; });
    check("без обработчика", orphans, []);
})();

/* ============================================================== вкладки */

group("Вкладки: состав");
(function () {
    /* Здоровый проект: убирать нечего, раскладывать нечего. */
    var p = launch();
    check("три вкладки, а не пять",
        p.tabTitles(), ["ПАНЕЛЬ", "ЖУРНАЛ", "НАСТРОЙКИ"]);
    check("открыта «ПАНЕЛЬ»", p.activeTab(), "ПАНЕЛЬ");
    check("видна ровно одна панель", p.visiblePanes(), ["main"]);

    /*
     * Файл, который расширение уже защитило, перестал использоваться —
     * владелец убрал слой. Манифест при этом на месте с самого начала: его
     * пишет проход копирования, задолго до того, как элемент осиротеет.
     */
    var used = protectedItem("loose.mp4", { id: 10, unassigned: false });
    write(meta + "/assets.tsv", manifestRow(used) + "\n");
    var p2 = launch({ report: baseReport({ items: [used] }) });
    check("пока файл используется, вкладки нет",
        p2.tabTitles(), ["ПАНЕЛЬ", "ЖУРНАЛ", "НАСТРОЙКИ"]);

    var loose = protectedItem("loose.mp4", { id: 10 });
    p2.tick(baseReport({ items: [loose] }));
    check("осиротел — вкладка появилась со счётчиком",
        p2.tabTitles(), ["ПАНЕЛЬ", "НЕ ИСПОЛЬЗУЕТСЯ1", "ЖУРНАЛ", "НАСТРОЙКИ"]);

    /* И файлы не на своих местах — но только те, которых нет в манифесте. */
    var stray = protectedItem("stray.mp4", { id: 11, unassigned: false, misplaced: true });
    p2.tick(baseReport({ items: [loose, stray] }));
    check("вкладка «старый проект» тоже",
        p2.tabTitles(),
        ["ПАНЕЛЬ", "НЕ ИСПОЛЬЗУЕТСЯ1", "СТАРЫЙ ПРОЕКТ1", "ЖУРНАЛ", "НАСТРОЙКИ"]);

    /*
     * Файл, который положило туда расширение, «старым проектом» не считается,
     * даже если маршрут потом изменился: место на диске окончательное.
     */
    var ours = protectedItem("loose.mp4", { id: 10, unassigned: false, misplaced: true });
    p2.tick(baseReport({ items: [ours] }));
    check("файл из манифеста не поднимает «старый проект»",
        p2.tabTitles(), ["ПАНЕЛЬ", "ЖУРНАЛ", "НАСТРОЙКИ"]);
})();

group("Вкладки: переключение");
(function () {
    var loose = protectedItem("loose.mp4", { id: 10 });
    write(meta + "/assets.tsv", manifestRow(loose) + "\n");
    var p = launch({ report: baseReport({ items: [loose] }) });

    var tabs = p.id("tabs");
    function press(title) {
        var hit = null;
        tabs.children.forEach(function (b) { if (b.textContent === title) hit = b; });
        if (!hit) throw new Error("нет вкладки " + title);
        hit.onclick();
    }

    press("НАСТРОЙКИ");
    check("открылась «НАСТРОЙКИ»", p.activeTab(), "НАСТРОЙКИ");
    check("и видна только её панель", p.visiblePanes(), ["settings"]);
    check("галочки на ней действительно видимы",
        p.id("auto-enabled").isVisible(), true);
    check("а список неиспользуемых — нет",
        p.id("unused-section").isVisible(), false);

    press("НЕ ИСПОЛЬЗУЕТСЯ1");
    check("переключение работает в обе стороны", p.visiblePanes(), ["unused"]);
    check("и список стал видимым", p.id("unused-section").isVisible(), true);

    /*
     * Самое опасное место: вкладка исчезает под руками. Владелец стоит на
     * «не используется», файл убран — панели не должно остаться без единой
     * видимой вкладки и без выхода.
     */
    p.tick(baseReport({ items: [] }));
    check("вкладка исчезла — вернулись на «ПАНЕЛЬ»", p.activeTab(), "ПАНЕЛЬ");
    check("видимая панель есть", p.visiblePanes(), ["main"]);
    check("пустых вкладок не осталось",
        p.tabTitles(), ["ПАНЕЛЬ", "ЖУРНАЛ", "НАСТРОЙКИ"]);
})();

group("Вкладки: когда их нет");
(function () {
    /* Проект не сохранён — рабочая папка неизвестна, делать нечего. */
    var p = launch({ report: baseReport({ saved: false }) });
    check("полоса вкладок скрыта", p.id("tabs").hidden, true);
    check("но главная панель на месте", p.visiblePanes(), ["main"]);
    check("и статус объясняет почему",
        p.id("status").textContent, "СОХРАНИТЕ ПРОЕКТ");
})();

/* ========================================================= места блоков */

group("Каждый блок в своей вкладке");
(function () {
    var p = launch();
    function inPane(block, pane) {
        return p.id(block).descends(p.id("pane-" + pane));
    }

    check("«не используется» — во вкладке unused",
        inPane("unused-section", "unused"), true);
    check("«дубликаты» — во вкладке duplicates",
        inPane("duplicates-section", "duplicates"), true);
    check("«старый проект» — во вкладке legacy",
        inPane("legacy-section", "legacy"), true);
    check("настройки — во вкладке settings", inPane("settings", "settings"), true);
    check("метрики и события — в журнале",
        [inPane("stats-section", "journal"), inPane("log-section", "journal")],
        [true, true]);
    check("забытые слои — во вкладке layers",
        inPane("layers-section", "layers"), true);
    check("легенда, диск, облако, проблемы, очередь — на главной",
        ["legend", "disk-row", "cloud-row",
            "issues-section", "queue-section"].map(function (b) {
            return inPane(b, "main");
        }), [true, true, true, true, true]);

    /* То, ради чего панель открывают, не должно прятаться ни за одной вкладкой. */
    var alwaysOn = ["status", "counts", "run-now", "update", "tabs"];
    check("статус, счётчики и «разложить сейчас» — над вкладками",
        alwaysOn.map(function (b) {
            return ["main", "layers", "unused", "duplicates", "legacy", "journal", "settings"]
                .some(function (n) { return p.id(b).descends(p.id("pane-" + n)); });
        }), [false, false, false, false, false]);
})();

group("«hidden» действительно прячет");
(function () {
    /*
     * Самая дорогая ошибка всей панели была не в логике, а в стилях, и
     * поэтому весь остальной набор её не видел: мок читает свойство
     * `hidden`, а браузер — CSS. Панель честно ставила `hidden`, а авторское
     * `display: flex` его перебивало — вкладки не переключались, баннер не
     * закрывался, легенда не складывалась. Проверяем сам файл стилей.
     */
    var css = fs.readFileSync(path.join(__dirname, "..", "extension",
        "com.pard.defender", "client", "styles.css"), "utf8");

    check("есть правило, делающее hidden сильнее оформления",
        /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css), true);

    /* Оно одно такое: второй !important на display снова сделает блок
     * нескрываемым, и уже незаметно. */
    var forced = css.match(/display:[^;}]*!important/g) || [];
    check("и оно единственный !important на display", forced.length, 1);

    /*
     * И оно не декорация: блоки, которые панель прячет, до сих пор
     * ставят себе display — без правила всё вернётся точно как было.
     */
    function setsDisplay(cls) {
        /* Разбираем по правилам, а не регуляркой: имя класса должно совпасть
         * целиком, иначе «pane» найдётся внутри «pane-head». */
        var blocks = css.split("}"), i, open, selector, body;
        for (i = 0; i < blocks.length; i++) {
            open = blocks[i].lastIndexOf("{");
            if (open < 0) continue;
            selector = blocks[i].substring(0, open);
            body = blocks[i].substring(open + 1);
            if (body.indexOf("display:") < 0) continue;
            var at = selector.indexOf("." + cls);
            while (at >= 0) {
                var next = selector.charAt(at + cls.length + 1);
                if (!next || " ,.:>+~\r\n\t".indexOf(next) >= 0) return true;
                at = selector.indexOf("." + cls, at + 1);
            }
        }
        return false;
    }
    check("правило несущее: эти классы без него не спрятать",
        ["pane", "tabs", "update", "legend-body"].map(setsDisplay),
        [true, true, true, true]);
})();

/* ============================================================== кнопки */

group("Легенда сворачивается");
(function () {
    var p = launch();
    check("сначала развёрнута", p.id("legend-body").hidden, false);
    check("и стрелка смотрит вниз", p.id("legend-caret").textContent, "▾");

    p.click("legend-toggle");
    check("нажатие свернуло тело", p.id("legend-body").hidden, true);
    check("стрелка развернулась", p.id("legend-caret").textContent, "▸");

    var saved = p.calls.settings[p.calls.settings.length - 1];
    check("и это запомнено в настройках проекта", saved.legendOpen, false);

    p.click("legend-toggle");
    check("второе нажатие возвращает", p.id("legend-body").hidden, false);
})();

group("Баннер новой версии закрывается");
(function () {
    /* Владелец не смог закрыть его в 1.2.x: кнопка была голым глифом в
     * приглушённом цвете и читалась как украшение. */
    var p = launch();
    check("баннер показан", p.id("update").hidden, false);
    check("и называет версию", p.id("update-version").textContent, "9.9.9");

    p.click("update-dismiss");
    check("крестик прячет баннер", p.id("update").hidden, true);
    check("и версия запомнена", p.calls.dismissed, ["9.9.9"]);

    /* Словесная кнопка — для тех, кто ищет слова, а не значок. */
    var p2 = launch();
    p2.click("update-later");
    check("«Скрыть» делает ровно то же", p2.id("update").hidden, true);
    check("и тоже запоминает версию", p2.calls.dismissed, ["9.9.9"]);
})();

group("Кнопки, уходящие в хост");
(function () {
    var p = launch();

    p.click("open-folder");
    check("«Открыть» показывает рабочую папку",
        p.calls.revealed.indexOf("workspace") >= 0, true);

    var before = p.calls.scripts.length;
    p.click("run-now");
    check("«Разложить сейчас» что-то делает",
        p.calls.scripts.length >= before, true);

    p.click("verify-all");
    check("«Сверить всё» не роняет панель", p.id("status").textContent !== "", true);

    p.click("cloud-pin");
    check("«Закрепить на компьютере» вызывает закрепление", p.calls.pinned, 1);
})();

group("Настройки пишут то, что показывают");
(function () {
    var p = launch();

    p.change("auto-enabled", function (el) { el.checked = true; });
    check("автоматический режим включился",
        p.calls.settings[p.calls.settings.length - 1].autoEnabled, true);

    p.change("copy-enabled", function (el) { el.checked = false; });
    check("копирование выключилось",
        p.calls.settings[p.calls.settings.length - 1].copyEnabled, false);

    p.change("organize-enabled", function (el) { el.checked = false; });
    check("группировка выключилась",
        p.calls.settings[p.calls.settings.length - 1].organizePanelEnabled, false);

    p.change("scan-interval", function (el) { el.value = "7"; });
    check("интервал проверки — в миллисекундах",
        p.calls.settings[p.calls.settings.length - 1].scanIntervalMs, 420000);

    p.change("settle-delay", function (el) { el.value = "15"; });
    check("задержка перед переносом — тоже",
        p.calls.settings[p.calls.settings.length - 1].settleDelayMs, 900000);
})();

group("Опасные кнопки требуют второго нажатия");
(function () {
    var loose = protectedItem("loose.mp4", { id: 10 });
    write(meta + "/assets.tsv", manifestRow(loose) + "\n");
    var p = launch({ report: baseReport({ items: [loose] }) });

    var button = p.id("clean-unused");
    check("сначала обычная надпись",
        button.textContent, "УБРАТЬ НЕИСПОЛЬЗУЕМЫЕ В КОРЗИНУ");

    p.click("clean-unused");
    check("первое нажатие взводит и называет цифру",
        button.textContent.indexOf("ПОДТВЕРДИТЬ") === 0, true);
    check("и ничего ещё не удалено", p.calls.recycled.length, 0);

    p.click("clean-unused");
    check("второе нажатие отправляет в корзину", p.calls.recycled.length, 1);
    check("и именно тот файл", p.calls.recycled[0], [loose.path]);
})();

group("Старый проект: обе кнопки в два нажатия");
(function () {
    var stray = protectedItem("stray.mp4", { id: 11, unassigned: false, misplaced: true });
    /* Манифеста для него нет: это и делает файл «чужим», оставшимся от
     * времён до расширения. */
    write(meta + "/assets.tsv", "");
    var p = launch({ report: baseReport({ items: [stray] }) });

    var adopt = p.id("legacy-adopt");
    check("секция видна", p.id("legacy-section").hidden, false);

    p.click("legacy-adopt");
    check("«оставить как есть» сначала переспрашивает",
        adopt.textContent.indexOf("ПОДТВЕРДИТЬ") === 0, true);
    check("и настроек ещё не тронуло", p.calls.settings.length, 0);

    p.click("legacy-adopt");
    var saved = p.calls.settings[p.calls.settings.length - 1];
    check("второе нажатие объявляет элемент неприкосновенным",
        saved.adoptedItems, ["11"]);
    check("и перераспределение при этом выключено",
        saved.legacyRedistribute, false);

    /* Вторая кнопка - противоположный ответ. */
    var p2 = launch({ report: baseReport({ items: [stray] }) });
    p2.click("legacy-redistribute");
    check("«разложить всё» тоже переспрашивает",
        p2.id("legacy-redistribute").textContent.indexOf("ПОДТВЕРДИТЬ") === 0, true);
    p2.click("legacy-redistribute");
    var saved2 = p2.calls.settings[0];
    check("второе нажатие включает режим", saved2.legacyRedistribute, true);
    check("и снимает прежнее «оставить как есть»", saved2.adoptedItems, []);

    /* Галочка про корзину. */
    var p3 = launch({ report: baseReport({ items: [stray] }) });
    p3.change("legacy-recycle", function (el) { el.checked = false; });
    check("отказ от корзины сохраняется",
        p3.calls.settings[0].legacyRecycleOld, false);
})();

group("Строки списков живые");
(function () {
    var finding = {
        kind: "layer", key: "L14|1453|Слой 3", compId: "14", compName: "Интро",
        layerIndex: 3, layerName: "Слой 3", itemId: "1453", itemName: "spare.mp4",
        path: "E:/raw/spare.mp4", size: 2048, status: "open"
    };
    var p = launch({ layers: layersReport([finding]) });

    var section = p.id("layers-section");
    check("секция забытых слоёв показана", section.hidden, false);

    var buttons = p.id("layers").all().filter(function (n) {
        return n.tagName === "BUTTON";
    });
    check("в строке есть кнопки", buttons.length > 0, true);
    check("и у каждой свой обработчик",
        buttons.filter(function (b) { return !b.onclick; }).length, 0);

    /* Кнопка «пометить забытым» должна дойти до настроек. */
    var flagged = false;
    buttons.forEach(function (b) {
        if (flagged) return;
        b.onclick();
        var last = p.calls.settings[p.calls.settings.length - 1];
        if (last && last.disabledLayerForgotten &&
            last.disabledLayerForgotten.length) { flagged = true; }
    });
    check("одна из кнопок помечает слой забытым", flagged, true);
})();

group("Ручное обновление забытых слоёв");
(function () {
    var finding1 = {
        kind: "layer", key: "L14|1453|Слой 3", compId: "14", compName: "Интро",
        layerIndex: 3, layerName: "Слой 3", itemId: "1453", itemName: "spare.mp4",
        path: "E:/raw/spare.mp4", size: 2048, status: "open"
    };
    var finding2 = {
        kind: "layer", key: "L14|1454|Слой 4", compId: "14", compName: "Интро",
        layerIndex: 4, layerName: "Слой 4", itemId: "1454", itemName: "extra.mp4",
        path: "E:/raw/extra.mp4", size: 1024, status: "open"
    };

    /* 1. У кнопки есть обработчик и правильный title. */
    var p = launch({
        report: baseReport({ settings: { scanIntervalMs: 60000 } }),
        layers: layersReport([finding1])
    });
    var btn = p.id("layers-refresh");
    check("кнопка обновления списка слоёв существует", !!btn, true);
    check("title кнопки: Обновить список", btn.title, "Обновить список");
    check("у кнопки есть обработчик", typeof btn.onclick, "function");

    /* 2. Нажатие запускает новый scan, даже если интервал ещё не истёк. */
    var initialScans = p.calls.scripts.filter(function (s) {
        return s.indexOf("scanLayersToFile") >= 0;
    }).length;
    p.tick();
    var scansAfterTick = p.calls.scripts.filter(function (s) {
        return s.indexOf("scanLayersToFile") >= 0;
    }).length;
    check("таймер аудита не сканирует раньше интервала", scansAfterTick, initialScans);

    p.click("layers-refresh");
    var scansAfterClick = p.calls.scripts.filter(function (s) {
        return s.indexOf("scanLayersToFile") >= 0;
    }).length;
    check("нажатие запускает scan в обход интервала", scansAfterClick, initialScans + 1);

    /* 3. Изменённый mocked layer report немедленно обновляет или скрывает секцию. */
    /* 3a: новые находки немедленно отрисовываются */
    write(layersPath, JSON.stringify(layersReport([finding2])));
    p.click("layers-refresh");
    var names = p.id("layers").all().filter(function (n) {
        return n.hasClass("layer-name");
    }).map(function (n) { return n.textContent; });
    check("список обновился на новые находки", names, ["Слой 4"]);

    /* 3b: пустой отчёт скрывает секцию и убирает вкладку */
    write(layersPath, JSON.stringify(layersReport([])));
    p.click("layers-refresh");
    check("секция слоёв скрыта при отсутствии находок", p.id("layers-section").hidden, true);
    check("вкладка забытых слоёв исчезла", p.tabTitles().indexOf("ВЫКЛЮЧЕНО И ЗАБЫТО"), -1);

    /* 4. Повторное нажатие при pending callback не запускает параллельный scan. */
    write(layersPath, JSON.stringify(layersReport([finding1])));
    var p2 = launch({ layers: layersReport([finding1]) });
    var pendingCb = null;
    var interceptedScans = 0;
    var originalEval = p2.sandbox.window.__adobe_cep__.evalScript;
    p2.sandbox.window.__adobe_cep__.evalScript = function (script, cb) {
        if (script.indexOf("scanLayersToFile") >= 0) {
            interceptedScans++;
            pendingCb = cb;
            return;
        }
        originalEval(script, cb);
    };

    p2.click("layers-refresh");
    check("первый scan отправлен в хост", interceptedScans, 1);
    check("кнопка заблокирована во время запроса (disabled)", p2.id("layers-refresh").disabled, true);
    check("на кнопке виден busy-state", p2.id("layers-refresh").hasClass("busy"), true);

    p2.click("layers-refresh");
    check("повторное нажатие не запустило параллельный scan", interceptedScans, 1);

    pendingCb("OK|" + layersPath);
    check("после завершения кнопка снова разблокирована", p2.id("layers-refresh").disabled, false);

    /* 5. Ошибка оставляет прежние findings и позволяет retry. */
    p2.sandbox.window.__adobe_cep__.evalScript = function (script, cb) {
        if (script.indexOf("scanLayersToFile") >= 0) {
            cb("ERROR|FAIL");
            return;
        }
        originalEval(script, cb);
    };

    var logsBefore = p2.id("log").children.length;
    p2.click("layers-refresh");
    var layerRows = p2.id("layers").all().filter(function (n) {
        return n.hasClass("layer-row");
    });
    check("ошибка сохранила прежние находки", layerRows.length, 1);
    check("секция осталась видимой", p2.id("layers-section").hidden, false);
    check("в журнал записано предупреждение об ошибке",
        p2.id("log").children.length > logsBefore &&
        p2.id("log").children[0].textContent.indexOf("Не удалось обновить список слоёв") >= 0, true);
    check("кнопка снова разрешена для retry", p2.id("layers-refresh").disabled, false);

    /* Повторная попытка (retry) успешна */
    p2.sandbox.window.__adobe_cep__.evalScript = originalEval;
    p2.click("layers-refresh");
    check("retry успешно завершился без блокировки кнопки", p2.id("layers-refresh").disabled, false);

    /* 6. Неизменившийся refresh не создаёт лишних записей innerHTML. */
    dom.resetHtmlWrites();
    p2.click("layers-refresh");
    check("неизменившийся refresh не создаёт лишних innerHTML-записей", dom.htmlWriters(), []);

    /* Защита от устаревшего callback: устаревший callback не перезаписывает результат */
    var delayedCb = null;
    p2.sandbox.window.__adobe_cep__.evalScript = function (script, cb) {
        if (script.indexOf("scanLayersToFile") >= 0) {
            delayedCb = cb;
            return;
        }
        originalEval(script, cb);
    };
    p2.click("layers-refresh");
    var otherProj = baseReport({ settings: { scanLayersEnabled: false } });
    otherProj.projectPath = workspace + "/04_edit/OtherProject.aep";
    p2.tick(otherProj);
    delayedCb("OK|" + layersPath);
    check("устаревший callback не восстановил список слоёв в новом проекте",
        p2.id("layers-section").hidden, true);
})();

group("Проблемы: строка и её кнопки");
(function () {
    /*
     * Защищённый файл, который исчез с диска. After Effects об этом не узнает
     * до рендера — сверка узнаёт сразу, и строка обязана появиться с рабочими
     * кнопками, а не просто с текстом.
     */
    var gone = protectedItem("gone.mp4", { id: 20, unassigned: false });
    write(meta + "/assets.tsv", manifestRow(gone) + "\n");
    fs.unlinkSync(native(gone.path));

    var p = launch({ report: baseReport({ items: [gone] }) });

    check("секция проблем показана", p.id("issues-section").hidden, false);
    check("и в заголовке счётчик",
        p.id("issues-title").textContent.indexOf("ПРОБЛЕМЫ (") === 0, true);

    var rows = p.id("issues").children;
    check("строка ровно одна", rows.length, 1);

    var buttons = rows[0].all().filter(function (n) { return n.tagName === "BUTTON"; });
    check("в строке есть действия", buttons.length > 0, true);
    check("и у каждого есть обработчик",
        buttons.filter(function (b) { return !b.onclick; }).length, 0);

    /* Ни одно из действий не должно ронять панель. */
    var threw = "";
    buttons.forEach(function (b) {
        try { b.onclick(); } catch (e) { threw = String(e); }
    });
    check("все действия отрабатывают", threw, "");
})();

group("Очередь: то, что ждёт копирования");
(function () {
    var pending = {
        key: "i30", id: "30", isProxy: false, name: "fresh.mp4",
        path: "E:/Downloads/fresh.mp4", ext: "mp4", category: "video",
        routeKey: "video", isSequence: false, sequence: null,
        branch: "Интро", branchResolved: "Интро", unassigned: false,
        forcedUnused: false, adopted: false, size: 4096, state: "pending",
        destRel: "01_assets/Интро/VIDEO", destFile: "fresh.mp4",
        destPath: workspace + "/01_assets/Интро/VIDEO/fresh.mp4",
        misplaced: false, panelTarget: "02_ASSETS/Интро/VIDEO",
        panelPath: "", panelEligible: false, hasProxy: false
    };
    var queued = baseReport({
        items: [pending],
        counts: {
            total: 1, protected_: 0, pending: 1, missing: 0, trusted: 0,
            unassigned: 0, panelMoves: 0, misplaced: 0, adopted: 0, proxies: 0
        }
    });
    var p = launch({ report: queued });

    check("секция очереди показана", p.id("queue-section").hidden, false);
    check("в ней одна строка", p.id("queue").children.length, 1);
    check("строка называет файл",
        p.id("queue").children[0].textContent.indexOf("fresh.mp4") >= 0, true);
    check("счётчики показывают очередь",
        p.id("counts").textContent.indexOf("В очереди 1") >= 0, true);

    /*
     * В ручном режиме статус говорит именно про него: пока автоматика
     * выключена, «в очереди» ничего не объясняет — владелец и так знает, что
     * само оно не поедет.
     */
    check("при выключенной автоматике статус про неё",
        p.id("status").textContent, "РУЧНОЙ РЕЖИМ");

    var auto = baseReport({
        items: [pending],
        settings: { autoEnabled: true },
        counts: queued.counts
    });
    p.tick(auto);
    check("включили автоматику — статус про очередь",
        p.id("status").textContent, "В ОЧЕРЕДИ");
})();

group("Лестница статусов");
(function () {
    /*
     * Порядок важнее текста: сначала то, что мешает работать, и только потом
     * то, что просто ждёт. Проверяем именно порядок.
     */
    var p = launch({ report: baseReport({ settings: { autoEnabled: true } }) });
    check("кнопки «возобновить» не видно", p.id("resume").hidden, true);
    check("на чистом проекте — под защитой", p.id("status").textContent, "ПОД ЗАЩИТОЙ");
    check("и статус зелёный", p.id("status").className.indexOf("green") >= 0, true);

    /* Потерянный исходник. */
    var lost = protectedItem("lost.mp4", { id: 40, unassigned: false });
    lost.state = "missing";
    p.tick(baseReport({
        items: [lost],
        settings: { autoEnabled: true },
        counts: {
            total: 1, protected_: 0, pending: 0, missing: 1, trusted: 0,
            unassigned: 0, panelMoves: 0, misplaced: 0, adopted: 0, proxies: 0
        }
    }));
    check("потерянный исходник виден в статусе",
        p.id("status").textContent, "ЕСТЬ ПОТЕРЯННЫЕ");
    check("и он жёлтый", p.id("status").className.indexOf("yellow") >= 0, true);

    /* Проблема перебивает потерю: с ней ничего не поедет. */
    var gone = protectedItem("gone2.mp4", { id: 41, unassigned: false });
    write(meta + "/assets.tsv", manifestRow(gone) + "\n");
    fs.unlinkSync(native(gone.path));
    p.tick(baseReport({
        items: [gone],
        settings: { autoEnabled: true },
        counts: {
            total: 1, protected_: 1, pending: 0, missing: 0, trusted: 0,
            unassigned: 0, panelMoves: 0, misplaced: 0, adopted: 0, proxies: 0
        }
    }));
    check("проблема поднимается выше потери",
        p.id("status").textContent, "ЕСТЬ ПРОБЛЕМЫ");

    /* Несохранённый проект перебивает всё: рабочая папка неизвестна. */
    p.tick(baseReport({ saved: false }));
    check("несохранённый проект — важнее всего",
        p.id("status").textContent, "СОХРАНИТЕ ПРОЕКТ");
    check("и он красный", p.id("status").className.indexOf("red") >= 0, true);
})();

group("Облачная папка");
(function () {
    var p = launch();
    check("строка облака показана", p.id("cloud-row").hidden, false);
    check("и называет клиента",
        p.id("cloud-text").textContent.indexOf("Яндекс.Диск") === 0, true);
    check("кнопка закрепления доступна", p.id("cloud-pin").hidden, false);

    p.click("cloud-pin");
    check("после закрепления кнопка уходит", p.id("cloud-pin").hidden, true);
    check("и текст меняется на «всегда на этом компьютере»",
        p.id("cloud-text").textContent.indexOf("всегда на этом компьютере") > 0, true);
})();

group("Показ в проводнике не срывается в процессы");
(function () {
    var loose = protectedItem("loose.mp4", { id: 10 });
    write(meta + "/assets.tsv", manifestRow(loose) + "\n");
    var p = launch({ report: baseReport({ items: [loose] }) });

    var asked = [];
    p.sandbox.PardHousekeeping.revealFile = function (target) {
        asked.push(target);
        return { ok: true, code: "selected", path: target };
    };

    p.click("unused-reveal");
    check("кнопка папки спрашивает про файл из списка", asked, [loose.path]);
})();

group("Вкладка исчезает вместе с проектом");
(function () {
    var loose = protectedItem("loose.mp4", { id: 10 });
    write(meta + "/assets.tsv", manifestRow(loose) + "\n");
    var p = launch({ report: baseReport({ items: [loose] }) });

    var tabs = p.id("tabs");
    tabs.children.forEach(function (b) {
        if (b.textContent === "ЖУРНАЛ") b.onclick();
    });
    check("стоим на журнале", p.activeTab(), "ЖУРНАЛ");

    /*
     * Проект закрыли. Ни одной вкладки, кроме главной, не остаётся — панель
     * обязана вернуть владельца туда, а не оставить его смотреть в пустоту.
     */
    p.tick(baseReport({ saved: false }));
    check("вернулись на главную", p.visiblePanes(), ["main"]);
    check("полоса вкладок скрыта", p.id("tabs").hidden, true);
})();

group("Смена проекта обнуляет сессию");
(function () {
    var loose = protectedItem("loose.mp4", { id: 10 });
    write(meta + "/assets.tsv", manifestRow(loose) + "\n");
    var p = launch({ report: baseReport({ items: [loose] }) });

    var tabs = p.id("tabs");
    tabs.children.forEach(function (b) {
        if (b.textContent === "НАСТРОЙКИ") b.onclick();
    });
    check("стоим на настройках", p.activeTab(), "НАСТРОЙКИ");

    /* Открыли другой проект. */
    var other = baseReport();
    other.projectPath = workspace + "/04_edit/Other.aep";
    p.tick(other);
    check("новый проект открывается на «Панели»", p.activeTab(), "ПАНЕЛЬ");
    check("и показывает главную панель", p.visiblePanes(), ["main"]);
})();

/* =================================================== дисциплина перерисовки */

group("Перерисовка без изменений не трогает списки");
(function () {
    /*
     * innerHTML сбрасывает scrollTop. Пересборка списка, который не менялся,
     * — это не лишняя работа, а именно то, из-за чего панель однажды стало
     * невозможно прокрутить. Правило держалось только на аккуратности.
     */
    var loose = protectedItem("loose.mp4", { id: 10 });
    write(meta + "/assets.tsv", manifestRow(loose) + "\n");
    var report = baseReport({ items: [loose] });
    var finding = {
        kind: "comp", key: "C14", compId: "14", compName: "TEASER",
        layerIndex: 0, layerName: "", itemId: "", path: "", size: 0, status: "open"
    };
    var p = launch({ report: report, layers: layersReport([finding]) });

    var afterBoot = dom.htmlWrites();
    check("на первой отрисовке списки собираются", afterBoot > 0, true);

    dom.resetHtmlWrites();
    p.tick(report);
    p.tick(report);
    p.tick(report);
    check("три прохода без изменений — ни одной пересборки",
        dom.htmlWriters(), []);

    /* А изменение обязано дойти. */
    dom.resetHtmlWrites();
    p.tick(baseReport({ items: [] }));
    check("исчезнувший файл список перестраивает", dom.htmlWrites() > 0, true);
})();

group("Копирование требует долговечного журнала и манифеста");
(function () {
    function pendingItem(id, name) {
        var source = root + "/external/" + name;
        var destination = workspace + "/01_assets/Интро/VIDEO/" + name;
        write(source, "source-" + name);
        return {
            key: "i" + id, id: String(id), isProxy: false,
            name: name, path: source, ext: "mp4", category: "video",
            routeKey: "video", isSequence: false, sequence: null,
            branch: "Интро", branchResolved: "Интро", unassigned: false,
            forcedUnused: false, adopted: false, size: 12, state: "pending",
            destRel: "01_assets/Интро/VIDEO", destFile: name,
            destPath: destination, misplaced: false,
            panelTarget: "02_ASSETS/Интро/VIDEO", panelPath: "",
            panelEligible: false, hasProxy: false
        };
    }

    var journalItem = pendingItem("90", "journal.mp4");
    var p = launch({ report: baseReport({ items: [journalItem] }) });
    var originalWrite = p.sandbox.PardCopyQueue.writeText;
    var runs = 0;
    p.sandbox.PardCopyQueue.writeText = function (target, content) {
        if (/pending\.tsv$/.test(target)) return false;
        return originalWrite(target, content);
    };
    p.sandbox.PardCopyQueue.run = function () { runs++; };
    p.click("run-now");
    check("без pending.tsv копирование не начинается", runs, 0);
    check("без журнала хост не получает relink",
        p.calls.scripts.some(function (s) { return s.indexOf("commitFromFileJson") >= 0; }), false);

    var manifestItem = pendingItem("91", "manifest.mp4");
    var p2 = launch({ report: baseReport({ items: [manifestItem] }) });
    p2.sandbox.PardCopyQueue.run = function (tasks, options, hooks, done) {
        done([{
            ok: true, key: "i91", id: "91", destPath: manifestItem.destPath,
            files: 1, bytes: 12, reusedFiles: 0, reusedBytes: 0,
            records: [{ sourcePath: manifestItem.path, destPath: manifestItem.destPath,
                size: 12, created: true }], sources: [manifestItem.path]
        }]);
    };
    p2.sandbox.PardCopyQueue.appendText = function () { return false; };
    p2.click("run-now");
    check("при ошибке assets.tsv relink не выполняется",
        p2.calls.scripts.some(function (s) { return s.indexOf("commitFromFileJson") >= 0; }), false);
    check("pending.tsv оставлен для диагностики",
        fs.existsSync(native(meta + "/pending.tsv")), true);

    /* Equal bytes at an unowned path are useful for relink, but they are not
     * proof that PardDefender created the file. */
    write(meta + "/assets.tsv", "");
    var reusedItem = pendingItem("92", "preexisting.mp4");
    write(reusedItem.destPath, "source-preexisting.mp4");
    var p3 = launch({ report: baseReport({ items: [reusedItem] }) });
    p3.sandbox.PardCopyQueue.run = function (tasks, options, hooks, done) {
        done([{
            ok: true, key: "i92", id: "92", destPath: reusedItem.destPath,
            files: 0, bytes: 0, reusedFiles: 1, reusedBytes: 22,
            records: [{ sourcePath: reusedItem.path, destPath: reusedItem.destPath,
                size: 22, created: false }], sources: [reusedItem.path]
        }]);
    };
    p3.click("run-now");
    check("чужой переиспользованный файл не попал в assets.tsv",
        fs.readFileSync(native(meta + "/assets.tsv"), "utf8"), "");
})();

group("Очистка секвенции забирает все принадлежащие нам кадры");
(function () {
    var seqDir = workspace + "/01_assets/00_UNUSED/SEQUENCES/shot";
    var frame1 = seqDir + "/shot_0001.png";
    var frame2 = seqDir + "/shot_0002.png";
    write(frame1, "one");
    write(frame2, "two");
    write(meta + "/assets.tsv", [
        ["2026-08-30", "i93", root + "/raw/shot_0001.png", "3", frame1,
            "00_UNUSED", "image"].join("\t"),
        ["2026-08-30", "i93", root + "/raw/shot_0002.png", "3", frame2,
            "00_UNUSED", "image"].join("\t")
    ].join("\n") + "\n");
    var item = {
        key: "i93", id: "93", isProxy: false, name: "shot_[0001-0002].png",
        path: frame1, category: "image", isSequence: true,
        branch: "", branchResolved: "00_UNUSED", unassigned: true,
        forcedUnused: false, state: "protected", size: 3,
        destPath: seqDir, panelEligible: false, misplaced: false
    };
    var p = launch({ report: baseReport({ items: [item] }) });
    p.click("clean-unused");
    p.click("clean-unused");
    check("в Корзину переданы оба кадра", p.calls.recycled[0].sort(),
        [frame1, frame2].sort());
})();

/* ============================================================= дубликаты */

group("Отчёт о дубликатах: вкладка, скан, progress/cancel, canonical, stale и безопасность");
(function () {
    function pendingItem(id, name) {
        var source = root + "/external/" + name;
        var destination = workspace + "/01_assets/Интро/VIDEO/" + name;
        write(source, "source-" + name);
        return {
            key: "i" + id, id: String(id), isProxy: false,
            name: name, path: source, ext: "mp4", category: "video",
            routeKey: "video", isSequence: false, sequence: null,
            branch: "Интро", branchResolved: "Интро", unassigned: false,
            forcedUnused: false, adopted: false, size: 12, state: "pending",
            destRel: "01_assets/Интро/VIDEO", destFile: name,
            destPath: destination, misplaced: false,
            panelTarget: "02_ASSETS/Интро/VIDEO", panelPath: "",
            panelEligible: false, hasProxy: false
        };
    }

    var d1 = pendingItem("101", "file_a.mp4");
    var d2 = pendingItem("102", "file_b.mp4");
    write(d1.path, "IDENTICAL_DUPLICATE_BYTES_12345");
    write(d2.path, "IDENTICAL_DUPLICATE_BYTES_12345");

    var p = launch({ report: baseReport({ items: [d1, d2] }) });

    // 1. До первого скана вкладки дубликатов нет
    check("до первого скана вкладки дубликатов нет",
        p.tabTitles().some(function (t) { return t.indexOf("ДУБЛИКАТЫ") >= 0; }), false);
    check("кнопка поиска дубликатов в панели активна",
        p.id("duplicates-scan").disabled, false);

    // 2. Запуск сканирования через mock PardDuplicateIndex.scan
    p.sandbox.PardDuplicateIndex.scan = function (opts, cb) {
        cb(null, {
            ok: true,
            scannedFiles: 2,
            hashedFiles: 2,
            scannedSequences: 0,
            duplicateGroups: [{
                groupId: "group-1",
                kind: "file",
                contentId: "hash_abc_123",
                size: 1024,
                reclaimableBytes: 1024,
                recommendedCanonical: d1.path,
                reasons: ["Файл проверен и принадлежит проекту (assets.tsv)"],
                files: [
                    { path: d1.path, isOwned: true, inWorkspace: true, references: ["101"] },
                    { path: d2.path, isOwned: false, inWorkspace: false, references: ["102"] }
                ]
            }],
            errors: [
                { code: "MISSING", path: root + "/missing.mp4", message: "Файл отсутствует" }
            ],
            reclaimableBytes: 1024
        });
    };

    p.click("duplicates-scan");
    check("после скана появилась вкладка ДУБЛИКАТЫ с бейджем 1",
        p.tabTitles().indexOf("ДУБЛИКАТЫ1") >= 0, true);

    // Переключение на вкладку дубликатов
    var tabs = p.id("tabs");
    var dupTabBtn = null;
    tabs.children.forEach(function (b) {
        if (b.textContent.indexOf("ДУБЛИКАТЫ") >= 0) dupTabBtn = b;
    });
    check("кнопка вкладки дубликатов создана", !!dupTabBtn, true);
    if (dupTabBtn) dupTabBtn.onclick();
    check("активная вкладка ДУБЛИКАТЫ", p.activeTab(), "ДУБЛИКАТЫ1");
    check("видна панель duplicates", p.visiblePanes(), ["duplicates"]);

    // 3. Отображение группы и каноникала
    var dupList = p.id("duplicates-list");
    var groupEl = dupList.children[0];
    check("в списке есть группа", !!groupEl, true);
    check("в группе 2 файла", groupEl.all().filter(function (n) {
        return n.className && n.className.indexOf("duplicate-file-row") >= 0;
    }).length, 2);

    var canonicalBadges = groupEl.all().filter(function (n) {
        return n.className === "canonical-badge";
    });
    check("ровно один каноникал помечен бейджем", canonicalBadges.length, 1);

    // 4. Ручной выбор каноникала
    var radios = groupEl.all().filter(function (n) {
        return n.tagName === "INPUT" && (n.type === "radio" || n.attributes.type === "radio");
    });
    check("в группе 2 радиокнопки выбора каноникала", radios.length, 2);
    var uncheckedRadio = radios.filter(function (r) { return !r.checked; })[0];
    check("нашли неактивный файл для каноникала", !!uncheckedRadio, true);
    if (uncheckedRadio) {
        uncheckedRadio.checked = true;
        if (uncheckedRadio.onchange) uncheckedRadio.onchange();
    }

    check("переопределение каноникала сохранено в настройках",
        p.calls.settings.length > 0 && !!p.calls.settings[p.calls.settings.length - 1].duplicateCanonicalOverrides, true);

    // 5. Устаревание после изменения аудита проекта
    check("до изменения аудита отчёт свежий", p.id("duplicates-stale").hidden, true);
    var d3 = pendingItem("103", "file_c.mp4");
    p.tick(baseReport({ items: [d1, d2, d3] }));
    check("после изменения аудита отчёт помечен как устаревший",
        p.id("duplicates-stale").hidden, false);
    check("кнопка предлагает обновить",
        p.id("duplicates-scan").textContent, "ОБНОВИТЬ ДУБЛИКАТЫ");

    // 6. Прогресс и токен отмены
    var scanOptsReceived = null;
    p.sandbox.PardDuplicateIndex.scan = function (opts, cb) {
        scanOptsReceived = opts;
        opts.onProgress({
            phase: "hash", current: 1, total: 2, percent: 50,
            scannedFiles: 1, totalFiles: 2, scannedBytes: 100, totalBytes: 200
        });
        check("progress заполняет процент", p.id("duplicates-progress-fill").style.width, "50%");
        p.click("duplicates-cancel");
        check("токен отмены выставлен", opts.cancelToken.cancelled, true);
        cb(new Error("CANCELLED"), null);
    };
    p.click("duplicates-scan");
    check("после отмены группа не потеряна (прежний результат сохранён)",
        p.id("duplicates-list").children.length > 0, true);

    // 7. Ошибка скана без потери последнего результата
    p.sandbox.PardDuplicateIndex.scan = function (opts, cb) {
        cb(new Error("DISK_FAULT"), null);
    };
    p.click("duplicates-scan");
    check("при ошибке скана список групп не очищен",
        p.id("duplicates-list").children.length > 0, true);
    check("ошибка записана в журнал",
        p.id("log").children[0].textContent.indexOf("DISK_FAULT") >= 0, true);

    // 8. Дисциплина перерисовки: неизменившийся скан не трогает innerHTML списка
    p.sandbox.PardDuplicateIndex.scan = function (opts, cb) {
        cb(null, {
            ok: true, scannedFiles: 2, hashedFiles: 2, scannedSequences: 0,
            duplicateGroups: [{
                groupId: "group-1", kind: "file", contentId: "hash123",
                size: 100, reclaimableBytes: 100, recommendedCanonical: d1.path,
                reasons: ["проверен"], files: [
                    { path: d1.path, isOwned: true, references: ["101"] },
                    { path: d2.path, isOwned: false, references: ["102"] }
                ]
            }],
            errors: [],
            reclaimableBytes: 100
        });
    };
    p.click("duplicates-scan"); // sets the group
    dom.resetHtmlWrites();
    p.tick(); // re-render
    var writers = dom.htmlWriters();
    check("неизменившийся рендер не трогает duplicates-list innerHTML",
        writers.filter(function (w) { return w === "duplicates-list"; }).length, 0);

    // 9. Read-only: никаких relink/recycle/delete вызовов
    var relinkCalls = p.calls.scripts.filter(function (s) {
        return s.indexOf("replace") >= 0 || s.indexOf("commitFromFileJson") >= 0 || s.indexOf("removeItems") >= 0;
    });
    check("read-only UI дубликатов ни разу не вызывал relink в хосте", relinkCalls.length, 0);
    check("read-only UI дубликатов ни разу не вызывал recycle", p.calls.recycled.length, 0);
})();

/* ------------------------------------------------------------------ итог */

try { fs.rmSync(native(root), { recursive: true, force: true }); } catch (e) {}

console.log("\n" + (failed === 0
    ? "Все проверки пройдены: " + passed
    : "Пройдено " + passed + ", провалено " + failed));

process.exit(failed === 0 ? 0 : 1);
