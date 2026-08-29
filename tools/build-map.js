/*
 * PardDefender - project map generator.
 *
 * @map layer: tools
 * @map role: Строит карту проекта из самого кода — граф связей выводится из
 *            исходников, а не ведётся руками
 * @map status: ready
 *
 * Writes two artefacts from one scan:
 *
 *   PROJECT_MAP.md        what an agent or a new chat reads first
 *   docs/project-map.html interactive graph for a human
 *
 * The dependency edges are DERIVED FROM THE CODE, never declared by hand: which
 * global a file defines, which globals it references, which host functions the
 * client calls, which scripts the panel loads. A hand-maintained graph goes
 * stale the first time somebody is in a hurry; a derived one cannot.
 *
 * Only the one-line role and the status come from the files themselves, as an
 * "@map" block in the header comment - right next to the code it describes, so
 * it is edited together with it. A file WITHOUT such a block still appears on
 * the map, marked "не описан", which is how a newly added file announces itself
 * instead of quietly going missing.
 *
 *   node tools/build-map.js
 *   node tools/build-map.js --check    exit 1 if the map is out of date
 */
"use strict";

var fs = require("fs");
var path = require("path");

var ROOT = path.resolve(__dirname, "..");
var CHECK_ONLY = process.argv.indexOf("--check") >= 0;

var SCAN = [
    "extension/com.pard.defender/CSXS",
    "extension/com.pard.defender/client",
    "extension/com.pard.defender/host",
    "tests",
    "tools"
];

var ROOT_FILES = [
    "README.md", "CLAUDE.md", "PROJECT_MAP.md",
    "INSTALL_DEV_WINDOWS.bat", "UNINSTALL_DEV_WINDOWS.bat"
];

var LAYERS = {
    host: { title: "Хост (ExtendScript в After Effects)", color: "#c9822e" },
    client: { title: "Клиент (CEP + Node)", color: "#5b8fd0" },
    ui: { title: "Интерфейс панели", color: "#8a6fc4" },
    config: { title: "Конфигурация расширения", color: "#6c6c6c" },
    tests: { title: "Тесты", color: "#5ab552" },
    tools: { title: "Инструменты", color: "#d8a13a" },
    install: { title: "Установка", color: "#6c6c6c" },
    docs: { title: "Документация", color: "#8f8f8f" }
};

var STATUS = {
    ready: { title: "работает", color: "#5ab552" },
    partial: { title: "работает частично", color: "#d8a13a" },
    planned: { title: "запланировано", color: "#5b8fd0" },
    broken: { title: "требует правок", color: "#d05353" },
    undocumented: { title: "не описан", color: "#d05353" }
};

/* ------------------------------------------------------------------ scan */

function read(relative) {
    try { return fs.readFileSync(path.join(ROOT, relative), "utf8"); }
    catch (e) { return null; }
}

function listFiles(dir) {
    var out = [];
    var full = path.join(ROOT, dir);
    var names;
    try { names = fs.readdirSync(full); } catch (e) { return out; }
    names.sort().forEach(function (name) {
        var rel = dir + "/" + name;
        var stats;
        try { stats = fs.statSync(path.join(ROOT, rel)); } catch (e2) { return; }
        if (stats.isDirectory()) { out = out.concat(listFiles(rel)); return; }
        out.push(rel);
    });
    return out;
}

function layerOf(rel) {
    if (rel.indexOf("/host/") >= 0) return "host";
    if (rel.indexOf("/CSXS/") >= 0) return "config";
    if (rel.indexOf("/client/") >= 0) {
        return /\.(html|css)$/i.test(rel) ? "ui" : "client";
    }
    if (rel.indexOf("tests/") === 0) return "tests";
    if (rel.indexOf("tools/") === 0) return "tools";
    if (/\.bat$/i.test(rel)) return "install";
    return "docs";
}

/*
 * The "@map" block. Continuation lines are joined, so a long role can be wrapped
 * to fit the comment column without changing what the map says.
 */
