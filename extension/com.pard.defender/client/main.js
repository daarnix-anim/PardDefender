/*
 * PardDefender - panel orchestrator.
 *
 * @map role: Оркестратор панели: владеет таймерами, решает когда
 *           действовать, собирает планы для хоста и рисует интерфейс.
 * @map status: ready
 *
 * Owns the clock and every decision about WHEN to act. The host reports state;
 * only this side knows how long an element has been sitting in the project,
 * whether its bytes have stopped changing, and how many times it has failed.
 *
 * Two rules learned the hard way on a live project:
 *
 *   - Never send a move the host will treat as a no-op. Doing so made every
 *     pass report "work done", which scheduled another audit, which built the
 *     same moves again: 1873 passes in thirteen minutes.
 *   - Never rebuild a list that has not changed. innerHTML resets scroll
 *     position, so a five-second repaint made the panel impossible to scroll.
 */
(function () {
    "use strict";

    var HOST_MODULES = [
        "PardDefenderCore.jsx",
        "PardDefenderPlan.jsx",
        "PardDefenderAudit.jsx",
        "PardDefenderApply.jsx"
    ];

    var TICK_MS = 5000;
    var STABILITY_MS = 5000;
    var MAX_LOG_ROWS = 60;
    var BREAKER_THRESHOLD = 3;
    var WEIGH_INTERVAL_MS = 300000;
    var CONFIRM_WINDOW_MS = 6000;

    var state = {
        hostReady: false,
        hostError: "",
        busy: false,
        report: null,
        settings: null,
        workspace: "",
        projectPath: "",
        seen: {},
        disk: null,
        weight: null,
        lastWeighAt: 0,
        lastAuditAt: 0,
        log: [],
        paused: null,
        update: null,
        version: "1.0.0",
        confirmCleanupUntil: 0
    };

    var el = {};
    var painted = {};

    /* ------------------------------------------------------------- plumbing */

    function evalScript(script, callback) {
        if (!window.__adobe_cep__ || !window.__adobe_cep__.evalScript) {
            callback("EvalScript error.");
            return;
        }
        window.__adobe_cep__.evalScript(script, callback);
    }

    function escapeForExtendScript(value) {
        return String(value || "")
            .replace(/\\/g, "\\\\")
            .replace(/'/g, "\\'")
            .replace(/[\r\n]/g, "");
    }

    function extensionRoot() {
        var p = decodeURIComponent(window.location.pathname || "").replace(/\\/g, "/");
        if (/^\/[A-Za-z]:\//.test(p)) p = p.substring(1);
        var marker = p.lastIndexOf("/client/");
        return marker < 0 ? "" : p.substring(0, marker);
    }

    function tempRoot() {
        var os = null;
        try { os = require("os"); } catch (e) { os = null; }
        var base = os && os.tmpdir ? String(os.tmpdir()).replace(/\\/g, "/") : "";
        return (base || extensionRoot()) + "/parddefender-client";
    }

    function log(message, tone) {
        state.log.unshift({
            time: new Date(),
            message: String(message || ""),
            tone: tone || "neutral"
        });
        if (state.log.length > MAX_LOG_ROWS) state.log.length = MAX_LOG_ROWS;
        renderLog();
    }

    function formatBytes(n) { return PardDiskSpace.formatBytes(n); }

    /*
     * Repaints a section only when its content actually changed. Every list in
     * this panel is rebuilt with innerHTML, which resets scrollTop - so a
     * repaint on an unchanged list is not merely wasted work, it is the thing
     * that makes the panel jitter while the owner is trying to scroll it.
     */
    function changed(name, signature) {
        if (painted[name] === signature) return false;
        painted[name] = signature;
        return true;
    }

    function invalidate(name) { delete painted[name]; }

    /* --------------------------------------------------------- host loading */

    function loadHostModules(callback) {
        var root = extensionRoot();
        if (!root) {
            callback(false, "Не удалось определить папку расширения.");
            return;
        }

        var index = 0;
        function next() {
            if (index >= HOST_MODULES.length) {
                evalScript(
                    "(function(){try{return $.global.PardDefenderHost ? " +
                    "('OK|' + $.global.PardDefenderHost.version) : 'NO_API';}" +
                    "catch(e){return 'ERR|' + e.toString();}})()",
                    function (raw) {
                        var text = String(raw || "");
                        if (text.indexOf("OK|") === 0) {
                            callback(true, text.substring(3));
                            return;
                        }
                        callback(false, "Хост загрузился, но API недоступен: " + text);
                    }
                );
                return;
            }

            var file = root + "/host/" + HOST_MODULES[index++];
            var script = [
                "(function(){try{",
                "var f=new File('" + escapeForExtendScript(file) + "');",
                "if(!f.exists){return 'MISSING|'+f.fsName;}",
                "$.evalFile(f);",
                "return 'OK';",
                "}catch(e){return 'ERR|'+e.toString()+'|line='+(e.line||0);}})()"
            ].join("");

            evalScript(script, function (raw) {
                var text = String(raw || "");
                if (text === "OK") { next(); return; }
                callback(false, HOST_MODULES[index - 1] + ": " + text.replace(/\|/g, " — "));
            });
        }
        next();
    }

    /* --------------------------------------------------------------- audit */

    function runAudit(callback) {
        evalScript("$.global.PardDefenderHost.auditToFile();", function (raw) {
            var text = String(raw || "");
            if (text.indexOf("OK|") !== 0) {
                callback(null, text || "Аудит не вернул результат.");
                return;
            }
            var body = PardCopyQueue.readText(text.substring(3));
            if (!body) { callback(null, "Отчёт аудита не читается."); return; }
            var parsed = null;
            try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
            if (!parsed) { callback(null, "Отчёт аудита повреждён."); return; }
            callback(parsed, parsed.ok ? "" : parsed.error);
        });
    }

    /* ------------------------------------------------------- timing rules */

    function trackItem(key, size) {
        var now = Date.now();
        var record = state.seen[key];
        if (!record) {
            record = state.seen[key] = { firstSeen: now, size: size, stableSince: now };
            return record;
        }
        if (record.size !== size) {
            /* Bytes are still arriving - a render or a download in progress.
             * The stability clock restarts, the age clock does not. */
            record.size = size;
            record.stableSince = now;
        }
        return record;
    }

    function refreshTracking(report) {
        var alive = {}, i, item;
        for (i = 0; i < report.items.length; i++) {
            item = report.items[i];
            alive["i" + item.id] = true;
            trackItem("i" + item.id, item.size);
        }
        for (i = 0; i < report.comps.length; i++) {
            alive["c" + report.comps[i].id] = true;
            trackItem("c" + report.comps[i].id, 0);
        }
        var key;
        for (key in state.seen) {
            if (state.seen.hasOwnProperty(key) && !alive[key]) delete state.seen[key];
        }
        PardIssues.pruneMissing(alive);
    }

    function settled(key, force) {
        var record = state.seen[key];
        if (!record) return false;
        if (force) return true;
        if (Date.now() - record.stableSince < STABILITY_MS) return false;
        return Date.now() - record.firstSeen >= state.settings.settleDelayMs;
    }

    /*
     * Copying waits for the branch to be known. An element still not used in any
     * composition waits far longer, because the owner usually drops footage into
     * its composition within a minute or two - and waiting means the destination
     * is right the first time and never has to be moved again.
     */
    function readyToCopy(key, unassigned, force) {
        if (!settled(key, force)) return false;
        if (force || !unassigned) return true;
        var record = state.seen[key];
        return Date.now() - record.firstSeen >= state.settings.inboxTimeoutMs;
    }

    /*
     * Filing in the Project panel does NOT wait for the inbox timeout. Moving an
     * unused item into 00_UNUSED is precisely how the owner finds out it is
     * unused, and making them wait an hour for that defeats the purpose.
     */
    function readyToFile(key, force) { return settled(key, force); }

    /* ------------------------------------------------------------ the pass */

    function buildCopyTasks(report, force) {
        var tasks = [], i, item, key;
        for (i = 0; i < report.items.length; i++) {
            item = report.items[i];
            if (item.state !== "pending") continue;
            if (item.hasProxy) continue;
            if (!item.destPath) continue;

            key = "i" + item.id;
            /*
             * An element with a recorded failure only comes back when its
             * backoff has expired. Without this, a locked file would be retried
             * every three minutes forever and would fill the log with itself.
             */
            if (!force && !PardIssues.isDue(key)) continue;
            if (force && PardIssues.get(key)) PardIssues.retryNow(key);
            if (!readyToCopy(key, item.unassigned, force)) continue;

            tasks.push({
                id: item.id,
                name: item.name,
                sourcePath: item.path,
                destPath: item.destPath,
                isSequence: item.isSequence,
                sequence: item.sequence,
                size: item.size,
                branch: item.branchResolved,
                category: item.category
            });
            if (tasks.length >= state.settings.maxItemsPerPass) break;
        }
        return tasks;
    }

    function buildPanelMoves(report, force) {
        var moves = [], i, item, comp;

        for (i = 0; i < report.comps.length; i++) {
            comp = report.comps[i];
            if (!comp.eligible) continue;
            /* Already where it belongs - sending it would be a no-op, and a pass
             * made only of no-ops is what caused the audit loop. */
            if (comp.panelPath === comp.panelTarget) continue;
            if (!readyToFile("c" + comp.id, force)) continue;
            /* A render composition has an empty target, which the host reads as
             * "the Project root" - that is how one gets pulled back out of COMPS. */
            moves.push({ id: comp.id, target: comp.panelTarget });
        }

        for (i = 0; i < report.items.length; i++) {
            item = report.items[i];
            if (!item.panelEligible) continue;
            if (item.state === "missing") continue;
            if (item.panelPath === item.panelTarget) continue;
            if (!readyToFile("i" + item.id, force)) continue;
            moves.push({ id: item.id, target: item.panelTarget });
        }
        return moves;
    }

    function metadataDir() { return state.workspace + "/.parddefender"; }

    function journalTasks(tasks) {
        var lines = [], i, now = new Date().toISOString();
        for (i = 0; i < tasks.length; i++) {
            lines.push([now, tasks[i].id, tasks[i].sourcePath, tasks[i].destPath].join("\t"));
        }
        PardCopyQueue.writeText(metadataDir() + "/pending.tsv", lines.join("\n") + "\n");
    }

    function recordManifest(tasks, results) {
        var lines = [], i, r, task, byId = {};
        for (i = 0; i < tasks.length; i++) byId[tasks[i].id] = tasks[i];
        for (i = 0; i < results.length; i++) {
            r = results[i];
            if (!r.ok) continue;
            task = byId[r.id];
            if (!task) continue;
            lines.push([
                new Date().toISOString(), r.id, task.sourcePath, task.size,
                r.destPath, task.branch, task.category
            ].join("\t"));
        }
        if (lines.length) {
            PardCopyQueue.appendText(metadataDir() + "/assets.tsv", lines.join("\n") + "\n");
        }
    }

    function commitRelink(tasks, results, callback) {
        var entries = [], i, r, task, byId = {};
        for (i = 0; i < tasks.length; i++) byId[tasks[i].id] = tasks[i];
        for (i = 0; i < results.length; i++) {
            r = results[i];
            if (!r.ok || !r.destPath) continue;
            task = byId[r.id];
            if (!task) continue;
            entries.push({
                id: r.id,
                expectPath: task.sourcePath,
                destPath: r.destPath,
                isSequence: task.isSequence === true
            });
        }
        if (!entries.length) { callback({ relinked: 0, failures: [] }, "", entries); return; }

        var planPath = tempRoot() + "/relink-plan.json";
        if (!PardCopyQueue.writeText(planPath, JSON.stringify({ items: entries }))) {
            callback(null, "План перелинковки не удалось записать.", entries);
            return;
        }

        evalScript(
            "$.global.PardDefenderHost.commitFromFileJson('" +
            escapeForExtendScript(planPath) + "');",
            function (raw) {
                var parsed = null;
                try { parsed = JSON.parse(String(raw || "")); } catch (e) { parsed = null; }
                if (!parsed) {
                    callback(null, "Хост не вернул результат перелинковки.", entries);
                    return;
                }
                callback(parsed, parsed.ok ? "" : parsed.error, entries);
            }
        );
    }

    function applyPanel(moves, callback) {
        if (!moves.length) { callback({ moved: 0, pruned: 0 }); return; }
        var planPath = tempRoot() + "/panel-plan.json";
        if (!PardCopyQueue.writeText(planPath,
            JSON.stringify({ moves: moves, prune: true }))) {
            callback(null, "План группировки не удалось записать.");
            return;
        }
        evalScript(
            "$.global.PardDefenderHost.organizeFromFileJson('" +
            escapeForExtendScript(planPath) + "');",
            function (raw) {
                var parsed = null;
                try { parsed = JSON.parse(String(raw || "")); } catch (e) { parsed = null; }
                if (!parsed) { callback(null, "Хост не вернул результат группировки."); return; }
                callback(parsed, parsed.ok ? "" : parsed.error);
            }
        );
    }

    function taskById(tasks, id) {
        var i;
        for (i = 0; i < tasks.length; i++) { if (tasks[i].id === id) return tasks[i]; }
        return null;
    }

    function absorbCopyResults(tasks, results) {
        var i, r, task, copied = 0, bytes = 0, reused = 0, saved = 0;
        var sequences = 0, errors = 0;

        for (i = 0; i < results.length; i++) {
            r = results[i];
            task = taskById(tasks, r.id);
            if (r.ok) {
                PardIssues.clear("i" + r.id);
                copied += r.files || 0;
                bytes += r.bytes || 0;
                reused += r.reusedFiles || 0;
                saved += r.reusedBytes || 0;
                if (task && task.isSequence) sequences++;
                continue;
            }
            errors++;
            PardIssues.record({
                key: "i" + r.id,
                id: r.id,
                name: task ? task.name : String(r.id),
                path: task ? task.sourcePath : "",
                code: r.code || "COPY_FAILED",
                detail: r.reason,
                sourceSize: task ? task.size : 0
            });
        }

        PardStats.add({
            filesProcessed: copied,
            bytesCopied: bytes,
            filesReused: reused,
            bytesSaved: saved,
            sequencesProcessed: sequences,
            errorsTotal: errors
        });

        return { copied: copied, bytes: bytes, reused: reused, saved: saved, errors: errors };
    }

    /*
     * The worst class of failure: bytes are on disk and verified, but the
     * project was not repointed at them. The copy is NOT removed - it is a valid
     * backup, and deleting something we are not certain about is the one mistake
     * this design exists to prevent. Because the destination now holds identical
     * bytes, the next pass deduplicates instead of re-copying, so the retry
     * costs nothing but the relink itself.
     */
    function absorbRelinkResult(tasks, commit, entries) {
        var failedIds = {}, i, failure, task;

        if (commit && commit.failures) {
            for (i = 0; i < commit.failures.length; i++) {
                failure = commit.failures[i];
                failedIds[failure.id] = true;
                task = taskById(tasks, failure.id);
                PardIssues.record({
                    key: "i" + failure.id,
                    id: failure.id,
                    name: task ? task.name : String(failure.id),
                    path: task ? task.sourcePath : "",
                    code: failure.code || "RELINK_REJECTED",
                    detail: failure.reason,
                    sourceSize: task ? task.size : 0,
                    copied: true
                });
            }
            if (commit.failures.length) {
                PardStats.add({ errorsTotal: commit.failures.length });
            }
        }

        for (i = 0; i < entries.length; i++) {
            if (!failedIds[entries[i].id]) PardIssues.clear("i" + entries[i].id);
        }
    }

    function trip(code, reason, detail) {
        state.paused = { code: code, reason: reason, detail: detail || "", at: Date.now() };
        PardIssues.record({
            key: "sys:" + code,
            id: "",
            name: "Автоматический режим",
            code: code,
            detail: detail || reason
        });
        log("Автоматический режим на паузе: " + reason, "bad");
    }

    function runPass(force) {
        if (state.busy || !state.hostReady) return;
        if (state.paused && !force) return;
        var report = state.report;
        if (!report || !report.ok || !report.projectSaved || report.workspaceIssue) return;

        if (force && state.paused) {
            PardIssues.clear("sys:" + state.paused.code);
            state.paused = null;
        }

        var settings = state.settings;
        var tasks = settings.copyEnabled ? buildCopyTasks(report, force) : [];
        var moves = settings.organizePanelEnabled ? buildPanelMoves(report, force) : [];

        if (!tasks.length && !moves.length) {
            if (force) log("Нечего переносить — всё уже на месте.", "neutral");
            return;
        }

        state.busy = true;
        PardStats.markPass();
        render();

        if (!tasks.length) { organiseThen(moves); return; }

        if (!PardCopyQueue.available()) {
            state.busy = false;
            trip("NODE_UNAVAILABLE", PardIssues.describe("NODE_UNAVAILABLE").text);
            render();
            return;
        }

        journalTasks(tasks);
        log("Копирую " + tasks.length + " элем.…", "work");

        PardCopyQueue.run(
            tasks,
            {
                reserveBytes: settings.reserveBytes,
                freeBytes: state.disk ? state.disk.freeBytes : 0,
                stallMs: PardCopyQueue.DEFAULT_STALL_MS
            },
            {
                onTask: function (task, index, total) {
                    setBusyLabel("Копирую " + index + "/" + total + " — " + task.name);
                }
            },
            function (results) {
                var totals = absorbCopyResults(tasks, results);

                if (totals.copied || totals.reused) {
                    log("Скопировано " + totals.copied + " файл. (" +
                        formatBytes(totals.bytes) + ")" +
                        (totals.reused ? ", переиспользовано " + totals.reused : ""), "good");
                }

                recordManifest(tasks, results);

                var breaker = PardIssues.evaluateBreaker(results, BREAKER_THRESHOLD);
                if (breaker.tripped) {
                    trip(breaker.code, breaker.reason, "Подряд неудач: " + breaker.count);
                }

                commitRelink(tasks, results, function (commit, error, entries) {
                    PardCopyQueue.removeQuietly(metadataDir() + "/pending.tsv");

                    if (error) {
                        log("Перелинковка: " + error, "bad");
                        PardStats.add({ errorsTotal: 1 });
                    } else {
                        absorbRelinkResult(tasks, commit, entries);
                        if (commit.relinked) {
                            log("Защищено и перелинковано: " + commit.relinked, "good");
                        }
                    }
                    /* The manifest just grew, so verification needs the new rows. */
                    PardVerify.attach(state.workspace);
                    state.lastWeighAt = 0;
                    organiseThen(moves);
                });
            }
        );

        function organiseThen(pendingMoves) {
            if (!pendingMoves.length || state.paused) { finish(); return; }
            setBusyLabel("Раскладываю панель проекта…");
            applyPanel(pendingMoves, function (result, error) {
                if (error) {
                    log("Группировка: " + error, "bad");
                    PardIssues.record({
                        key: "sys:PANEL_FAILED",
                        id: "",
                        name: "Группировка панели",
                        code: "PANEL_FAILED",
                        detail: error
                    });
                    PardStats.add({ errorsTotal: 1 });
                } else {
                    PardIssues.clear("sys:PANEL_FAILED");
                    PardStats.add({
                        panelMoves: result.moved || 0,
                        foldersPruned: result.pruned || 0
                    });
                    if (result.moved) {
                        log("Разложено в панели: " + result.moved +
                            (result.pruned
                                ? " (пустых папок убрано: " + result.pruned + ")"
                                : ""), "good");
                    }
                }
                finish();
            });
        }

        function finish() {
            state.busy = false;
            setBusyLabel("");
            PardIssues.save();
            PardStats.save();
            /* Paths and folders changed, so the cached report is stale. */
            tick(true);
        }
    }

    /* ------------------------------------------------------- verification */

    function sweepProtected(full) {
        if (!state.report || !state.report.items || !state.workspace) return null;
        if (!PardCopyQueue.available()) return null;

        var outcome = full
            ? PardVerify.sweepAll(state.report.items)
            : PardVerify.sweep(state.report.items, PardVerify.DEFAULT_BUDGET);

        var i, finding;
        for (i = 0; i < outcome.findings.length; i++) {
            finding = outcome.findings[i];
            PardIssues.record({
                key: finding.key,
                id: finding.id,
                name: finding.name,
                path: finding.path,
                code: finding.code,
                detail: finding.detail,
                sourceSize: finding.sourceSize
            });
        }

        if (outcome.findings.length) {
            PardStats.add({ errorsTotal: outcome.findings.length });
            log("Сверка: расхождений " + outcome.findings.length, "warn");
            PardIssues.save();
            PardStats.save();
        } else if (full) {
            log("Сверка: проверено " + outcome.checked + ", расхождений нет.", "good");
        }
        return outcome;
    }

    /* --------------------------------------------------------- unused files */

    /*
     * A cleanup candidate has to satisfy three independent conditions:
     *
     *   1. the project does not use it in any composition;
     *   2. its file currently sits inside the workspace;
     *   3. the manifest says PardDefender put it there.
     *
     * The third is what protects the owner's own files. An asset they had
     * already filed in 01_assets before protection started has no manifest row,
     * so cleanup cannot reach it. And because only the copy inside the workspace
     * is ever touched, the original the file came from is never affected.
     */
    function unusedCandidates() {
        var out = [], i, item, record;
        var report = state.report;
        if (!report || !report.items) return out;

        for (i = 0; i < report.items.length; i++) {
            item = report.items[i];
            if (!item.unassigned) continue;
            if (item.state !== "protected") continue;
            record = PardVerify.recordFor(item.path);
            if (!record) continue;

            /*
             * If the original is gone, this copy is the last surviving instance.
             * That still gets deleted if the owner confirms - it is unused, and
             * they asked - but it is counted separately and said out loud.
             */
            var onlyCopy = !PardCopyQueue.statOf(record.sourcePath);

            out.push({
                id: item.id,
                name: item.name,
                path: item.path,
                size: item.size,
                sourcePath: record.sourcePath,
                onlyCopy: onlyCopy
            });
        }
        return out;
    }

    function unusedTotals() {
        var list = unusedCandidates(), i, bytes = 0, onlyCopies = 0;
        for (i = 0; i < list.length; i++) {
            bytes += list[i].size || 0;
            if (list[i].onlyCopy) onlyCopies++;
        }
        return { list: list, count: list.length, bytes: bytes, onlyCopies: onlyCopies };
    }

    function cleanUnused() {
        var totals = unusedTotals();
        if (!totals.count) { log("Неиспользуемых защищённых файлов нет.", "neutral"); return; }
        if (!PardHousekeeping.available()) {
            log("Node недоступен — удаление невозможно.", "bad");
            return;
        }

        var paths = [], ids = [], i;
        for (i = 0; i < totals.list.length; i++) {
            paths.push(totals.list[i].path);
            ids.push(totals.list[i].id);
        }

        state.busy = true;
        setBusyLabel("Отправляю в корзину " + paths.length + " файл.…");
        render();

        PardHousekeeping.recycle(paths, function (result) {
            if (!result.ok) {
                state.busy = false;
                setBusyLabel("");
                log("Корзина: " + result.error, "bad");
                render();
                return;
            }

            log("В корзину отправлено: " + result.recycled +
                (result.failed ? ", не удалось: " + result.failed : "") +
                " (" + formatBytes(totals.bytes) + ")", "good");

            /* The files are gone; the project items would now be offline
             * footage, so they go too - but only the ones still unused. */
            var planPath = tempRoot() + "/remove-plan.json";
            if (!PardCopyQueue.writeText(planPath, JSON.stringify({ ids: ids }))) {
                state.busy = false;
                setBusyLabel("");
                tick(true);
                return;
            }

            evalScript(
                "$.global.PardDefenderHost.removeItemsFromFileJson('" +
                escapeForExtendScript(planPath) + "');",
                function (raw) {
                    var parsed = null;
                    try { parsed = JSON.parse(String(raw || "")); } catch (e) { parsed = null; }
                    if (parsed && parsed.ok && parsed.removed) {
                        log("Убрано из проекта: " + parsed.removed, "good");
                    } else if (parsed && !parsed.ok) {
                        log("Не удалось убрать из проекта: " + parsed.error, "warn");
                    }
                    state.busy = false;
                    setBusyLabel("");
                    state.lastWeighAt = 0;
                    tick(true);
                }
            );
        });
    }

    /* ---------------------------------------------------------------- tick */

    function tick(force) {
        if (!state.hostReady || state.busy) return;

        var due = force || !state.report ||
            (Date.now() - state.lastAuditAt) >= (state.settings
                ? state.settings.scanIntervalMs
                : 180000);
        if (!due) { render(); return; }

        runAudit(function (report, error) {
            state.lastAuditAt = Date.now();
            if (!report) {
                state.hostError = error;
                render();
                return;
            }
            state.hostError = report.ok ? "" : report.error;

            if (report.projectPath !== state.projectPath) onProjectChanged(report);

            state.report = report;
            state.settings = report.settings || state.settings;
            state.workspace = report.workspace;
            refreshTracking(report);
            refreshDisk();
            maybeWeigh();
            sweepProtected(false);
            render();

            if (state.settings && state.settings.autoEnabled && !state.paused) {
                runPass(false);
            }
        });
    }

    function onProjectChanged(report) {
        /* Every timer, issue and counter belongs to the project it came from. */
        PardIssues.save();
        PardStats.save();

        state.seen = {};
        state.log = [];
        state.paused = null;
        state.weight = null;
        state.lastWeighAt = 0;
        state.projectPath = report.projectPath;
        painted = {};

        var workspace = report.workspaceIssue ? "" : report.workspace;
        PardIssues.attach(workspace);
        PardStats.attach(workspace);
        PardVerify.attach(workspace);

        if (workspace) {
            var recovered = PardCopyQueue.recoverJournal(workspace + "/.parddefender/pending.tsv");
            if (recovered.removedPartials) {
                log("После сбоя убрано незавершённых копий: " +
                    recovered.removedPartials, "warn");
            }
        }
    }

    function refreshDisk() {
        if (!state.workspace) { state.disk = null; return; }
        PardDiskSpace.query(state.workspace, function (info) {
            state.disk = info;
            renderDisk();
        });
    }

    function maybeWeigh() {
        if (!state.workspace || !PardHousekeeping.available()) return;
        if (Date.now() - state.lastWeighAt < WEIGH_INTERVAL_MS) return;
        state.lastWeighAt = Date.now();
        PardHousekeeping.measure(state.workspace, function (result) {
            if (result.ok) { state.weight = result; renderDisk(); }
        });
    }

    /* -------------------------------------------------------------- render */

    function setBusyLabel(text) {
        el.busy.textContent = text || "";
        el.busy.hidden = !text;
    }

    function statusFor() {
        if (!state.hostReady) {
            return { label: "ОШИБКА ЗАГРУЗКИ", tone: "red", note: state.hostError };
        }
        var report = state.report;
        if (!report) return { label: "ЗАПУСК…", tone: "neutral", note: "" };
        if (!report.ok) return { label: "ОШИБКА", tone: "red", note: report.error };
        if (!report.projectSaved) {
            return {
                label: "СОХРАНИТЕ ПРОЕКТ",
                tone: "red",
                note: "Пока проект не сохранён, рабочая папка неизвестна."
            };
        }
        if (report.workspaceIssue) {
            return { label: "ПРОВЕРЬТЕ ПАПКУ", tone: "yellow", note: report.workspaceIssue };
        }
        if (state.paused) {
            return {
                label: "ПАУЗА",
                tone: "red",
                note: state.paused.reason +
                    (state.paused.detail ? " — " + state.paused.detail : "") +
                    ". Устраните причину и нажмите «Возобновить»."
            };
        }
        if (!state.settings.autoEnabled) {
            return {
                label: "РУЧНОЙ РЕЖИМ",
                tone: "blue",
                note: "Автораспределение выключено. Нажмите «Разложить сейчас»."
            };
        }
        if (PardIssues.openCount() > 0) {
            return { label: "ЕСТЬ ПРОБЛЕМЫ", tone: "yellow", note: "" };
        }
        if (report.counts.missing > 0) {
            return {
                label: "ЕСТЬ ПОТЕРЯННЫЕ",
                tone: "yellow",
                note: "Часть исходников не найдена на диске."
            };
        }
        if (report.counts.pending > 0) {
            return { label: "В ОЧЕРЕДИ", tone: "yellow", note: "" };
        }
        return { label: "ПОД ЗАЩИТОЙ", tone: "green", note: "" };
    }

    function render() {
        var status = statusFor();
        if (changed("status", status.label + "|" + status.tone + "|" + status.note)) {
            el.status.textContent = status.label;
            el.status.className = "status " + status.tone;
            el.note.textContent = status.note || "";
            el.note.hidden = !status.note;
        }
        el.resume.hidden = !state.paused;

        var report = state.report;
        if (report && report.workspace) {
            if (changed("workspace", report.workspace)) {
                el.workspace.textContent = report.workspace.replace(/^.*\//, "");
                el.workspace.title = report.workspace;
            }
            el.workspaceRow.hidden = false;
        } else {
            el.workspaceRow.hidden = true;
        }

        if (report && report.counts) {
            var countsText =
                "Защищено " + report.counts.protected_ +
                " · Отслеживается " + report.counts.total +
                " · В очереди " + report.counts.pending +
                " · Потеряно " + report.counts.missing;
            if (changed("counts", countsText)) el.counts.textContent = countsText;
            el.counts.hidden = false;
        } else {
            el.counts.hidden = true;
        }

        if (report && report.renderComps && report.renderComps.length) {
            var names = [], i;
            for (i = 0; i < report.renderComps.length && i < 6; i++) {
                names.push(report.renderComps[i].name);
            }
            var compsText = "Рендер-композиции в корне: " + names.join(", ") +
                (report.renderComps.length > 6 ? " …" : "");
            if (changed("renderComps", compsText)) el.renderComps.textContent = compsText;
            el.renderComps.hidden = false;
        } else {
            el.renderComps.hidden = true;
        }

        var canAct = state.hostReady && report && report.ok &&
            report.projectSaved && !report.workspaceIssue && !state.busy;
        el.runNow.disabled = !canAct;
        el.verifyAll.disabled = !canAct;

        if (state.settings) {
            el.autoEnabled.checked = state.settings.autoEnabled;
            el.copyEnabled.checked = state.settings.copyEnabled;
            el.organizeEnabled.checked = state.settings.organizePanelEnabled;
            if (document.activeElement !== el.scanInterval) {
                el.scanInterval.value = Math.round(state.settings.scanIntervalMs / 60000);
            }
            if (document.activeElement !== el.settleDelay) {
                el.settleDelay.value = Math.round(state.settings.settleDelayMs / 60000);
            }
        }
        el.settingsBlock.hidden = !(report && report.projectSaved);

        renderDisk();
        renderUnused();
        renderIssues();
        renderQueue();
        renderStats();
        renderUpdate();
    }

    function renderDisk() {
        if (!state.disk || !state.disk.ok) {
            el.diskRow.hidden = true;
            return;
        }
        var signature = state.disk.freeBytes + "|" + state.disk.totalBytes + "|" +
            (state.weight ? state.weight.bytes + "|" + state.weight.files : "-");
        el.diskRow.hidden = false;
        if (!changed("disk", signature)) return;

        el.diskLabel.textContent =
            "Диск " + PardDiskSpace.volumeOf(state.workspace) + " — свободно " +
            formatBytes(state.disk.freeBytes) +
            " из " + formatBytes(state.disk.totalBytes);
        el.diskFill.style.width = Math.round(state.disk.usedRatio * 100) + "%";
        el.diskFill.className = "disk-fill" +
            (state.disk.usedRatio > 0.95 ? " critical"
                : (state.disk.usedRatio > 0.85 ? " warn" : ""));

        el.diskProject.textContent = state.weight
            ? "Проект весит " + formatBytes(state.weight.bytes) +
                " · " + state.weight.files + " файл."
            : "Проект взвешивается…";
    }

    function renderUnused() {
        var totals = unusedTotals();
        var signature = totals.count + "|" + totals.bytes + "|" + totals.onlyCopies +
            "|" + (state.confirmCleanupUntil > Date.now() ? "confirm" : "idle") +
            "|" + (state.busy ? "busy" : "free");

        el.unusedSection.hidden = totals.count === 0;
        if (totals.count === 0) { state.confirmCleanupUntil = 0; return; }
        if (!changed("unused", signature)) return;

        el.unusedTitle.textContent = "Не используется: " + totals.count +
            " файл. · " + formatBytes(totals.bytes);

        var confirming = state.confirmCleanupUntil > Date.now();
        el.cleanUnused.className = "danger-line" + (confirming ? " confirming" : "");
        el.cleanUnused.disabled = state.busy;
        el.cleanUnused.textContent = confirming
            ? "ПОДТВЕРДИТЬ: " + totals.count + " файл. В КОРЗИНУ" +
                (totals.onlyCopies
                    ? " (из них " + totals.onlyCopies + " без оригинала)"
                    : "")
            : "УБРАТЬ НЕИСПОЛЬЗУЕМЫЕ В КОРЗИНУ";
    }

    function toneForIssue(record) {
        if (record.klass === "system") return "red";
        if (record.klass === "owner") return "yellow";
        if (record.klass === "permanent") return "grey";
        return "blue";
    }

    function iconButton(glyph, title, handler) {
        var button = document.createElement("button");
        button.className = "icon act";
        button.textContent = glyph;
        button.title = title;
        button.onclick = handler;
        return button;
    }

    function showInProject(id, name) {
        evalScript("$.global.PardDefenderHost.selectItemById('" +
            escapeForExtendScript(id) + "');", function (raw) {
            var text = String(raw || "");
            if (text.indexOf("ERROR|") === 0) { log(text.substring(6), "bad"); return; }
            /*
             * There is no ExtendScript call that expands a collapsed folder, so
             * when the item is buried the panel says where it is instead of
             * pretending the selection was enough.
             */
            var parts = text.split("|");
            var folder = parts.length > 2 ? parts[2] : "";
            log("В проекте: " + (name || parts[1] || "") +
                (folder ? "  →  " + folder : "  →  корень проекта"), "work");
        });
    }

    function renderIssues() {
        var list = PardIssues.all();
        el.issuesSection.hidden = list.length === 0;
        if (!list.length) return;

        /*
         * The retry countdown is bucketed to whole minutes on purpose: a
         * per-second signature would repaint the list every tick and put the
         * scroll jitter straight back.
         */
        var parts = [], i;
        for (i = 0; i < list.length && i < 20; i++) {
            parts.push(list[i].key + ":" + list[i].code + ":" + list[i].attempts +
                ":" + (list[i].ignored ? 1 : 0) +
                ":" + Math.round((list[i].nextAttemptAt || 0) / 60000));
        }
        var signature = PardIssues.openCount() + "|" + parts.join(",");
        if (!changed("issues", signature)) return;

        el.issuesTitle.textContent = "ПРОБЛЕМЫ (" + PardIssues.openCount() + ")";
        el.issues.innerHTML = "";
        for (i = 0; i < list.length && i < 20; i++) {
            el.issues.appendChild(issueRow(list[i]));
        }
    }

    function issueRow(record) {
        var row = document.createElement("div");
        row.className = "issue-row" + (record.ignored ? " ignored" : "");
        row.title = record.detail || record.text;

        var head = document.createElement("div");
        head.className = "issue-head";

        var dot = document.createElement("span");
        dot.className = "dot " + toneForIssue(record);

        var name = document.createElement("span");
        name.className = "issue-name";
        name.textContent = record.name;
        if (record.id) {
            name.onclick = function () { showInProject(record.id, record.name); };
        }

        head.appendChild(dot);
        head.appendChild(name);

        var text = document.createElement("div");
        text.className = "issue-text";
        /* The copied-but-not-linked case is worth saying out loud: the bytes are
         * safe even though the project is not yet pointing at them. */
        text.textContent = (record.copied ? "копия готова, " : "") + record.text;

        var foot = document.createElement("div");
        foot.className = "issue-foot";

        var schedule = document.createElement("span");
        schedule.className = "issue-schedule";
        schedule.textContent = "попыток " + record.attempts + " · " +
            PardIssues.formatSchedule(record);

        var actions = document.createElement("span");
        actions.className = "issue-actions";

        actions.appendChild(iconButton("↻", "Повторить сейчас", function () {
            PardIssues.retryNow(record.key);
            PardIssues.save();
            invalidate("issues");
            log("Повтор: " + record.name, "work");
            runPass(true);
        }));

        if (record.id) {
            actions.appendChild(iconButton("🔎", "Показать в панели Project",
                function () { showInProject(record.id, record.name); }));
        }
        if (record.path) {
            actions.appendChild(iconButton("📁", "Показать файл в проводнике",
                function () {
                    if (!PardHousekeeping.reveal(record.path)) {
                        log("Не удалось открыть проводник.", "bad");
                    }
                }));
        }

        actions.appendChild(iconButton("✕", "Убрать из списка", function () {
            PardIssues.ignore(record.key);
            PardIssues.save();
            invalidate("issues");
            renderIssues();
        }));

        foot.appendChild(schedule);
        foot.appendChild(actions);

        row.appendChild(head);
        row.appendChild(text);
        row.appendChild(foot);
        return row;
    }

    function renderQueue() {
        var report = state.report;
        if (!report || !report.items) { el.queueSection.hidden = true; return; }

        var rows = [], i, item;
        for (i = 0; i < report.items.length && rows.length < 20; i++) {
            item = report.items[i];
            if (item.state !== "pending" && item.state !== "missing") continue;
            rows.push(item);
        }
        el.queueSection.hidden = rows.length === 0;
        if (!rows.length) return;

        var parts = [];
        for (i = 0; i < rows.length; i++) {
            parts.push(rows[i].id + ":" + rows[i].state + ":" + rows[i].branchResolved);
        }
        if (!changed("queue", parts.join(","))) return;

        el.queueTitle.textContent = "ОЧЕРЕДЬ (" + rows.length + ")";
        el.queue.innerHTML = "";

        for (i = 0; i < rows.length; i++) {
            var row = document.createElement("div");
            row.className = "queue-row";
            row.title = rows[i].path + "\n→ " + rows[i].destRel;

            var dot = document.createElement("span");
            dot.className = "dot " + (rows[i].state === "missing" ? "red"
                : (rows[i].unassigned ? "grey" : "yellow"));

            var name = document.createElement("span");
            name.className = "queue-name";
            name.textContent = rows[i].name;

            var target = document.createElement("span");
            target.className = "queue-target";
            target.textContent = rows[i].state === "missing"
                ? "нет на диске"
                : (rows[i].unassigned ? "не в композициях" : rows[i].branchResolved);

            row.appendChild(dot);
            row.appendChild(name);
            row.appendChild(target);
            row.onclick = (function (id, itemName) {
                return function () { showInProject(id, itemName); };
            })(rows[i].id, rows[i].name);

            el.queue.appendChild(row);
        }
    }

    function statLine(text, sessionText) {
        var row = document.createElement("div");
        row.innerHTML = text;
        if (sessionText) {
            var span = document.createElement("span");
            span.className = "stat-session";
            span.textContent = "  " + sessionText;
            row.appendChild(span);
        }
        return row;
    }

    function renderStats() {
        var report = state.report;
        el.statsSection.hidden = !(report && report.projectSaved && !report.workspaceIssue);
        if (el.statsSection.hidden) return;

        var total = PardStats.total();
        var session = PardStats.session();
        var signature = [total.filesProcessed, total.bytesCopied, total.filesReused,
            total.bytesSaved, total.panelMoves, total.sequencesProcessed,
            total.errorsTotal, PardIssues.openCount(), total.lastPassAt].join("|");
        if (!changed("stats", signature)) return;

        el.stats.innerHTML = "";
        el.stats.appendChild(statLine(
            "Обработано <b>" + total.filesProcessed + "</b> файл. · <b>" +
            formatBytes(total.bytesCopied) + "</b>",
            session.filesProcessed ? "+" + session.filesProcessed : ""
        ));
        el.stats.appendChild(statLine(
            "Переиспользовано <b>" + total.filesReused + "</b> · сэкономлено <b>" +
            formatBytes(total.bytesSaved) + "</b>",
            session.filesReused ? "+" + session.filesReused : ""
        ));
        el.stats.appendChild(statLine(
            "Разложено в панели <b>" + total.panelMoves + "</b> · секвенций <b>" +
            total.sequencesProcessed + "</b>",
            session.panelMoves ? "+" + session.panelMoves : ""
        ));
        el.stats.appendChild(statLine(
            "Ошибок за всё время <b>" + total.errorsTotal + "</b> · сейчас открыто <b>" +
            PardIssues.openCount() + "</b>"
        ));

        var since = PardStats.formatDate(total.createdAt);
        var last = PardStats.formatTime(total.lastPassAt);
        el.stats.appendChild(statLine(
            (since ? "Под защитой с <b>" + since + "</b>" : "") +
            (last ? " · последний проход <b>" + last + "</b>" : "")
        ));
    }

    function renderUpdate() {
        if (!state.update) { el.update.hidden = true; return; }
        el.update.hidden = false;
        if (!changed("update", state.update.version)) return;
        el.updateVersion.textContent = state.update.version;
        el.updateSummary.textContent = state.update.summary;
    }

    function renderLog() {
        if (!el.log) return;
        var signature = state.log.length +
            (state.log.length ? "|" + state.log[0].time.getTime() : "");
        el.logSection.hidden = state.log.length === 0;
        if (!state.log.length || !changed("log", signature)) return;

        el.log.innerHTML = "";
        var i, entry, row;
        for (i = 0; i < state.log.length && i < 12; i++) {
            entry = state.log[i];
            row = document.createElement("div");
            row.className = "log-row " + entry.tone;
            row.textContent = pad(entry.time.getHours()) + ":" +
                pad(entry.time.getMinutes()) + "  " + entry.message;
            el.log.appendChild(row);
        }
    }

    function pad(n) { return (n < 10 ? "0" : "") + n; }

    /* ------------------------------------------------------------ settings */

    function pushSettings(changes) {
        if (!state.settings) return;
        var key;
        for (key in changes) {
            if (changes.hasOwnProperty(key)) state.settings[key] = changes[key];
        }
        var planPath = tempRoot() + "/settings.json";
        if (!PardCopyQueue.writeText(planPath, JSON.stringify(state.settings))) {
            log("Настройки не удалось записать во временный файл.", "bad");
            return;
        }
        evalScript(
            "$.global.PardDefenderHost.writeSettingsFromFile('" +
            escapeForExtendScript(planPath) + "');",
            function (raw) {
                var parsed = null;
                try { parsed = JSON.parse(String(raw || "")); } catch (e) { parsed = null; }
                if (parsed && parsed.ok) {
                    state.settings = parsed.settings;
                    render();
                } else {
                    log("Настройки не сохранились: " +
                        (parsed ? parsed.error : "хост не ответил"), "bad");
                }
            }
        );
    }

    function minutesFrom(input, fallbackMs) {
        var value = Number(input.value);
        if (!isFinite(value) || value < 0) return fallbackMs;
        return Math.round(value) * 60000;
    }

    /* ---------------------------------------------------------------- boot */

    function bind() {
        var ids = {
            status: "status", note: "note", workspaceRow: "workspace-row",
            workspace: "workspace", counts: "counts", renderComps: "render-comps",
            runNow: "run-now", busy: "busy", settingsBlock: "settings",
            autoEnabled: "auto-enabled", copyEnabled: "copy-enabled",
            organizeEnabled: "organize-enabled", scanInterval: "scan-interval",
            settleDelay: "settle-delay", diskRow: "disk-row", diskLabel: "disk-label",
            diskFill: "disk-fill", diskProject: "disk-project",
            queueSection: "queue-section", queueTitle: "queue-title", queue: "queue",
            logSection: "log-section", log: "log", openFolder: "open-folder",
            version: "version", issuesSection: "issues-section",
            issuesTitle: "issues-title", issues: "issues",
            statsSection: "stats-section", stats: "stats", verifyAll: "verify-all",
            resume: "resume", update: "update", updateVersion: "update-version",
            updateSummary: "update-summary", updateOpen: "update-open",
            updateDismiss: "update-dismiss", unusedSection: "unused-section",
            unusedTitle: "unused-title", unusedReveal: "unused-reveal",
            cleanUnused: "clean-unused"
        };
        var key;
        for (key in ids) {
            if (ids.hasOwnProperty(key)) el[key] = document.getElementById(ids[key]);
        }

        el.runNow.onclick = function () {
            log("Ручной запуск.", "work");
            runPass(true);
        };

        el.resume.onclick = function () {
            if (!state.paused) return;
            PardIssues.clear("sys:" + state.paused.code);
            PardIssues.save();
            state.paused = null;
            log("Автоматический режим возобновлён.", "work");
            tick(true);
        };

        el.verifyAll.onclick = function () {
            log("Полная сверка защищённых файлов…", "work");
            sweepProtected(true);
            state.lastWeighAt = 0;
            maybeWeigh();
            render();
        };

        el.openFolder.onclick = function () {
            evalScript("$.global.PardDefenderHost.revealWorkspace();", function (raw) {
                var text = String(raw || "");
                if (text.indexOf("ERROR|") === 0) log(text.substring(6), "bad");
            });
        };

        el.unusedReveal.onclick = function () {
            var totals = unusedTotals();
            if (totals.count) PardHousekeeping.reveal(totals.list[0].path);
        };

        /*
         * Two presses, not a modal. The first arms the button and spells out
         * exactly how many files and how many of them have no surviving
         * original; the second commits. The arming lapses on its own so a stray
         * click cannot sit there waiting to be completed later.
         */
        el.cleanUnused.onclick = function () {
            if (state.confirmCleanupUntil > Date.now()) {
                state.confirmCleanupUntil = 0;
                invalidate("unused");
                cleanUnused();
                return;
            }
            state.confirmCleanupUntil = Date.now() + CONFIRM_WINDOW_MS;
            invalidate("unused");
            renderUnused();
            window.setTimeout(function () {
                if (state.confirmCleanupUntil <= Date.now()) {
                    invalidate("unused");
                    renderUnused();
                }
            }, CONFIRM_WINDOW_MS + 200);
        };

        el.updateOpen.onclick = function () {
            if (state.update) PardUpdater.openReleasePage(state.update.url);
        };

        el.updateDismiss.onclick = function () {
            if (state.update) PardUpdater.dismiss(state.update.version);
            state.update = null;
            renderUpdate();
        };

        el.autoEnabled.onchange = function () {
            pushSettings({ autoEnabled: el.autoEnabled.checked });
        };
        el.copyEnabled.onchange = function () {
            pushSettings({ copyEnabled: el.copyEnabled.checked });
        };
        el.organizeEnabled.onchange = function () {
            pushSettings({ organizePanelEnabled: el.organizeEnabled.checked });
        };
        el.scanInterval.onchange = function () {
            pushSettings({
                scanIntervalMs: minutesFrom(el.scanInterval, state.settings.scanIntervalMs)
            });
        };
        el.settleDelay.onchange = function () {
            pushSettings({
                settleDelayMs: minutesFrom(el.settleDelay, state.settings.settleDelayMs)
            });
        };

        /* Losing the panel must not lose an hour of counters. */
        window.addEventListener("beforeunload", function () {
            PardIssues.save();
            PardStats.save();
        });
    }

    function boot() {
        bind();
        loadHostModules(function (ok, info) {
            state.hostReady = ok;
            if (!ok) {
                state.hostError = info;
                render();
                return;
            }
            state.version = info;
            el.version.textContent = "v" + info;
            PardUpdater.configure(info);

            if (!PardCopyQueue.available()) {
                log("Node недоступен: копирование работать не будет.", "bad");
            }

            PardUpdater.check(false, function (update) {
                state.update = update;
                renderUpdate();
            });

            tick(true);
            window.setInterval(function () { tick(false); }, TICK_MS);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
