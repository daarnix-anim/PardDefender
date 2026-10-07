/*
 * @map role: Исполнение панели Premiere: аудиомаршруты, AE-метки, relink и сбои.
 * @map status: ready
 */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const engine = require("../premiere/com.pard.defender.uxp/copy-engine");
let checks = 0;
function check(v, msg) { assert.ok(v, msg); checks++; }
function element() {
    return {
        events: {},
        children: [], textContent: "", style: {}, classList: { add() {}, remove() {} },
        get firstChild() { return this.children[0]; },
        get innerHTML() { return ""; }, set innerHTML(value) { this.children = []; },
        removeChild(el) { this.children.splice(this.children.indexOf(el), 1); },
        appendChild(el) { this.children.push(el); },
        addEventListener(name, fn) { this.events[name] = fn; },
        async click(target) { if (this.disabled) return; if (this.events.click) await this.events.click({ target: target || this }); else if (this.onclick) await this.onclick({ target: target || this }); },
        querySelectorAll() { return []; }, setAttribute() {}, getAttribute() {}
    };
}
function launch(options) {
    const html = fs.readFileSync(path.join(__dirname, "../premiere/com.pard.defender.uxp/index.html"), "utf8");
    const ids = new Set(Array.from(html.matchAll(/id="([^"]+)"/g), m => m[1]));
    const o = options || {}, elements = {}, items = o.items || [{
        id: "audio", path: "d:/Project/03_audio/music/Untitled.wav", name: "Untitled.wav",
        binPath: "Dialogue", classification: "clip", usedOnTimeline: true,
        _projectItem: {}, _nativeItem: {}
    }, {
        id: "image", path: "d:/Project/01_assets/picture.png", name: "picture.png",
        classification: "clip", usedOnTimeline: true,
        crossHost: { isAeProtected: true, sharedInProject: true, canonicalPath: "d:/Project/01_assets/picture.png" }
    }];
    const report = { ok: true, projectSaved: true, workspace: o.workspace || "d:/Project", projectId: "pr-1",
        projectPath: "d:/Project/04_edit/test.prproj", items, stats: {}, diagnostics: o.diagnostics || [] };
    report.aeProtectedItems = o.aeProtectedItems || [];
    const calls = { tasks: [], relinks: [], snapshots: [], saves: 0, reveals: [], audits: [] };
    const project = { guid: "pr-1", save: async () => { calls.saves++; return true; } };
    const adapter = {
        normalizePath: engine.normalizePath, resolveActiveProjectSync: () => project,
        resolveActiveProject: async () => project,
        identifyProject: () => ({ projectId: o.switched ? "pr-2" : "pr-1", projectPath: report.projectPath }),
        auditMedia: (p, opts, cb) => {
            calls.audits.push(opts);
            cb(null, o.splitAudit && opts.timelineOnly ? Object.assign({}, report, { items: items.filter(it => it.usedOnTimeline) }) : report);
        },
        revealItem: async item => { calls.reveals.push(item); return { ok: true }; }
    };
    const copy = o.realCopy ? engine : Object.assign({}, engine, {
        loadWorkspaceMeta: () => ({}),
        runQueue: (ws, tasks, opts, cb) => {
            calls.tasks = tasks;
            Promise.resolve().then(() => cb.onDone({ ok: true, results: tasks.map(t => ({
                ok: !o.failCopy, error: o.failCopy ? "fs.lstat: доступ запрещён" : null,
                id: t.id, item: t.item, destPath: t.destPath, sourcePath: t.sourcePath
            })) }));
        },
        relinkClip: async (item, dest, expected) => {
            calls.relinks.push({ dest, expected });
            return o.failRelink ? { ok: false, reason: "test relink failed" } : { ok: true };
        }
    });
    const document = {
        readyState: "complete",
        getElementById(id) { return ids.has(id) ? (elements[id] || (elements[id] = element())) : null; },
        createElement: element, addEventListener() {}
    };
    const sandbox = {
        document, console: o.quiet ? { log() {} } : console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
        localStorage: { getItem: () => null, setItem() {} },
        PardPremiereAdapter: adapter, PardPremiereCopyEngine: copy,
        PardPremiereDuplicates: require("../premiere/com.pard.defender.uxp/duplicates.js"),
        PardSyncCoordinator: { publishSnapshot: (ws, snap) => calls.snapshots.push(snap), loadSnapshot: () => null },
        require(name) { if (name === "fs") return {}; if (name === "path") return path; throw Error(name); },
        window: { addEventListener() {} }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../premiere/com.pard.defender.uxp/main.js"), "utf8"), sandbox);
    return { calls, elements, report, api: sandbox.window.PardPremiere };
}
async function finish(panel) {
    for (let i = 0; i < 2000 && panel.api.state.protecting; i++) await new Promise(r => setTimeout(r, 1));
    check(!panel.api.state.protecting, "Busy flag cleared");
}
(async function () {
    let p = launch();
    const cards = p.elements["items-list"].children;
    check(JSON.stringify(cards).includes("AE защита"), "Same-path AE media has AE protection badge");
    check(!JSON.stringify(cards).includes("ОБЩИЙ В ПРОЕКТЕ"), "Old shared badge removed");
    await p.elements["btn-protect"].click(); await finish(p);
    check(p.calls.tasks.length === 1, "Internal audio outside its proper role folder is protected");
    check(p.calls.tasks[0].destPath === "d:/Project/03_audio/voice/Untitled.wav", "Dialogue bin wins audio routing");
    check(p.calls.relinks[0].expected === "d:/Project/03_audio/music/Untitled.wav", "Relink checks expected old path");
    check(p.calls.saves === 1, "Project saved after relink");
    check(p.calls.snapshots.some(s => s.items.some(i => i.oldPath === "d:/Project/03_audio/music/Untitled.wav")), "Old audio link retained in shared snapshot");
    p = launch({ failRelink: true }); p.api.protectExternalMedia(); await finish(p);
    check(p.elements["banner-protect-status"].textContent.includes("ошибок"), "Relink failure is not reported as full success");
    check(!p.elements["banner-protect-status"].hidden, "Audit does not erase relink errors");
    p = launch({ failCopy: true }); await p.elements["btn-protect"].click(); await finish(p);
    check(!p.elements["banner-protect-status"].hidden && p.elements["banner-protect-status"].textContent.includes("доступ запрещён"), "Copy error stays visible after audit");
    check(p.calls.relinks.length === 0 && p.calls.saves === 0, "Failed copy never relinks or saves");
    await p.elements["btn-scan"].click();
    check(!p.elements["banner-protect-status"].hidden, "Manual scan also preserves result");
    check(!p.elements["btn-pause-project"] && !p.elements["btn-reload-ui"] && !p.elements["btn-quick-scan"] && !p.elements["btn-scan-dup-pane"], "Duplicate controls absent from real markup");
    await p.elements["items-list"].children[0].click();
    check(p.calls.reveals[0] === p.report.items[0]._projectItem, "Row opens the original ProjectItem, not its ClipProjectItem wrapper");
    await p.elements["items-list"].children[0].click({ tagName: "SELECT" });
    check(p.calls.reveals.length === 1, "Audio role dropdown does not open Source Monitor");
    p = launch({ quiet: true, items: [{ id: "v", name: "External.mp4", path: "e:/Raw/External.mp4",
        classification: "clip", usedOnTimeline: true, _projectItem: {}, _nativeItem: {} }, {
        id: "a", name: "Music.wav", path: "e:/Raw/Music.wav", binPath: "Music",
        classification: "clip", usedOnTimeline: true, _projectItem: {}, _nativeItem: {}
    }, { id: "s", name: "Timeline", classification: "sequence", usedOnTimeline: true }] });
    function view(name, value) { p.elements[name].value = value; p.elements[name].events.change(); }
    function visibleCards() { return p.elements["items-list"].children.filter(el => el.className.includes("media-item-card")); }
    const originalOrder = p.report.items.map(it => it.id).join(",");
    const snapshotsBeforeFilter = p.calls.snapshots.length;
    check(visibleCards()[0].className.includes("media-video") && visibleCards()[1].className.includes("media-audio"), "Media gets subtle type-specific styling");
    view("items-filter", "sequence");
    check(visibleCards().length === 1 && p.elements["items-visible"].textContent === "1 / 3", "Sequence filter and visible/total counter");
    view("items-filter", "image");
    check(visibleCards().length === 0 && p.elements["items-list"].children[0].textContent.includes("Все типы"), "Empty filter explains how to restore the list");
    check(p.calls.snapshots.length === snapshotsBeforeFilter, "View controls do not write cross-host metadata");
    await p.elements["btn-protect"].click(); await finish(p);
    check(p.calls.tasks.length === 2 && p.calls.relinks.length === 2, "Protection still handles BOTH hidden external video and audio");
    check(p.calls.snapshots.some(s => s.items.some(it => it.itemId === "v" || it.id === "v")), "Hidden media remains in the cross-host snapshot");
    view("items-filter", "all"); view("items-group", "format");
    const headers = p.elements["items-list"].children.filter(el => el.className === "media-group-heading").map(el => el.textContent);
    check(headers.includes("MP4") && headers.includes("WAV") && headers.includes("Секвенции"), "Format groups distinguish actual extensions and sequences without paths");
    view("items-group", "type");
    check(visibleCards().length === 3, "Grouping retains all project items");
    check(p.report.items.map(it => it.id).join(",") === originalOrder, "View ordering never mutates the audit report");
    view("items-group", "none");
    check(visibleCards()[0].children[0].children[0].textContent === "External.mp4", "Reset restores project order");
    p.report.projectSaved = false;
    p.api.triggerAudit(); view("items-filter", "audio");
    check(visibleCards().length === 0, "Changing filter cannot reveal stale items of an unsaved project");
    p = launch({ switched: true }); p.api.protectExternalMedia(); await finish(p);
    check(p.calls.relinks.length === 0, "Switching project blocks stale relink");
    // Full button -> real files -> official-style asynchronous relink -> save.
    const temp = fs.mkdtempSync(path.join(require("os").tmpdir(), "pard-panel-protect-"));
    const workspace = path.join(temp, "Проект");
    const sources = ["Ролик из загрузок.mp4", "Main.mp4"].map((name, i) => {
        const source = path.join(temp, name);
        fs.writeFileSync(source, Buffer.alloc(270000 + i, i + 17));
        let current = source;
        return {
            id: "video-" + i, name, path: source, classification: "clip", usedOnTimeline: true,
            _nativeItem: {
                getMediaFilePath: async () => current,
                canChangeMediaPath: async () => true,
                changeMediaFilePath: async (next, override) => {
                    assert.strictEqual(override, false);
                    assert.ok(fs.readFileSync(next).equals(fs.readFileSync(source)));
                    current = next; return true;
                }
            }
        };
    });
    const limitedFs = {};
    ["lstat", "lstatSync", "readFile", "readFileSync", "writeFile", "writeFileSync", "mkdir", "rename", "unlink", "readdir", "readdirSync", "open", "close", "read", "write"].forEach(name => limitedFs[name] = fs[name].bind(fs));
    engine.setFs(limitedFs);
    p = launch({ realCopy: true, workspace, items: sources });
    await p.elements["btn-protect"].click(); await finish(p);
    check(p.calls.saves === 1, "Real two-video protection saves project once");
    for (let i = 0; i < sources.length; i++) {
        const original = path.join(temp, sources[i].name);
        const linked = await sources[i]._nativeItem.getMediaFilePath();
        check(engine.normalizePath(linked).startsWith(engine.normalizePath(workspace) + "/01_assets/"), "MP4 relinked inside assets");
        check(fs.readFileSync(original).equals(fs.readFileSync(linked)), "External MP4 retained and protected copy matches");
    }
    check(!p.elements["banner-protect-status"].hidden && p.elements["banner-protect-status"].textContent.includes("перелинковано 2"), "Full two-video result stays visible");
    const aeCanonical = path.join(workspace, "01_assets", "AE-original.mp4");
    fs.writeFileSync(aeCanonical, "IDENTICAL-DUPLICATES");
    const duplicateItems = ["Timeline.mp4", "Bin-only.mp4"].map((name, i) => {
        const source = path.join(temp, name);
        fs.writeFileSync(source, "IDENTICAL-DUPLICATES");
        let current = source;
        return { id: "dup-" + i, name, path: source, binPath: "Imported/Nested",
            classification: "clip", usedOnTimeline: i === 0, _nativeItem: {
                getMediaFilePath: async () => current, canChangeMediaPath: async () => true,
                changeMediaFilePath: async (next, override) => { assert.strictEqual(override, false); current = next; return true; }
            } };
    });
    p = launch({ quiet: true, realCopy: true, workspace, splitAudit: true, items: duplicateItems,
        aeProtectedItems: [{ canonicalPath: aeCanonical, isAeProtected: true }] });
    check(p.api.state.lastReport.items.length === 1, "Protection audit starts with timeline media only");
    p.api.state.lastReport = null;
    await p.elements["btn-scan-duplicates"].click();
    check(p.calls.audits[p.calls.audits.length - 1].timelineOnly === false, "Duplicates button always requests a fresh full library audit without requiring protection scan");
    const duplicateGroup = p.api.state.duplicatesResult.duplicateGroups[0];
    check(duplicateGroup.projectItemCount === 2 && duplicateGroup.timelineItemCount === 1, "Full library duplicates include unused nested-bin sources");
    check(JSON.stringify(p.elements["duplicates-list"].children).includes("ОРИГИНАЛ AE"), "Verified AE canonical is labelled as the original");
    check(!p.elements["duplicates-summary"].textContent.includes("Освободится"), "UI does not promise disk space after a relink");
    await p.api.executeConsolidation(duplicateGroup, aeCanonical);
    check(p.calls.audits.filter(opts => opts.timelineOnly === false).length >= 3, "Consolidation reaudits the full project before changes and refreshes duplicates afterward");
    check(p.calls.saves === 1, "Consolidation saves the matching Premiere project");
    check(duplicateItems.every(it => engine.normalizePath(it.path) === engine.normalizePath(aeCanonical)), "Both timeline and bin-only sources relink to the existing AE canonical");
    check(p.calls.snapshots.some(s => s.items.some(it => it.id === "dup-1" && it.oldPath && it.contentId)), "Bin-only consolidation links and content identity are published for cross-host reuse");
    check(p.api.state.duplicatesResult.duplicateGroups[0].kind === "project-items" &&
        !JSON.stringify(p.elements["duplicates-list"].children).includes("ОБЪЕДИНИТЬ В ОДИН ФАЙЛ"), "Shared-path project items remain visible without another consolidation action");
    check(!p.api.state.consolidating && !p.api.state.duplicateScanning, "Duplicate busy flags clear after save and refresh");
    p = launch({ quiet: true, diagnostics: ["Одна и та же диагностика клипа"] });
    for (let i = 0; i < 340; i++) p.api.triggerAudit();
    const logLines = p.elements["log-box"].children;
    check(logLines.length === 300, "Visible journal is bounded despite repeated scans");
    check(!logLines.some(line => line.textContent.includes("Одна и та же диагностика клипа")), "Unchanged per-clip diagnostics are not repeated on every scan");
    await p.elements["btn-clear-log"].click();
    check(p.elements["log-box"].children.length === 0, "Clear button removes visible rows");
    const css = fs.readFileSync(path.join(__dirname, "../premiere/com.pard.defender.uxp/styles.css"), "utf8");
    const boxStyle = css.match(/\.log-box\s*\{([^}]+)\}/)[1];
    const lineStyle = css.match(/\.log-line\s*\{([^}]+)\}/)[1];
    check(/display:\s*block/.test(boxStyle) && !/display:\s*flex/.test(boxStyle), "Long journal cannot shrink rows in a fixed-height flex column");
    check(/white-space:\s*pre-wrap/.test(lineStyle) && /line-height:\s*18px/.test(lineStyle), "Multiline errors and file paths have readable spacing");
    console.log("Итоги: пройдено " + checks + ", провалено 0");
})().catch(e => { console.error(e); process.exitCode = 1; });
