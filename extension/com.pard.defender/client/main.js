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
        "PardDefenderApply.jsx",
        "PardDefenderLayers.jsx"
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
        layers: null,
        lastLayerScanAt: 0,
        commentFor: "",
        version: "1.0.0",
        confirmCleanupUntil: 0,
        confirmAdoptUntil: 0,
        confirmRedistUntil: 0,
        cloud: null,
        pin: null,
        pinBusy: false,
        lastPinCheckAt: 0
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

    /*
     * The audit's own key, because one element can produce two rows - itself
     * and its proxy - and both need their own settle clock and their own issue
     * record. Older reports had no key; the item id is the right fallback.
     */
    function keyOf(item) { return item.key || ("i" + item.id); }

    function refreshTracking(report) {
        var alive = {}, i, item, key;
        for (i = 0; i < report.items.length; i++) {
            item = report.items[i];
            key = keyOf(item);
            alive[key] = true;
            trackItem(key, item.size);
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

    /*
     * A file already inside the workspace but in the wrong folder. Normally
     * untouchable - the whole design says a file's place on disk is decided
     * once - but a legacy project is exactly the case that rule was not written
     * for, and the owner has to ask for this explicitly, per project.
     */
    function relocating() {
        return !!(state.settings && state.settings.legacyRedistribute);
    }

    function buildCopyTasks(report, force) {
        var tasks = [], i, item, key, misplaced;
        for (i = 0; i < report.items.length; i++) {
            item = report.items[i];
            misplaced = relocating() && isLegacyMisplaced(item);
            if (item.state !== "pending" && !misplaced) continue;
            if (!item.destPath) continue;

            key = keyOf(item);
            /*
             * An element with a recorded failure only comes back when its
             * backoff has expired. Without this, a locked file would be retried
             * every three minutes forever and would fill the log with itself.
             */
            if (!force && !PardIssues.isDue(key)) continue;
            if (force && PardIssues.get(key)) PardIssues.retryNow(key);
            /*
             * A misplaced file needs no settle delay. The delay exists to wait
             * for bytes still arriving from an import; this file has been in
             * the project for months and After Effects is already pointing at
             * it. Making the owner wait ten minutes per batch would turn a
             * legacy pass into an afternoon.
             */
            if (!readyToCopy(key, item.unassigned, force || misplaced)) continue;

            tasks.push({
                key: key,
                id: item.id,
                isProxy: item.isProxy === true,
                name: item.name,
                sourcePath: item.path,
                destPath: item.destPath,
                isSequence: item.isSequence,
                sequence: item.sequence,
                size: item.size,
                branch: item.branchResolved,
                category: item.category,
                /*
                 * Set only for the legacy pass. It means: this source is itself
                 * inside the workspace, so once the copy is verified AND the
                 * project points at it, the leftover is a duplicate rather than
                 * somebody's original.
                 */
                relocated: misplaced
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
            if (!readyToFile(keyOf(item), force)) continue;
            moves.push({ id: item.id, target: item.panelTarget });
        }
        return moves;
    }

    function metadataDir() { return state.workspace + "/.parddefender"; }

    function journalTasks(tasks) {
        var lines = [], i, now = new Date().toISOString();
        for (i = 0; i < tasks.length; i++) {
            /* Column two is the element KEY, not the bare id: an element and its
             * proxy are two rows about the same id. Only the destination column
             * is ever read back, by recoverJournal. */
            lines.push([now, tasks[i].key, tasks[i].sourcePath,
                tasks[i].destPath].join("\t"));
        }
        PardCopyQueue.writeText(metadataDir() + "/pending.tsv", lines.join("\n") + "\n");
    }

    function taskMap(tasks) {
        var byKey = {}, i;
        for (i = 0; i < tasks.length; i++) byKey[tasks[i].key] = tasks[i];
        return byKey;
    }

    function resultTask(byKey, result) {
        return byKey[result.key || ("i" + result.id)] || null;
    }

    function recordManifest(tasks, results) {
        var lines = [], i, r, task, byKey = taskMap(tasks);
        for (i = 0; i < results.length; i++) {
            r = results[i];
            if (!r.ok) continue;
            task = resultTask(byKey, r);
            if (!task) continue;
            lines.push([
                new Date().toISOString(), task.key, task.sourcePath, task.size,
                r.destPath, task.branch, task.category
            ].join("\t"));
        }
        if (lines.length) {
            PardCopyQueue.appendText(metadataDir() + "/assets.tsv", lines.join("\n") + "\n");
        }
    }

    function commitRelink(tasks, results, callback) {
        var entries = [], i, r, task, byKey = taskMap(tasks);
        for (i = 0; i < results.length; i++) {
            r = results[i];
            if (!r.ok || !r.destPath) continue;
            task = resultTask(byKey, r);
            if (!task) continue;
            entries.push({
                key: task.key,
                id: task.id,
                isProxy: task.isProxy === true,
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

    function absorbCopyResults(tasks, results) {
        var i, r, task, copied = 0, bytes = 0, reused = 0, saved = 0;
        var sequences = 0, errors = 0, byKey = taskMap(tasks);

        for (i = 0; i < results.length; i++) {
            r = results[i];
            task = resultTask(byKey, r);
            if (r.ok) {
                PardIssues.clear(r.key || ("i" + r.id));
                copied += r.files || 0;
                bytes += r.bytes || 0;
                reused += r.reusedFiles || 0;
                saved += r.reusedBytes || 0;
                if (task && task.isSequence) sequences++;
                continue;
            }
            errors++;
            PardIssues.record({
                key: r.key || ("i" + r.id),
                id: r.id,
                name: task ? task.name : String(r.id),
                path: task ? task.sourcePath : "",
                code: r.code || "COPY_FAILED",
                detail: r.reason,
                destPath: task ? task.destPath : "",
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
        var failed = {}, i, failure, task, key, byKey = taskMap(tasks);
        var settled = [];

        if (commit && commit.failures) {
            for (i = 0; i < commit.failures.length; i++) {
                failure = commit.failures[i];
                key = failure.key || ("i" + failure.id);
                failed[key] = true;
                task = byKey[key] || null;
                PardIssues.record({
                    key: key,
                    id: failure.id,
                    name: task ? task.name : String(failure.id),
                    path: task ? task.sourcePath : "",
                    code: failure.code || "RELINK_REJECTED",
                    detail: failure.reason,
                    destPath: task ? task.destPath : "",
                    sourceSize: task ? task.size : 0,
                    copied: true
                });
            }
            if (commit.failures.length) {
                PardStats.add({ errorsTotal: commit.failures.length });
            }
        }

        for (i = 0; i < entries.length; i++) {
            if (failed[entries[i].key]) continue;
            PardIssues.clear(entries[i].key);
            settled.push(entries[i].key);
        }
        return settled;
    }

    function insideWorkspace(target) {
        if (!state.workspace) return false;
        var p = String(target || "").replace(/\\/g, "/").toLowerCase();
        var root = state.workspace.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
        return !!root && p.indexOf(root + "/") === 0;
    }

    /*
     * The single place PardDefender removes a file it did not put there itself,
     * and it is fenced in on every side. All of these must hold:
     *
     *   - the owner pressed "разложить всё по местам" on THIS project, and left
     *     the "старые копии в корзину" switch on;
     *   - the file was already INSIDE the workspace (an external original is
     *     untouchable, always and without exception);
     *   - a byte-verified copy now sits in the route folder;
     *   - After Effects has been repointed at that copy and said so;
     *   - and the removal is to the Recycle Bin, never an unlink.
     *
     * Without this step the redistribute button leaves two of everything and
     * doubles the project on disk, which is not a redistribution at all.
     */
    function recycleRelocated(tasks, results, settled, done) {
        if (!state.settings || state.settings.legacyRecycleOld === false) { done(); return; }
        if (!settled.length || !PardHousekeeping.available()) { done(); return; }

        var byKey = taskMap(tasks), byResult = {}, paths = [], i, j, r, task, src;
        for (i = 0; i < results.length; i++) {
            byResult[results[i].key || ("i" + results[i].id)] = results[i];
        }

        for (i = 0; i < settled.length; i++) {
            task = byKey[settled[i]];
            r = byResult[settled[i]];
            if (!task || !task.relocated || !r || !r.ok) continue;

            var destFolder = PardCopyQueue.toSlash(r.destPath || task.destPath)
                .replace(/\/[^\/]*$/, "").toLowerCase();
            var sources = r.sources && r.sources.length ? r.sources : [task.sourcePath];

            for (j = 0; j < sources.length; j++) {
                src = PardCopyQueue.toSlash(sources[j]);
                if (!insideWorkspace(src)) continue;
                /* Same folder means nothing actually moved - dedup reused the
                 * file that was already there, and it IS the protected copy. */
                if (src.replace(/\/[^\/]*$/, "").toLowerCase() === destFolder) continue;
                paths.push(src);
            }
        }

        if (!paths.length) { done(); return; }

        setBusyLabel("Убираю старые копии: " + paths.length + " файл.…");
        PardHousekeeping.recycle(paths, function (result) {
            if (result.ok) {
                log("Старые копии в корзине: " + result.recycled +
                    (result.failed ? ", не удалось: " + result.failed : ""), "good");
                PardStats.add({ filesRelocated: result.recycled });
            } else {
                log("Корзина: " + result.error +
                    " — старые копии остались на месте.", "warn");
            }
            done();
        });
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

                    var settled = [];
                    if (error) {
                        log("Перелинковка: " + error, "bad");
                        PardStats.add({ errorsTotal: 1 });
                    } else {
                        settled = absorbRelinkResult(tasks, commit, entries);
                        if (commit.relinked) {
                            log("Защищено и перелинковано: " + commit.relinked, "good");
                        }
                    }
                    /* The manifest just grew, so verification needs the new rows. */
                    PardVerify.attach(state.workspace);
                    state.lastWeighAt = 0;
                    recycleRelocated(tasks, results, settled, function () {
                        organiseThen(moves);
                    });
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
            /* A proxy belongs to an element a composition uses. It is never
             * loose, whatever its own branch says. */
            if (item.isProxy) continue;
            if (!item.unassigned) continue;
            /*
             * Sent to 00_UNUSED by hand, but a composition still uses it.
             * Deleting one would tear a hole in the project.
             */
            if (item.forcedUnused) continue;
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

    /* ------------------------------------------------------ legacy projects */

    /*
     * A project from before PardDefender existed: everything dumped in the
     * workspace root, or filed by a scheme of its own. Two answers, and the
     * owner gives exactly one per project:
     *
     *   ОСТАВИТЬ КАК ЕСТЬ    every element that is here right now is never
     *                        touched again - not its file, not its place in the
     *                        panel. New imports are still protected: this draws
     *                        a line at a moment in time, it does not switch
     *                        protection off.
     *   РАЗЛОЖИТЬ ВСЁ        keep copying misplaced files into their route
     *                        folders until none are left, and (unless the
     *                        switch is off) send each leftover to the Recycle
     *                        Bin once its replacement is verified and linked.
     *
     * Files OUTSIDE the workspace are never adopted. Leaving those where they
     * are is precisely the loss this whole extension exists to prevent.
     */
    /*
     * The host reports "this file is not in the folder its route names". That
     * is not the same as "this file is left over from before PardDefender".
     *
     * A file WE copied has a manifest row, and its place on disk is final by
     * design: renaming a composition rebuilds the folders in the Project panel
     * but never moves the file, because a move after relink is a fresh
     * transaction with fresh risk - and on a Yandex.Disk folder it means
     * re-uploading the whole thing. Without this test, renaming one comp would
     * pop the "СТАРЫЙ ПРОЕКТ" section up on a perfectly healthy project and
     * offer to shuffle files that are exactly where they were put.
     *
     * So: only a misplaced file with NO manifest row is a legacy file.
     */
    function isLegacyMisplaced(item) {
        if (item.misplaced !== true) return false;
        return !PardVerify.wasCopiedByUs(item.path);
    }

    function misplacedItems() {
        var out = [], i, item;
        var report = state.report;
        if (!report || !report.items) return out;
        for (i = 0; i < report.items.length; i++) {
            item = report.items[i];
            if (isLegacyMisplaced(item)) out.push(item);
        }
        return out;
    }

    function misplacedTotals() {
        var list = misplacedItems(), i, bytes = 0;
        for (i = 0; i < list.length; i++) bytes += list[i].size || 0;
        return { list: list, count: list.length, bytes: bytes };
    }

    function adoptInPlace() {
        var report = state.report, ids = [], i, item;
        if (!report || !report.items) return;

        for (i = 0; i < report.items.length; i++) {
            item = report.items[i];
            if (item.isProxy) continue;
            /* Only what is already inside the workspace. An element still
             * sitting in Downloads is exactly what protection is for. */
            if (item.state !== "protected") continue;
            ids.push(item.id);
        }

        if (!ids.length) {
            log("Внутри рабочей папки нечего оставлять как есть.", "neutral");
            return;
        }
        pushSettings({ adoptedItems: ids, legacyRedistribute: false });
        log("Оставлено как есть: " + ids.length +
            " элем. Новые импорты защищаются как обычно.", "good");
        state.lastAuditAt = 0;
    }

    function startRedistribute() {
        var totals = misplacedTotals();
        if (!totals.count) {
            log("Всё уже лежит по местам.", "neutral");
            return;
        }
        /* Раскладывать нечем, если копирование выключено — скажем об этом
         * вместо того, чтобы молча ничего не сделать. */
        if (state.settings && state.settings.copyEnabled === false) {
            log("Копирование выключено — включите «Копировать файлы в папку " +
                "проекта», иначе раскладывать нечем.", "warn");
            return;
        }
        pushSettings({ legacyRedistribute: true, adoptedItems: [] });
        log("Раскладываю старый проект: " + totals.count + " файл. (" +
            formatBytes(totals.bytes) + ")", "work");
        state.lastAuditAt = 0;
        runPass(true);
    }

    /*
     * The pass stops itself. Leaving the flag on would mean any file the owner
     * later files by hand gets pulled back into a route folder months later,
     * which is precisely the surprise the "place on disk is final" rule exists
     * to prevent.
     */
    function maybeFinishRedistribute() {
        if (!relocating() || !state.report || !state.report.counts) return;
        /*
         * The completion test is the FILTERED list, not the host's raw count.
         * The raw count also holds files we placed ourselves whose route name
         * changed later - a renamed composition - and those are never moved,
         * so counting them would leave the mode stuck on forever.
         *
         * A file that failed to copy is still in the filtered list, so an open
         * problem cannot let the pass declare victory either.
         */
        if (misplacedItems().length > 0) return;
        pushSettings({ legacyRedistribute: false });
        log("Старый проект разложен — режим перераспределения выключен.", "good");
    }

    /* ------------------------------------------------ forgotten layers */

    /*
     * The layer sweep is a separate host call rather than part of the audit: it
     * walks every property of every composition that has a candidate, and the
     * audit runs often enough that doubling its cost would be felt. It shares
     * the audit's cadence but is skipped entirely while the setting is off.
     */
    function runLayerScan(callback) {
        evalScript("$.global.PardDefenderHost.scanLayersToFile();", function (raw) {
            var text = String(raw || "");
            if (text.indexOf("OK|") !== 0) { callback(null); return; }
            var body = PardCopyQueue.readText(text.substring(3));
            if (!body) { callback(null); return; }
            var parsed = null;
            try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
            callback(parsed && parsed.ok ? parsed : null);
        });
    }

    function layerFindings() {
        return state.layers && state.layers.findings ? state.layers.findings : [];
    }

    function openFindingCount() {
        var list = layerFindings(), i, count = 0;
        for (i = 0; i < list.length; i++) {
            if (list[i].status !== "forgotten") count++;
        }
        return count;
    }

    function settingsList(name) {
        if (!state.settings) return [];
        if (!state.settings[name]) state.settings[name] = [];
        return state.settings[name];
    }

    function markForgotten(finding) {
        var list = settingsList("disabledLayerForgotten"), i;
        for (i = 0; i < list.length; i++) { if (list[i] === finding.key) return; }
        list.push(finding.key);
        finding.status = "forgotten";
        invalidate("layers");
        pushSettings({ disabledLayerForgotten: list });
        log("Помечено забытым: " + (finding.layerName || finding.compName), "work");
    }

    function unmarkForgotten(finding) {
        var list = settingsList("disabledLayerForgotten"), out = [], i;
        for (i = 0; i < list.length; i++) {
            if (list[i] !== finding.key) out.push(list[i]);
        }
        finding.status = "open";
        invalidate("layers");
        pushSettings({ disabledLayerForgotten: out });
    }

    /*
     * An exception without a comment is refused. A month from now the comment is
     * the only thing that explains why a layer is allowed to sit there switched
     * off, and an unexplained exception is worse than no exception at all.
     */
    function addException(finding, comment) {
        var text = String(comment || "").replace(/^\s+|\s+$/g, "");
        if (!text) {
            log("Исключение без комментария не сохраняется — напишите, почему.", "warn");
            return false;
        }
        var list = settingsList("disabledLayerExceptions"), out = [], i;
        for (i = 0; i < list.length; i++) {
            if (list[i] && list[i].key !== finding.key) out.push(list[i]);
        }
        out.push({ key: finding.key, comment: text, at: new Date().toISOString() });

        /* Drop it from the visible list immediately; the next scan agrees. */
        var findings = layerFindings(), remaining = [];
        for (i = 0; i < findings.length; i++) {
            if (findings[i].key !== finding.key) remaining.push(findings[i]);
        }
        if (state.layers) state.layers.findings = remaining;

        invalidate("layers");
        pushSettings({ disabledLayerExceptions: out });
        log("В исключения: " + (finding.layerName || finding.compName) + " — " + text, "good");
        return true;
    }

    /*
     * Moves the FILE into 00_UNUSED while leaving the layer exactly where it is.
     * The audit honours forcedUnused by treating the element as unassigned; the
     * composition is never touched.
     */
    function forceUnused(finding) {
        if (!finding.itemId) return;
        var list = settingsList("forcedUnused"), i;
        for (i = 0; i < list.length; i++) { if (list[i] === finding.itemId) return; }
        list.push(finding.itemId);
        pushSettings({ forcedUnused: list });
        log("Файл уедет в 00_UNUSED, слой в композиции остаётся: " +
            (finding.itemName || finding.layerName), "work");
        state.lastAuditAt = 0;
    }

    function revealFinding(finding) {
        var call = finding.kind === "comp"
            ? "$.global.PardDefenderHost.revealComp('" +
                escapeForExtendScript(finding.compId) + "');"
            : "$.global.PardDefenderHost.revealLayer('" +
                escapeForExtendScript(finding.compId) + "', " +
                (Number(finding.layerIndex) || 0) + ", '" +
                escapeForExtendScript(finding.layerName) + "');";

        evalScript(call, function (raw) {
            var text = String(raw || "");
            if (text.indexOf("ERROR|") === 0) {
                var code = text.substring(6);
                if (code === "COMP_GONE") {
                    log("Композиции больше нет в проекте.", "warn");
                } else if (code === "LAYER_GONE") {
                    log("Слоя больше нет в композиции — список обновится.", "warn");
                    state.lastLayerScanAt = 0;
                } else {
                    log(code, "bad");
                }
                return;
            }
            var parts = text.split("|");
            log("Открыл композицию «" + (parts[1] || finding.compName) + "»" +
                (parts[2] ? ", выделил слой «" + parts[2] + "»" : ""), "work");
        });
    }

    function renderLayers() {
        var list = layerFindings();
        el.layersSection.hidden = list.length === 0;
        if (!list.length) { state.commentFor = ""; return; }

        var parts = [], i;
        for (i = 0; i < list.length && i < 30; i++) {
            parts.push(list[i].key + ":" + list[i].status);
        }
        var signature = parts.join(",") + "|" + (state.commentFor || "");
        if (!changed("layers", signature)) return;

        el.layersTitle.textContent = "ВЫКЛЮЧЕНО И ЗАБЫТО (" + openFindingCount() + ")";
        el.layers.innerHTML = "";
        for (i = 0; i < list.length && i < 30; i++) {
            el.layers.appendChild(layerRow(list[i]));
        }
        if (state.layers && state.layers.truncated) {
            var more = document.createElement("div");
            more.className = "layer-more";
            more.textContent = "Показаны первые находки — их слишком много для одного прохода.";
            el.layers.appendChild(more);
        }
    }

    function layerRow(finding) {
        var row = document.createElement("div");
        row.className = "layer-row" + (finding.status === "forgotten" ? " forgotten" : "");

        var head = document.createElement("div");
        head.className = "layer-head";

        var dot = document.createElement("span");
        dot.className = "dot " + (finding.status === "forgotten" ? "red" : "yellow");

        var name = document.createElement("span");
        name.className = "layer-name";
        name.textContent = finding.kind === "comp"
            ? finding.compName
            : (finding.layerName || finding.itemName);
        name.onclick = function () { revealFinding(finding); };

        var where = document.createElement("span");
        where.className = "layer-where";
        where.textContent = finding.kind === "comp"
            ? "композиция"
            : finding.compName + " · слой " + finding.layerIndex;

        head.appendChild(dot);
        head.appendChild(name);
        head.appendChild(where);

        var text = document.createElement("div");
        text.className = "layer-text";
        if (finding.kind === "comp") {
            text.textContent = "Никуда не входит и не помечена — похоже, это будущая " +
                "рендерная композиция. Пометьте её цветом или исключите.";
        } else {
            text.textContent = finding.status === "forgotten"
                ? "Помечен забытым."
                : "Слой выключен. Он не корректирующий, не маска, не родитель и " +
                  "ни на что не влияет — похоже, про него просто забыли.";
        }

        var foot = document.createElement("div");
        foot.className = "layer-foot";

        if (state.commentFor === finding.key) {
            foot.appendChild(commentEditor(finding));
        } else {
            var actions = document.createElement("span");
            actions.className = "issue-actions";

            actions.appendChild(iconButton("🔎",
                finding.kind === "comp"
                    ? "Открыть композицию"
                    : "Открыть композицию и выделить слой",
                function () { revealFinding(finding); }));

            if (finding.status === "forgotten") {
                actions.appendChild(iconButton("↺", "Снять пометку «забытый»",
                    function () { unmarkForgotten(finding); }));
            } else {
                actions.appendChild(iconButton("⚑", "Пометить забытым",
                    function () { markForgotten(finding); }));
            }

            actions.appendChild(iconButton("✎", "В исключения — с комментарием",
                function () {
                    state.commentFor = finding.key;
                    invalidate("layers");
                    renderLayers();
                }));

            if (finding.kind === "layer" && finding.itemId) {
                actions.appendChild(iconButton("↓",
                    "Отправить файл в 00_UNUSED, не трогая слой в композиции",
                    function () { forceUnused(finding); }));
            }

            var size = document.createElement("span");
            size.className = "layer-size";
            size.textContent = finding.size ? formatBytes(finding.size) : "";

            foot.appendChild(size);
            foot.appendChild(actions);
        }

        row.appendChild(head);
        row.appendChild(text);
        row.appendChild(foot);
        return row;
    }

    function commentEditor(finding) {
        var box = document.createElement("span");
        box.className = "comment-box";

        var input = document.createElement("input");
        input.type = "text";
        input.className = "comment-input";
        input.placeholder = "Почему оставляем? Комментарий обязателен";
        input.maxLength = 300;

        var save = document.createElement("button");
        save.className = "icon act";
        save.textContent = "✓";
        save.title = "Сохранить исключение";
        save.onclick = function () {
            if (addException(finding, input.value)) state.commentFor = "";
        };

        var cancel = document.createElement("button");
        cancel.className = "icon act";
        cancel.textContent = "✕";
        cancel.title = "Отмена";
        cancel.onclick = function () {
            state.commentFor = "";
            invalidate("layers");
            renderLayers();
        };

        input.onkeydown = function (event) {
            if (event.keyCode === 13) { save.onclick(); }
            if (event.keyCode === 27) { cancel.onclick(); }
        };

        box.appendChild(input);
        box.appendChild(save);
        box.appendChild(cancel);
        /* The row was just rebuilt, so focus has to be re-applied. */
        window.setTimeout(function () { try { input.focus(); } catch (e) {} }, 0);
        return box;
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
            maybeFinishRedistribute();
            refreshDisk();
            maybeWeigh();
            maybeCheckPin();
            sweepProtected(false);
            maybeScanLayers();
            render();

            /*
             * The legacy pass keeps going whether or not automatic mode is on:
             * the owner asked for this project to be laid out, in as many
             * batches as that takes, and it switches itself off when the last
             * misplaced file is gone.
             */
            if (state.settings && !state.paused &&
                (state.settings.autoEnabled || relocating())) {
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
        state.layers = null;
        state.lastLayerScanAt = 0;
        state.commentFor = "";
        state.projectPath = report.projectPath;
        state.cloud = null;
        state.pin = null;
        state.pinBusy = false;
        state.lastPinCheckAt = 0;
        state.confirmCleanupUntil = 0;
        state.confirmAdoptUntil = 0;
        state.confirmRedistUntil = 0;
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

    function maybeScanLayers() {
        if (!state.settings || state.settings.scanLayersEnabled === false) {
            state.layers = null;
            return;
        }
        if (!state.workspace) return;
        if (Date.now() - state.lastLayerScanAt < state.settings.scanIntervalMs) return;
        state.lastLayerScanAt = Date.now();
        runLayerScan(function (report) {
            state.layers = report;
            invalidate("layers");
            renderLayers();
        });
    }

    /*
     * A workspace on a cloud-synced drive is the owner's normal setup and is
     * deliberately left synced - the cloud copy is the backup. The risk is the
     * other direction: the provider evicting local files to save space. A file
     * that has become a placeholder reads to the copy queue as a source that
     * opens fine and then delivers no bytes, which is the SOURCE_STALLED case.
     *
     * The check is read-only and rare. Pinning is only ever done on a press.
     */
    var PIN_CHECK_INTERVAL_MS = 900000;

    function maybeCheckPin() {
        if (!state.workspace || !PardHousekeeping.available()) return;
        state.cloud = PardHousekeeping.cloudInfo(state.workspace);
        if (!state.cloud.cloud) { state.pin = null; return; }
        if (state.pinBusy) return;
        if (Date.now() - state.lastPinCheckAt < PIN_CHECK_INTERVAL_MS) return;
        state.lastPinCheckAt = Date.now();
        PardHousekeeping.pinState(state.workspace, function (result) {
            state.pin = result;
            invalidate("cloud");
            renderCloud();
        });
    }

    function pinWorkspace() {
        if (!state.workspace || state.pinBusy) return;
        state.pinBusy = true;
        invalidate("cloud");
        renderCloud();
        log("Закрепляю файлы проекта на компьютере…", "work");
        PardHousekeeping.pinAlways(state.workspace, function (result) {
            state.pinBusy = false;
            state.pin = result;
            state.lastPinCheckAt = Date.now();
            if (!result.ok) {
                log("Закрепить не удалось: " + result.error, "bad");
            } else if (result.allPinned) {
                log("Файлы проекта помечены как «всегда на этом компьютере». " +
                    "Синхронизация продолжает работать — облако остаётся копией.", "good");
            } else {
                log("Windows принял пометку не для всех файлов (" + result.pinned +
                    " из " + result.sampled + "). " +
                    (state.cloud ? state.cloud.label : "Клиент облака") +
                    " может не поддерживать закрепление через проводник — " +
                    "тогда включите «Всегда на этом компьютере» в его настройках.", "warn");
            }
            invalidate("cloud");
            renderCloud();
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

        renderLegend();
        renderDisk();
        renderCloud();
        renderUnused();
        renderLegacy();
        renderLayers();
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

    /* ------------------------------------------------------- colour legend */

    /*
     * After Effects label colours, indexed the way AE indexes them. The panel
     * shows the swatch for whatever index the settings actually use, so the
     * legend keeps telling the truth after the owner changes pinLabel or
     * sectionLabel in the settings file.
     */
    var LABEL_COLOURS = ["", "#e24b4b", "#e3d14b", "#6fd3d3", "#f0a0c8",
        "#b7a5e0", "#f0b98a", "#9fd9b8", "#5b8fe0", "#5fb85f", "#9b5fd1",
        "#e08a3c", "#9c6b4a", "#d94fa8", "#4fc3e8", "#c9b08a", "#3e7a4e"];

    var LABEL_NAMES = ["без метки", "красный", "жёлтый", "бирюзовый", "розовый",
        "лавандовый", "персиковый", "морская пена", "синий", "зелёный",
        "фиолетовый", "оранжевый", "коричневый", "фуксия", "голубой",
        "песочный", "тёмно-зелёный"];

    function labelName(index) {
        return LABEL_NAMES[index] || ("метка " + index);
    }

    function legendRule(index, title, lines) {
        var row = document.createElement("div");
        row.className = "legend-rule";

        var head = document.createElement("div");
        head.className = "legend-rule-head";

        var swatch = document.createElement("span");
        swatch.className = "legend-swatch";
        swatch.style.background = LABEL_COLOURS[index] || "transparent";
        head.appendChild(swatch);

        var name = document.createElement("span");
        name.className = "legend-name";
        name.textContent = labelName(index).toUpperCase() + " — " + title;
        head.appendChild(name);
        row.appendChild(head);

        var i;
        for (i = 0; i < lines.length; i++) {
            var line = document.createElement("div");
            line.className = "legend-line";
            line.textContent = lines[i];
            row.appendChild(line);
        }
        return row;
    }

    function renderLegend() {
        var settings = state.settings;
        el.legend.hidden = !settings;
        if (!settings) return;

        var open = settings.legendOpen !== false;
        var signature = settings.pinLabel + "|" + settings.sectionLabel + "|" + open;
        if (!changed("legend", signature)) return;

        el.legendCaret.textContent = open ? "▾" : "▸";
        el.legendBody.hidden = !open;
        if (!open) return;

        el.legendBody.innerHTML = "";

        if (settings.pinLabel > 0) {
            el.legendBody.appendChild(legendRule(settings.pinLabel, "РУКИ ПРОЧЬ", [
                "Композиция: считается рендерной и остаётся в корне проекта.",
                "Файл: не переносится и не раскладывается в панели.",
                "Слой: не попадает в «выключено и забыто»."
            ]));
        }

        if (settings.sectionLabel > 0) {
            el.legendBody.appendChild(legendRule(settings.sectionLabel, "РАЗДЕЛ", [
                "Композиция: её имя становится веткой. Всё, что внутри неё на " +
                    "любой глубине, — вложенные композиции и футаж — ложится в " +
                    "папку с этим именем, и в панели, и на диске.",
                "Работает и на композиции в корне: она сама остаётся в корне, " +
                    "а её содержимое уезжает в папку.",
                "То, что входит сразу в несколько разделов, — в общую папку " +
                    "_SHARED."
            ]));
        }

        var tail = document.createElement("div");
        tail.className = "legend-tail";
        tail.textContent = "Без меток тоже работает: рендерной считается композиция, " +
            "которую никто не использует или которая стоит в очереди рендера; " +
            "веткой — композиция сразу под рендерной.";
        el.legendBody.appendChild(tail);
    }

    /* --------------------------------------------------------- cloud folder */

    function renderCloud() {
        var cloud = state.cloud;
        el.cloudRow.hidden = !(cloud && cloud.cloud);
        if (!cloud || !cloud.cloud) return;

        var pin = state.pin;
        var stateText = state.pinBusy
            ? "проверяю…"
            : (!pin || !pin.ok
                ? "состояние неизвестно"
                : (pin.allPinned
                    ? "файлы всегда на этом компьютере"
                    : "часть файлов может выгружаться в облако"));

        var signature = cloud.label + "|" + stateText + "|" + state.pinBusy;
        if (!changed("cloud", signature)) return;

        el.cloudText.textContent = cloud.label + " — " + stateText;
        el.cloudText.title = "Синхронизация не выключается: облако остаётся " +
            "резервной копией. Пометка означает лишь, что локальный файл не " +
            "будет выгружен ради места на диске.";
        el.cloudPin.hidden = !!(pin && pin.ok && pin.allPinned) || state.pinBusy;
    }

    /* -------------------------------------------------------- legacy project */

    function renderLegacy() {
        var report = state.report;
        var totals = misplacedTotals();
        var adopted = state.settings ? (state.settings.adoptedItems || []).length : 0;
        var show = !!(report && report.projectSaved && !report.workspaceIssue) &&
            (totals.count > 0 || relocating());

        el.legacySection.hidden = !show;
        if (!show) {
            state.confirmAdoptUntil = 0;
            state.confirmRedistUntil = 0;
            return;
        }

        var adoptArmed = state.confirmAdoptUntil > Date.now();
        var redistArmed = state.confirmRedistUntil > Date.now();
        var signature = totals.count + "|" + totals.bytes + "|" + adopted + "|" +
            relocating() + "|" + adoptArmed + "|" + redistArmed + "|" +
            (state.busy ? "busy" : "free") + "|" +
            (state.settings && state.settings.legacyRecycleOld !== false);
        if (!changed("legacy", signature)) return;

        el.legacyTitle.textContent = relocating()
            ? "СТАРЫЙ ПРОЕКТ — РАСКЛАДЫВАЮ"
            : "СТАРЫЙ ПРОЕКТ";

        el.legacyNote.textContent = relocating()
            ? "Осталось разложить: " + totals.count + " файл. · " +
                formatBytes(totals.bytes) + ". Режим выключится сам, когда всё " +
                "будет на местах."
            : "Внутри рабочей папки " + totals.count + " файл. лежит не там, " +
                "где их положило бы расширение (" + formatBytes(totals.bytes) +
                "). Решите один раз — это запомнится для этого проекта.";

        el.legacyAdopt.disabled = state.busy || relocating();
        el.legacyAdopt.className = "wide" + (adoptArmed ? " confirming" : "");
        el.legacyAdopt.textContent = adoptArmed
            ? "ПОДТВЕРДИТЬ: НИЧЕГО НЕ ТРОГАТЬ В ЭТОМ ПРОЕКТЕ"
            : "ОСТАВИТЬ КАК ЕСТЬ";

        var recycling = !state.settings || state.settings.legacyRecycleOld !== false;
        el.legacyRedistribute.disabled = state.busy || relocating();
        el.legacyRedistribute.className = "wide danger-line" +
            (redistArmed ? " confirming" : "");
        el.legacyRedistribute.textContent = redistArmed
            ? "ПОДТВЕРДИТЬ: ПЕРЕНЕСТИ " + totals.count + " ФАЙЛ." +
                (recycling ? ", СТАРЫЕ — В КОРЗИНУ" : ", СТАРЫЕ ОСТАВИТЬ")
            : "РАЗЛОЖИТЬ ВСЁ ПО МЕСТАМ";

        el.legacyRecycle.checked = recycling;
        el.legacyRecycleNote.textContent = recycling
            ? "Старая копия уедет в Корзину только после того, как новая проверена " +
                "и проект переключён на неё. Файлы за пределами рабочей папки не " +
                "трогаются никогда."
            : "Старые копии останутся на месте — проект будет весить вдвое больше.";
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

    /*
     * Where a given element physically is, on both sides:
     *
     *   internal - the copy inside the workspace, if one exists yet
     *   external - the original it came from, wherever that was
     *
     * A protected element has both: the manifest remembers where it came from.
     * A pending one has only the external original - unless a copy was already
     * made and the relink failed, in which case the copy is on disk too and is
     * exactly what the owner will want to look at.
     */
    function locationsFor(id, fallbackPath, fallbackDest) {
        var internal = "", external = "", item = null, i;
        var items = state.report && state.report.items ? state.report.items : [];

        for (i = 0; i < items.length; i++) {
            if (items[i].id === id) { item = items[i]; break; }
        }

        if (item) {
            if (item.state === "protected") {
                internal = item.path;
                var record = PardVerify.recordFor(item.path);
                external = record ? record.sourcePath : "";
            } else {
                external = item.path;
                if (item.destPath && PardCopyQueue.statOf(item.destPath)) {
                    internal = item.destPath;
                }
            }
        } else {
            /* The element is gone from the project, but the issue row still
             * remembers the paths it was recorded with. */
            external = fallbackPath || "";
            if (fallbackDest && PardCopyQueue.statOf(fallbackDest)) {
                internal = fallbackDest;
            }
        }

        /* Never offer one path twice under two different labels. */
        if (internal && external &&
            String(internal).toLowerCase() === String(external).toLowerCase()) {
            external = "";
        }
        return { internal: internal, external: external };
    }

    /*
     * Opens a location and, when it cannot, says exactly why. "Нажимаю и ничего
     * не происходит" was the entire complaint about the previous button.
     */
    function revealAndReport(target, label) {
        var result = PardHousekeeping.revealFile(target);
        if (result.code === "selected") return;
        if (result.code === "folder") {
            log(label + ": открыл папку — выделить сам файл не получилось.", "work");
            return;
        }
        if (result.code === "fileGone") {
            log(label + " недоступен: файл удалён или перемещён. Открыл его папку — " +
                result.folder, "warn");
            return;
        }
        if (result.code === "missing") {
            log(label + " недоступен: по этому пути нет ни файла, ни папки — " +
                result.path, "warn");
            return;
        }
        log(label + ": не удалось открыть проводник.", "bad");
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

        /*
         * Two separate destinations, because they answer different questions:
         * "где лежит копия внутри проекта" and "где лежал оригинал". A file can
         * have one, both, or neither, so each button only appears when there is
         * something to open.
         */
        var places = locationsFor(record.id, record.path, record.destPath);
        if (places.internal) {
            actions.appendChild(iconButton("📁", "Внутренний источник — копия в папке проекта:\n" +
                places.internal,
                function () { revealAndReport(places.internal, "Внутренний источник"); }));
        }
        if (places.external) {
            actions.appendChild(iconButton("📤", "Внешний источник — оригинал:\n" + places.external,
                function () { revealAndReport(places.external, "Внешний источник"); }));
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
            /* Both sides in the tooltip: where the file is now, and where it goes. */
            row.title = (rows[i].state === "protected" ? "Внутренний: " : "Внешний: ") +
                rows[i].path + "\n→ " + (rows[i].destPath || rows[i].destRel);

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
            total.errorsTotal, total.filesRelocated, PardIssues.openCount(),
            total.lastPassAt].join("|");
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

        /* Only shown once the legacy pass has actually removed something. It is
         * the one counter that stands for deleted files, and it should be
         * visible for as long as the project exists. */
        if (total.filesRelocated) {
            el.stats.appendChild(statLine(
                "Старых копий убрано в Корзину <b>" + total.filesRelocated + "</b>",
                session.filesRelocated ? "+" + session.filesRelocated : ""
            ));
        }

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
            layersSection: "layers-section", layersTitle: "layers-title",
            layers: "layers",
            resume: "resume", update: "update", updateVersion: "update-version",
            updateSummary: "update-summary", updateOpen: "update-open",
            updateDismiss: "update-dismiss", unusedSection: "unused-section",
            unusedTitle: "unused-title", unusedReveal: "unused-reveal",
            cleanUnused: "clean-unused",
            legend: "legend", legendToggle: "legend-toggle",
            legendCaret: "legend-caret", legendBody: "legend-body",
            cloudRow: "cloud-row", cloudText: "cloud-text", cloudPin: "cloud-pin",
            legacySection: "legacy-section", legacyTitle: "legacy-title",
            legacyNote: "legacy-note", legacyAdopt: "legacy-adopt",
            legacyRedistribute: "legacy-redistribute",
            legacyRecycle: "legacy-recycle", legacyRecycleNote: "legacy-recycle-note"
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
            if (totals.count) {
                revealAndReport(totals.list[0].path, "Папка 00_UNUSED");
            }
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

        el.legendToggle.onclick = function () {
            if (!state.settings) return;
            pushSettings({ legendOpen: state.settings.legendOpen === false });
            invalidate("legend");
            renderLegend();
        };

        el.cloudPin.onclick = pinWorkspace;

        /*
         * Both legacy buttons are two-press, for the same reason the cleanup
         * button is: the first press spells out exactly what the second will
         * do, and the arming lapses on its own so a stray click cannot sit
         * there waiting to be completed later.
         */
        function armed(until, invalidateName, renderFn, commit) {
            return function () {
                if (state[until] > Date.now()) {
                    state[until] = 0;
                    invalidate(invalidateName);
                    commit();
                    return;
                }
                state[until] = Date.now() + CONFIRM_WINDOW_MS;
                invalidate(invalidateName);
                renderFn();
                window.setTimeout(function () {
                    if (state[until] <= Date.now()) {
                        invalidate(invalidateName);
                        renderFn();
                    }
                }, CONFIRM_WINDOW_MS + 200);
            };
        }

        el.legacyAdopt.onclick =
            armed("confirmAdoptUntil", "legacy", renderLegacy, adoptInPlace);
        el.legacyRedistribute.onclick =
            armed("confirmRedistUntil", "legacy", renderLegacy, startRedistribute);

        el.legacyRecycle.onchange = function () {
            pushSettings({ legacyRecycleOld: el.legacyRecycle.checked });
            invalidate("legacy");
            renderLegacy();
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
