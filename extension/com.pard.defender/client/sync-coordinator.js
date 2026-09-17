/*
 * PardDefender - Cross-Host Relink Sync Coordinator
 *
 * @map role: Синхронизация After Effects и Premiere Pro в общей рабочей зоне:
 *           публикация media snapshots, журнал intents в events.jsonl,
 *           отложенная перелинковка для закрытых проектов и crash-safe compaction.
 * @map status: ready
 *
 * Enforces:
 * 1. Closed Adobe project files (.aep, .prproj) are NEVER rewritten on disk.
 * 2. Idempotent intent delivery: applied at most once per target project.
 * 3. Strict re-verification before relink: expectedOldPath must match live project item.
 * 4. No host confirms intents belonging to a different targetProjectId.
 */
var PardSyncCoordinator = (function () {
    "use strict";

    var api = {};

    var fs = null;
    var path = null;
    var crypto = null;
    var workspaceStore = null;

    try { fs = require("fs"); } catch (e) {}
    try { path = require("path"); } catch (e) {}
    try { crypto = require("crypto"); } catch (e) {}
    try { workspaceStore = require("./workspace-store.js"); } catch (e) {}

    api.setFs = function (customFs) { fs = customFs; };
    api.setWorkspaceStore = function (customStore) { workspaceStore = customStore; };

    function getStore() {
        return workspaceStore || (typeof PardWorkspaceStore !== "undefined" ? PardWorkspaceStore : null);
    }

    function nativePath(p) {
        if (!p) return "";
        return path ? String(p).replace(/\//g, path.sep) : String(p);
    }

    function normalizePath(p) {
        if (!p) return "";
        var s = String(p).replace(/\\/g, "/").trim().replace(/\/+/g, "/");
        if (/^[a-zA-Z]:\//.test(s)) {
            s = s.charAt(0).toLowerCase() + s.substring(1);
        }
        if (s.length > 3 && s.charAt(s.length - 1) === "/") {
            s = s.substring(0, s.length - 1);
        }
        return s;
    }

    api.normalizePath = normalizePath;

    function generateId(prefix) {
        var pre = prefix ? String(prefix) + "-" : "";
        if (crypto && typeof crypto.randomBytes === "function") {
            try { return pre + crypto.randomBytes(6).toString("hex"); } catch (e) {}
        }
        return pre + Date.now().toString(36) + "-" + Math.random().toString(36).substring(2, 8);
    }

    api.generateId = generateId;

    function metaDir(workspace) {
        return normalizePath(workspace) + "/.parddefender";
    }

    function projectsDir(workspace) {
        return metaDir(workspace) + "/projects";
    }

    /* ---------------------------------------------------- media snapshots */

    api.publishSnapshot = function (workspace, snapshotData) {
        if (!fs || !workspace || !snapshotData || !snapshotData.projectId) return false;
        var pDir = projectsDir(workspace);
        try {
            if (!fs.existsSync(nativePath(pDir))) {
                fs.mkdirSync(nativePath(pDir), { recursive: true });
            }
        } catch (e) {
            return false;
        }

        var sFile = pDir + "/" + snapshotData.projectId + ".media.json";
        var snapshot = {
            schemaVersion: 1,
            workspace: normalizePath(workspace),
            projectId: snapshotData.projectId,
            host: snapshotData.host || "aftereffects",
            auditGeneration: snapshotData.auditGeneration || 1,
            createdAt: snapshotData.createdAt || new Date().toISOString(),
            items: snapshotData.items || []
        };

        var nFile = nativePath(sFile);
        var tmpFile = nFile + "." + Date.now().toString(36) + ".tmp";
        try {
            fs.writeFileSync(tmpFile, JSON.stringify(snapshot, null, 2), "utf8");
            if (fs.existsSync(nFile)) {
                try { fs.unlinkSync(nFile); } catch (eDel) {}
            }
            fs.renameSync(tmpFile, nFile);
            return true;
        } catch (eW) {
            try { fs.unlinkSync(tmpFile); } catch (eU) {}
            return false;
        }
    };

    api.loadSnapshot = function (workspace, projectId) {
        if (!fs || !workspace || !projectId) return null;
        var sFile = projectsDir(workspace) + "/" + projectId + ".media.json";
        try {
            var raw = fs.readFileSync(nativePath(sFile), "utf8");
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    };

    api.listSnapshots = function (workspace) {
        if (!fs || !workspace) return [];
        var pDir = projectsDir(workspace);
        if (!fs.existsSync(nativePath(pDir))) return [];
        var out = [];
        try {
            var files = fs.readdirSync(nativePath(pDir));
            for (var i = 0; i < files.length; i++) {
                if (files[i].slice(-11) === ".media.json") {
                    try {
                        var raw = fs.readFileSync(nativePath(pDir + "/" + files[i]), "utf8");
                        var parsed = JSON.parse(raw);
                        if (parsed && parsed.projectId) out.push(parsed);
                    } catch (eR) {}
                }
            }
        } catch (e) {}
        return out;
    };

    /* ---------------------------------------------------- intent generation */

    api.createIntentsForConsolidation = function (workspace, originProjectId, operation, callback) {
        var cb = callback || function () {};
        if (!workspace || !originProjectId || !operation) {
            cb(new Error("Недостаточно параметров для создания intents"), null);
            return;
        }

        var store = getStore();
        if (!store || !store.appendEvent) {
            cb(new Error("PardWorkspaceStore недоступен для записи events.jsonl"), null);
            return;
        }

        var snapshots = api.listSnapshots(workspace);
        var createdIntents = [];

        // Targets that changed path during consolidation
        var changedTargets = [];
        var normCan = normalizePath(operation.canonical);
        for (var t = 0; t < (operation.targets || []).length; t++) {
            var tgt = operation.targets[t];
            if (normalizePath(tgt.oldPath) !== normCan) {
                changedTargets.push(tgt);
            }
        }

        for (var s = 0; s < snapshots.length; s++) {
            var snap = snapshots[s];
            if (snap.projectId === originProjectId) continue; // Do not target self

            for (var i = 0; i < snap.items.length; i++) {
                var it = snap.items[i];
                var itNorm = normalizePath(it.path);

                var match = false;
                var matchedTarget = null;

                for (var c = 0; c < changedTargets.length; c++) {
                    if (normalizePath(changedTargets[c].oldPath) === itNorm ||
                        (operation.contentId && it.contentId === operation.contentId)) {
                        match = true;
                        matchedTarget = changedTargets[c];
                        break;
                    }
                }

                if (match) {
                    var intentId = generateId("intent");
                    var evPayload = {
                        intentId: intentId,
                        originProject: originProjectId,
                        originOperation: operation.operationId || "",
                        targetProjectId: snap.projectId,
                        targetHost: snap.host,
                        locator: it.id || it.key,
                        role: it.role || "main",
                        expectedOldPath: it.path,
                        newPath: operation.canonical,
                        contentId: operation.contentId || "",
                        createdAt: new Date().toISOString()
                    };

                    store.appendEvent(workspace, {
                        type: "media.relink.requested",
                        projectId: originProjectId,
                        host: operation.host || "aftereffects",
                        payload: evPayload
                    });

                    createdIntents.push(evPayload);
                }
            }
        }

        cb(null, { ok: true, intents: createdIntents });
    };

    /* ---------------------------------------------------- intent resolution */

    api.getPendingIntents = function (workspace, targetProjectId) {
        if (!workspace || !targetProjectId) return [];
        var store = getStore();
        if (!store || !store.readEvents) return [];

        var evRes = store.readEvents(workspace);
        if (!evRes.ok || !evRes.events) return [];

        var events = evRes.events;
        var requestedMap = {};
        var terminalMap = {};

        for (var i = 0; i < events.length; i++) {
            var ev = events[i];
            var p = ev.payload || {};
            var intentId = p.intentId;
            if (!intentId) continue;

            if (ev.type === "media.relink.requested" && p.targetProjectId === targetProjectId) {
                requestedMap[intentId] = p;
            } else if (ev.type === "media.relink.applied" || ev.type === "media.relink.rejected") {
                terminalMap[intentId] = ev.type;
            }
        }

        var pending = [];
        for (var id in requestedMap) {
            if (requestedMap.hasOwnProperty(id) && !terminalMap[id]) {
                pending.push(requestedMap[id]);
            }
        }

        return pending;
    };

    api.resolveIntent = function (workspace, targetProjectId, intent, hostRelinker, liveItems, callback) {
        var cb = callback || function () {};
        if (!intent || !intent.intentId) {
            cb(new Error("Не передан intent"), null);
            return;
        }

        // Security check: host may only confirm intents for its own active projectId
        if (intent.targetProjectId !== targetProjectId) {
            cb(new Error("Попытка подтвердить intent для чужого проекта: " + intent.targetProjectId), null);
            return;
        }

        var store = getStore();
        if (!store || !store.appendEvent) {
            cb(new Error("PardWorkspaceStore недоступен"), null);
            return;
        }

        // Find live item
        var foundItem = null;
        var loc = String(intent.locator);
        for (var i = 0; i < (liveItems || []).length; i++) {
            var it = liveItems[i];
            if (String(it.id) === loc || String(it.key) === loc) {
                foundItem = it;
                break;
            }
        }

        if (!foundItem) {
            // Item no longer in project
            store.appendEvent(workspace, {
                type: "media.relink.rejected",
                projectId: targetProjectId,
                payload: {
                    intentId: intent.intentId,
                    targetProjectId: targetProjectId,
                    code: "ITEM_NOT_FOUND",
                    reason: "Элемент не найден в целевом проекте",
                    observedPath: "",
                    rejectedAt: new Date().toISOString()
                }
            });
            cb(null, { ok: false, code: "ITEM_NOT_FOUND" });
            return;
        }

        var observedPath = foundItem.path || "";
        if (normalizePath(observedPath) !== normalizePath(intent.expectedOldPath)) {
            // Source path in project changed in the meantime
            store.appendEvent(workspace, {
                type: "media.relink.rejected",
                projectId: targetProjectId,
                payload: {
                    intentId: intent.intentId,
                    targetProjectId: targetProjectId,
                    code: "STALE_SOURCE",
                    reason: "Источник элемента в проекте изменился: " + observedPath + " (ожидался " + intent.expectedOldPath + ")",
                    observedPath: observedPath,
                    rejectedAt: new Date().toISOString()
                }
            });
            cb(null, { ok: false, code: "STALE_SOURCE", observedPath: observedPath });
            return;
        }

        // Execute relink on host
        hostRelinker(foundItem, intent.newPath, function (err, relinkResult) {
            if (err || (relinkResult && !relinkResult.ok)) {
                var reason = err ? err.message : (relinkResult && relinkResult.reason ? relinkResult.reason : "Ошибка перелинковки");
                store.appendEvent(workspace, {
                    type: "media.relink.rejected",
                    projectId: targetProjectId,
                    payload: {
                        intentId: intent.intentId,
                        targetProjectId: targetProjectId,
                        code: "RELINK_FAILED",
                        reason: reason,
                        observedPath: observedPath,
                        rejectedAt: new Date().toISOString()
                    }
                });
                cb(null, { ok: false, code: "RELINK_FAILED", reason: reason });
                return;
            }

            store.appendEvent(workspace, {
                type: "media.relink.applied",
                projectId: targetProjectId,
                payload: {
                    intentId: intent.intentId,
                    targetProjectId: targetProjectId,
                    relinkedPath: intent.newPath,
                    appliedAt: new Date().toISOString()
                }
            });

            cb(null, { ok: true, relinkedPath: intent.newPath });
        });
    };

    /* ---------------------------------------------------- crash-safe compaction */

    api.compactEvents = function (workspace, callback) {
        var cb = callback || function () {};
        if (!fs || !workspace) {
            cb(new Error("Не указана рабочая папка"), null);
            return;
        }

        var store = getStore();
        if (!store || !store.withLock) {
            cb(new Error("PardWorkspaceStore.withLock недоступен"), null);
            return;
        }

        try {
            var lockRes = store.withLock(workspace, "events", function () {
                var evFile = metaDir(workspace) + "/events.jsonl";
                var nEvFile = nativePath(evFile);
                if (!fs.existsSync(nEvFile)) {
                    return { ok: true, compacted: 0 };
                }

                var raw = fs.readFileSync(nEvFile, "utf8");
                var lines = raw.split(/\r?\n/);
                var events = [];
                for (var i = 0; i < lines.length; i++) {
                    var l = lines[i].trim();
                    if (!l) continue;
                    try { events.push(JSON.parse(l)); } catch (eP) {}
                }

                // Group intents and terminal events
                var terminalIntents = {};
                for (var j = 0; j < events.length; j++) {
                    var ev = events[j];
                    var p = ev.payload || {};
                    if (ev.type === "media.relink.applied" || ev.type === "media.relink.rejected") {
                        terminalIntents[p.intentId] = true;
                    }
                }

                var keptEvents = [];
                var prunedCount = 0;

                for (var k = 0; k < events.length; k++) {
                    var e = events[k];
                    var payload = e.payload || {};
                    var iId = payload.intentId;

                    if (e.type === "media.relink.requested") {
                        if (terminalIntents[iId]) {
                            // Already resolved, can be safely pruned during compaction
                            prunedCount++;
                        } else {
                            // Unresolved intent: MUST BE PRESERVED
                            keptEvents.push(e);
                        }
                    } else if (e.type === "media.relink.applied" || e.type === "media.relink.rejected") {
                        // Keep recent terminal events or prune if compacted
                        prunedCount++;
                    } else {
                        // Non-relink events (e.g. consolidate_duplicates) - keep
                        keptEvents.push(e);
                    }
                }

                // Append summary event of compaction
                keptEvents.push({
                    schemaVersion: 1,
                    eventId: generateId("ev-compact"),
                    type: "events.compacted",
                    createdAt: new Date().toISOString(),
                    payload: {
                        prunedEventsCount: prunedCount,
                        retainedEventsCount: keptEvents.length
                    }
                });

                // Crash-safe atomic swap
                var tmpFile = nEvFile + "." + Date.now().toString(36) + ".tmp";
                var body = keptEvents.map(function (evObj) { return JSON.stringify(evObj); }).join("\n") + "\n";
                fs.writeFileSync(tmpFile, body, "utf8");
                if (fs.existsSync(nEvFile)) {
                    try { fs.unlinkSync(nEvFile); } catch (eD) {}
                }
                fs.renameSync(tmpFile, nEvFile);

                return { ok: true, pruned: prunedCount, retained: keptEvents.length };
            });
            cb(null, lockRes);
        } catch (eLock) {
            cb(eLock, null);
        }
    };

    return api;
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = PardSyncCoordinator;
}