function parseMapBlock(source) {
    var out = {};
    if (!source) return out;
    var lines = source.split(/\r?\n/);
    var i, match, lastKey = "";
    for (i = 0; i < lines.length && i < 60; i++) {
        match = /@map\s+([a-z]+)\s*:\s*(.*)$/i.exec(lines[i]);
        if (match) {
            lastKey = match[1].toLowerCase();
            out[lastKey] = match[2].replace(/\s+$/, "");
            continue;
        }
        /* A bare " *   continued text" line right after an @map line. */
        if (lastKey && /^\s*\*\s{2,}\S/.test(lines[i]) && !/@map/.test(lines[i])) {
            out[lastKey] += " " + lines[i].replace(/^\s*\*\s+/, "").replace(/\s+$/, "");
            continue;
        }
        lastKey = "";
    }
    return out;
}

function scan() {
    var files = [];
    SCAN.forEach(function (dir) { files = files.concat(listFiles(dir)); });
    ROOT_FILES.forEach(function (name) {
        if (fs.existsSync(path.join(ROOT, name))) files.push(name);
    });

    return files.map(function (rel) {
        var source = read(rel) || "";
        var meta = parseMapBlock(source);
        var declaredLayer = meta.layer && LAYERS[meta.layer] ? meta.layer : layerOf(rel);
        var documented = !!meta.role;

        return {
            id: rel,
            name: rel.replace(/^.*\//, ""),
            layer: declaredLayer,
            role: meta.role || "",
            status: documented ? (STATUS[meta.status] ? meta.status : "ready")
                : (/\.(md|css|xml|bat)$/i.test(rel) ? "ready" : "undocumented"),
            note: meta.note || "",
            bytes: source.length,
            lines: source ? source.split(/\r?\n/).length : 0,
            source: source
        };
    });
}

/* ------------------------------------------------------------------ links */

/*
 * Everything below reads the actual source. Nothing here can drift from the
 * code, because the code is the only input.
 */
function link(nodes) {
    var edges = [];
    var byId = {}, byName = {};
    nodes.forEach(function (n) { byId[n.id] = n; byName[n.name] = n; });

    function add(from, to, kind) {
        if (!from || !to || from === to) return;
        var key = from + "->" + to + ":" + kind;
        if (edges.some(function (e) { return e.key === key; })) return;
        edges.push({ key: key, from: from, to: to, kind: kind });
    }

    /* Which file defines which client global, and which host function. */
    var providesGlobal = {}, providesHostFn = {};
    nodes.forEach(function (n) {
        var m;
        var globalRe = /var\s+(Pard[A-Za-z0-9_]+)\s*=\s*\(function/g;
        while ((m = globalRe.exec(n.source))) providesGlobal[m[1]] = n.id;

        var hostRe = /\bhost\.([A-Za-z0-9_]+)\s*=\s*function/g;
        while ((m = hostRe.exec(n.source))) providesHostFn[m[1]] = n.id;
    });

    nodes.forEach(function (n) {
        var m;

        /* client module -> client module, through the globals it references */
        var useRe = /\b(Pard[A-Za-z0-9_]+)\b/g;
        while ((m = useRe.exec(n.source))) {
            var owner = providesGlobal[m[1]];
            if (owner && owner !== n.id) add(n.id, owner, "uses");
        }

        /* client -> host, through the host functions it calls by name */
        var callRe = /PardDefenderHost\.([A-Za-z0-9_]+)/g;
        while ((m = callRe.exec(n.source))) {
            var target = providesHostFn[m[1]];
            if (target && target !== n.id) add(n.id, target, "calls");
        }

        /* the panel page -> the scripts it loads, in load order */
        if (/\.html$/i.test(n.id)) {
            var scriptRe = /<script\s+src="([^"]+)"/g;
            while ((m = scriptRe.exec(n.source))) {
                var sibling = byName[m[1].replace(/^.*\//, "")];
                if (sibling) add(n.id, sibling.id, "loads");
            }
            var cssRe = /<link[^>]+href="([^"]+\.css)"/g;
            while ((m = cssRe.exec(n.source))) {
                var sheet = byName[m[1].replace(/^.*\//, "")];
                if (sheet) add(n.id, sheet.id, "loads");
            }
        }

        /* main.js -> host modules, in the order it evalFiles them */
        var hostListRe = /"(PardDefender[A-Za-z]+\.jsx)"/g;
        while ((m = hostListRe.exec(n.source))) {
            var hostFile = byName[m[1]];
            if (hostFile) add(n.id, hostFile.id, "loads");
        }

        /* tests -> whatever they load by file name */
        if (n.layer === "tests") {
            var fileRe = /"([A-Za-z0-9_.\-]+\.(?:js|jsx))"/g;
            while ((m = fileRe.exec(n.source))) {
                var covered = byName[m[1]];
                if (covered && covered.id !== n.id) add(n.id, covered.id, "covers");
            }
            var reqRe = /require\("\.\/([A-Za-z0-9_.\-]+)"\)/g;
            while ((m = reqRe.exec(n.source))) {
                var helper = byName[m[1] + ".js"] || byName[m[1]];
                if (helper) add(n.id, helper.id, "covers");
            }
        }
    });

    return edges;
}

/* ----------------------------------------------------------------- layout */

/*
 * One column per layer, in the order the data actually flows: the host on the
 * left, the client that drives it, the page that loads the client, then the
 * tests and everything around them.
 *
 * Dependency-depth columns were tried first and read badly - almost every file
 * has no dependencies of its own, so twenty of them piled into a single column
 * and the whole graph collapsed into a stripe. Layer columns stay balanced,
 * match how a person describes the project out loud, and - because the order is
 * fixed - a node never jumps between builds, which keeps the diffs readable.
 */
var COLUMN_ORDER = ["host", "client", "ui", "tests", "tools", "install", "config", "docs"];

function layout(nodes) {
    var columns = {};

    nodes.slice().sort(function (a, b) {
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    }).forEach(function (n) {
        var index = COLUMN_ORDER.indexOf(n.layer);
        if (index < 0) index = COLUMN_ORDER.length;
        n.column = index;
        columns[index] = columns[index] || [];
        n.row = columns[index].length;
        columns[index].push(n);
    });

    /* Drop empty columns so the graph has no unexplained gaps. */
    var used = Object.keys(columns).map(Number).sort(function (a, b) { return a - b; });
    var slot = {};
    used.forEach(function (c, i) { slot[c] = i; });

    var NODE_W = 196, NODE_H = 58, GAP_X = 64, GAP_Y = 18;
    var maxX = 0, maxY = 0;

    nodes.forEach(function (n) {
        n.x = 40 + slot[n.column] * (NODE_W + GAP_X);
        n.y = 78 + n.row * (NODE_H + GAP_Y);
        n.w = NODE_W;
        n.h = NODE_H;
        if (n.x + n.w > maxX) maxX = n.x + n.w;
        if (n.y + n.h > maxY) maxY = n.y + n.h;
    });

    /* Column headings live above the first row. */
    var headings = used.map(function (c) {
        return {
            title: (LAYERS[COLUMN_ORDER[c]] || { title: "Прочее" }).title,
            color: (LAYERS[COLUMN_ORDER[c]] || { color: "#6c6c6c" }).color,
            x: 40 + slot[c] * (NODE_W + GAP_X),
            y: 52,
            count: columns[c].length
        };
    });

    return { width: maxX + 40, height: maxY + 40, headings: headings };
}

/* --------------------------------------------------------------- markdown */

function markdown(nodes, edges, size) {
    var lines = [];
    var incoming = {};
    edges.forEach(function (e) {
        (incoming[e.to] = incoming[e.to] || []).push(e.from);
    });

    lines.push("# Карта проекта PardDefender");
    lines.push("");
    lines.push("<!-- СГЕНЕРИРОВАНО tools/build-map.js — правки будут затёрты.");
    lines.push("     Чтобы изменить описание файла, отредактируйте блок @map в его шапке. -->");
    lines.push("");
    lines.push("Файлов: **" + nodes.length + "** · связей: **" + edges.length +
        "** · собрано: " + new Date().toISOString().replace("T", " ").substring(0, 16));
    lines.push("");
    lines.push("Визуальная карта: [`docs/project-map.html`](docs/project-map.html) — " +
        "откройте в браузере, узлы кликабельны.");
    lines.push("");

    var undocumented = nodes.filter(function (n) { return n.status === "undocumented"; });
    var attention = nodes.filter(function (n) {
        return n.status === "broken" || n.status === "partial" || n.status === "planned";
    });

    if (undocumented.length || attention.length) {
        lines.push("## Требует внимания");
        lines.push("");
        attention.forEach(function (n) {
            lines.push("- **" + n.name + "** — " + STATUS[n.status].title +
                (n.note ? ". " + n.note : ""));
        });
        undocumented.forEach(function (n) {
            lines.push("- **" + n.name + "** — не описан: добавьте блок `@map` " +
                "в шапку файла (`" + n.id + "`)");
        });
        lines.push("");
    }

    Object.keys(LAYERS).forEach(function (layer) {
        var group = nodes.filter(function (n) { return n.layer === layer; });
        if (!group.length) return;

        lines.push("## " + LAYERS[layer].title);
        lines.push("");
        group.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
        group.forEach(function (n) {
            lines.push("### `" + n.name + "`");
            lines.push("");
            lines.push("`" + n.id + "` · " + n.lines + " строк · " +
                STATUS[n.status].title);
            lines.push("");
            if (n.role) lines.push(n.role);
            else lines.push("_Описание не задано._");
            lines.push("");

            /*
             * Two files can be linked by more than one kind of edge - main.js
             * both loads a host module and calls into it. The graph keeps those
             * apart; a prose list should say the name once.
             */
            function uniqueNames(ids) {
                var seen = {}, out = [];
                ids.forEach(function (id) {
                    var name = id.replace(/^.*\//, "");
                    if (seen[name]) return;
                    seen[name] = true;
                    out.push("`" + name + "`");
                });
                return out;
            }

            var outgoing = uniqueNames(edges
                .filter(function (e) { return e.from === n.id; })
                .map(function (e) { return e.to; }));
            if (outgoing.length) {
                lines.push("Использует: " + outgoing.join(", "));
                lines.push("");
            }
            var inbound = uniqueNames(incoming[n.id] || []);
            if (inbound.length) {
                lines.push("Используется в: " + inbound.join(", "));
                lines.push("");
            }
        });
    });

    return lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------- html */

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function html(nodes, edges, size) {
    var payload = {
        nodes: nodes.map(function (n) {
            return {
                id: n.id, name: n.name, layer: n.layer, role: n.role,
                status: n.status, note: n.note, lines: n.lines,
                x: n.x, y: n.y, w: n.w, h: n.h
            };
        }),
        edges: edges.map(function (e) {
            return { from: e.from, to: e.to, kind: e.kind };
        }),
        layers: LAYERS,
        status: STATUS,
        width: size.width,
        height: size.height,
        headings: size.headings,
        builtAt: new Date().toISOString()
    };

    var template = read("tools/map-template.html");
    if (!template) throw new Error("tools/map-template.html не найден");
    return template.replace("/*__MAP_DATA__*/null",
        JSON.stringify(payload).replace(/</g, "\\u003c"));
}

/* ------------------------------------------------------------------- main */

function writeIfChanged(rel, content) {
    var full = path.join(ROOT, rel);
    var existing = null;
    try { existing = fs.readFileSync(full, "utf8"); } catch (e) {}

    /* The build timestamp changes every run; ignore it when comparing so an
     * unchanged project does not produce an endless diff. */
    function strip(text) {
        return String(text || "")
            .replace(/собрано: [0-9\-: ]+/g, "")
            .replace(/"builtAt":"[^"]*"/g, "");
    }
    if (existing !== null && strip(existing) === strip(content)) return false;
    if (CHECK_ONLY) return true;

    try { fs.mkdirSync(path.dirname(full), { recursive: true }); } catch (e2) {}
    fs.writeFileSync(full, content, "utf8");
    return true;
}

function main() {
    var nodes = scan();
    var edges = link(nodes);
    var size = layout(nodes);

    var changedMd = writeIfChanged("PROJECT_MAP.md", markdown(nodes, edges, size));
    var changedHtml = writeIfChanged("docs/project-map.html", html(nodes, edges, size));

    var undocumented = nodes.filter(function (n) { return n.status === "undocumented"; });

    if (CHECK_ONLY) {
        if (changedMd || changedHtml) {
            console.log("Карта устарела. Запустите: node tools/build-map.js");
            process.exit(1);
        }
        console.log("Карта актуальна (" + nodes.length + " файлов, " +
            edges.length + " связей).");
        return;
    }

    console.log("Карта собрана: " + nodes.length + " файлов, " + edges.length + " связей.");
    console.log("  PROJECT_MAP.md" + (changedMd ? " — обновлён" : " — без изменений"));
    console.log("  docs/project-map.html" + (changedHtml ? " — обновлён" : " — без изменений"));
    if (undocumented.length) {
        console.log("");
        console.log("Без блока @map (" + undocumented.length + "):");
        undocumented.forEach(function (n) { console.log("  " + n.id); });
    }
}

main();
