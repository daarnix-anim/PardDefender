/*
 * PardDefender - safe exact duplicate consolidation for After Effects.
 *
 * @map role: Безопасное объединение точных дубликатов: транзакционная машина состояний,
 *           re-verification, внешний copy каноникала, relink через хост и crash recovery.
 * @map status: ready
 *
 * Re-points duplicate footage items to a single verified canonical media path.
 * Never deletes project items, comps or original files on disk.
 */
var PardConsolidation = (function () {
    "use strict";

    var api = {};

    var fs = null;
    var path = null;
    var crypto = null;

    try { fs = require("fs"); } catch (e) {}
    try { path = require("path"); } catch (e) {}
    try { crypto = require("crypto"); } catch (e) {}

    var SCHEMA_VERSION = 1;

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
        return (prefix || "op") + "-" + Date.now().toString(36) + "-" +
            Math.random().toString(36).substring(2, 8);
    }

    function ensureDir(dirPath) {
        if (!fs || !dirPath) return false;
        try {
            fs.mkdirSync(nativePath(dirPath), { recursive: true });
            return true;
        } catch (e) {
            return false;
        }
    }

    function operationsDir(workspaceRoot) {
        return normalizePath(workspaceRoot) + "/.parddefender/operations";
    }

    function tempRoot(workspaceRoot) {
        var os = null;
        try { os = require("os"); } catch (e) { os = null; }
        var base = os && os.tmpdir ? String(os.tmpdir()).replace(/\\/g, "/") : "";
        return (base || normalizePath(workspaceRoot)) + "/parddefender-client";
    }

    /* -------------------------------------------------------- persistence */

    api.saveOperation = function (workspaceRoot, op) {
        if (!fs || !workspaceRoot || !op || !op.operationId) return false;
        var dir = operationsDir(workspaceRoot);
        ensureDir(dir);
        var targetFile = dir + "/" + op.operationId + ".json";
        op.updatedAt = new Date().toISOString();

        if (typeof PardWorkspaceStore !== "undefined" && PardWorkspaceStore.writeJsonAtomic) {
            return PardWorkspaceStore.writeJsonAtomic(targetFile, op);
        }

        var token = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
        var tmpFile = targetFile + "." + token + ".tmp";
        try {
            fs.writeFileSync(nativePath(tmpFile), JSON.stringify(op, null, 2), "utf8");
            if (fs.existsSync(nativePath(targetFile))) {
                try { fs.unlinkSync(nativePath(targetFile)); } catch (eDel) {}
            }
            fs.renameSync(nativePath(tmpFile), nativePath(targetFile));
            return true;
        } catch (e) {
            try { fs.unlinkSync(nativePath(tmpFile)); } catch (e2) {}
            return false;
        }
    };

    api.loadOperation = function (workspaceRoot, operationId) {
        if (!fs || !workspaceRoot || !operationId) return null;
        var file = operationsDir(workspaceRoot) + "/" + operationId + ".json";
        try {
            var raw = fs.readFileSync(nativePath(file), "utf8");
            var parsed = JSON.parse(raw);
            return parsed && parsed.operationId === operationId ? parsed : null;
        } catch (e) {
            return null;
        }
    };

    api.listOperations = function (workspaceRoot) {
        if (!fs || !workspaceRoot) return [];
        var dir = operationsDir(workspaceRoot);
        if (!fs.existsSync(nativePath(dir))) return [];
        var out = [];
        try {
            var files = fs.readdirSync(nativePath(dir));
            for (var i = 0; i < files.length; i++) {
                if (files[i].slice(-5) === ".json") {
                    var raw = fs.readFileSync(nativePath(dir + "/" + files[i]), "utf8");
                    var op = JSON.parse(raw);
                    if (op && op.operationId) out.push(op);
                }
            }
        } catch (e) {}
        return out;
    };

    api.findRecoverableOperation = function (workspaceRoot, projectId) {
        var ops = api.listOperations(workspaceRoot);
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (projectId && op.projectId && op.projectId !== projectId) continue;
            if (op.state !== "completed" && op.state !== "failed" && op.state !== "partial") {
                return op;
            }
        }
        return null;
    };

    /* ---------------------------------------------------- operation creation */

    api.createOperation = function (options) {
        var opt = options || {};
        var workspace = normalizePath(opt.workspace || "");
        var group = opt.group || {};
        var canonicalPath = opt.canonical || group.recommendedCanonical || "";
        var auditItems = opt.auditItems || [];
        var projectId = opt.projectId || "";

        if (!workspace) throw new Error("Не указана рабочая папка");
        if (!canonicalPath) throw new Error("Не указан canonical файл");

        var targets = [];
        var groupFiles = group.files || [];

        for (var i = 0; i < groupFiles.length; i++) {
            var gf = groupFiles[i];
            var gfNorm = normalizePath(gf.path);
            var refs = gf.references || [];

            for (var r = 0; r < refs.length; r++) {
                var refId = String(refs[r]);
                var matchingAudit = null;
                for (var a = 0; a < auditItems.length; a++) {
                    var ai = auditItems[a];
                    if (String(ai.id) === refId || String(ai.key) === refId) {
                        matchingAudit = ai;
                        break;
                    }
                }

                targets.push({
                    id: refId,
                    key: matchingAudit ? (matchingAudit.key || ("i" + matchingAudit.id)) : ("i" + refId),
                    oldPath: gf.path,
                    expectedSize: group.size || 0,
                    isProxy: group.kind === "proxy",
                    isSequence: group.kind === "sequence",
                    status: (normalizePath(gf.path) === normalizePath(canonicalPath)) ? "relinked" : "pending",
                    error: ""
                });
            }
        }

        var op = {
            schemaVersion: SCHEMA_VERSION,
            operationId: opt.operationId || generateId("op"),
            type: "consolidate_duplicates",
            state: "planned", // planned -> verified -> canonical_ready -> relinking -> completed
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            workspace: workspace,
            projectId: projectId,
            contentId: group.contentId || "",
            kind: group.kind || "file",
            size: group.size || 0,
            canonical: canonicalPath,
            canonicalCopied: false,
            targets: targets,
            results: {
                total: targets.length,
                relinked: 0,
                skipped: 0,
                failed: 0,
                failures: []
            },
            eventId: null,
            error: ""
        };

        api.saveOperation(workspace, op);
        return op;
    };

    /* ---------------------------------------------------- re-verification */

    api.reverify = function (workspaceRoot, op, currentAuditItems, callback) {
        if (!fs || !crypto) {
            callback(new Error("Node fs/crypto недоступен"));
            return;
        }

        if (op.kind === "proxy" && op.targets.some(function (t) { return !t.isProxy; })) {
            callback(new Error("Proxy и Original не могут смешиваться в одной операции"));
            return;
        }

        /* Check each target matches current audit item path */
        var auditMap = {};
        for (var a = 0; a < currentAuditItems.length; a++) {
            var it = currentAuditItems[a];
            auditMap[String(it.id)] = it;
            auditMap[it.key || ("i" + it.id)] = it;
        }

        for (var i = 0; i < op.targets.length; i++) {
            var tgt = op.targets[i];
            var currentIt = auditMap[tgt.id] || auditMap[tgt.key];
            if (!currentIt) {
                callback(new Error("Элемент проекта #" + tgt.id + " исчез из проекта"));
                return;
            }
            if (currentIt.state === "missing" || currentIt.missing === true) {
                callback(new Error("Элемент проекта #" + tgt.id + " потерян (missing)"));
                return;
            }
            var curNorm = normalizePath(currentIt.path);
            var expNorm = normalizePath(tgt.oldPath);
            if (curNorm !== expNorm) {
                callback(new Error("Путь элемента #" + tgt.id + " изменился: ожидался " + tgt.oldPath + ", текущий " + currentIt.path));
                return;
            }
        }

        /* Re-hash canonical file */
        if (!fs.existsSync(nativePath(op.canonical))) {
            callback(new Error("Canonical файл не существует: " + op.canonical));
            return;
        }

        var canStat = null;
        try { canStat = fs.statSync(nativePath(op.canonical)); } catch (e) {
            callback(new Error("Не удалось прочитать canonical: " + e.message));
            return;
        }

        if (op.kind !== "sequence" && op.size > 0 && canStat.size !== op.size) {
            callback(new Error("Размер canonical файла изменился"));
            return;
        }

        if (typeof PardDuplicateIndex !== "undefined" && PardDuplicateIndex.hashFile && op.kind !== "sequence") {
            PardDuplicateIndex.hashFile(op.canonical, {}, function (errH, digest) {
                if (errH) {
                    callback(new Error("Ошибка хэширования canonical: " + errH.message));
                    return;
                }
                if (op.contentId && digest !== op.contentId) {
                    callback(new Error("REHASH_MISMATCH: хэш canonical файла изменился"));
                    return;
                }
                callback(null, true);
            });
        } else {
            callback(null, true);
        }
    };

    /* ---------------------------------------------- external canonical copy */

    api.ensureCanonicalReady = function (workspaceRoot, op, options, callback) {
        var normWs = normalizePath(workspaceRoot);
        var normCan = normalizePath(op.canonical);
        var inWorkspace = normWs ? (normCan.indexOf(normWs + "/") === 0) : false;

        /* Check if canonical is already owned in assets.tsv */
        var ownedPaths = {};
        if (typeof PardDuplicateIndex !== "undefined" && PardDuplicateIndex.loadOwnedPaths) {
            ownedPaths = PardDuplicateIndex.loadOwnedPaths(workspaceRoot);
        }

        var isOwned = !!ownedPaths[normCan];

        if (inWorkspace && isOwned) {
            callback(null, op.canonical);
            return;
        }

        if (inWorkspace && !isOwned) {
            /* Already inside workspace, we can verify and use it */
            callback(null, op.canonical);
            return;
        }

        /* Canonical is outside workspace: must copy it safely first */
        if (typeof PardCopyQueue === "undefined" || !PardCopyQueue.run) {
            callback(new Error("PardCopyQueue недоступен для копирования canonical файла"));
            return;
        }

        var fileName = normCan.substring(normCan.lastIndexOf("/") + 1);
        var destFolder = normWs + "/01_assets/_SHARED/VIDEO";
        var destPath = destFolder + "/" + fileName;

        var copyTask = {
            key: "can-" + op.operationId,
            id: "can-" + op.operationId,
            name: fileName,
            path: op.canonical,
            sourcePath: op.canonical,
            destPath: destPath,
            destFolder: destFolder,
            branch: "_SHARED",
            category: "video",
            isSequence: op.kind === "sequence"
        };

        PardCopyQueue.run([copyTask], {
            reserveBytes: 0,
            freeBytes: Number.MAX_VALUE,
            stallMs: PardCopyQueue.DEFAULT_STALL_MS || 60000
        }, {}, function (results) {
            var r = results && results[0];
            if (!r || !r.ok) {
                callback(new Error("Не удалось скопировать canonical в рабочую папку: " + (r ? r.code : "UNKNOWN")));
                return;
            }

            /* Record provenance in assets.tsv */
            var lines = [];
            for (var j = 0; j < (r.records || []).length; j++) {
                var rec = r.records[j];
                if (!rec.created) continue;
                lines.push([
                    new Date().toISOString(), copyTask.key, rec.sourcePath,
                    rec.size, rec.destPath, copyTask.branch, copyTask.category
                ].join("\t"));
            }

            if (lines.length > 0) {
                var assetsFile = normWs + "/.parddefender/assets.tsv";
                var appendRes = PardCopyQueue.appendText(assetsFile, lines.join("\n") + "\n");
                if (!appendRes) {
                    /* Manifest failed before relink: do NOT relink! */
                    callback(new Error("MANIFEST_FAILED: не удалось записать provenance в assets.tsv"));
                    return;
                }
            }

            op.canonical = destPath;
            op.canonicalCopied = true;
            api.saveOperation(workspaceRoot, op);
            callback(null, destPath);
        });
    };

    /* ---------------------------------------------------- host relink plan */

    api.executeRelink = function (workspaceRoot, op, hostAdapter, currentAuditItems, callback) {
        var adapter = hostAdapter || (typeof PardHostAdapter !== "undefined" ? PardHostAdapter : null);
        if (!adapter || !adapter.commitFromFileJson) {
            callback(new Error("PardHostAdapter.commitFromFileJson недоступен"));
            return;
        }

        var relinkItems = [];
        var normCan = normalizePath(op.canonical);

        for (var i = 0; i < op.targets.length; i++) {
            var tgt = op.targets[i];
            if (normalizePath(tgt.oldPath) === normCan) {
                tgt.status = "relinked";
                continue;
            }
            relinkItems.push({
                id: tgt.id,
                key: tgt.key,
                expectPath: tgt.oldPath,
                destPath: op.canonical,
                isProxy: !!tgt.isProxy,
                isSequence: !!tgt.isSequence
            });
        }

        if (relinkItems.length === 0) {
            op.results.relinked = op.targets.length;
            callback(null, { ok: true, relinked: op.targets.length, skipped: 0, failures: [] });
            return;
        }

        var planPath = tempRoot(workspaceRoot) + "/consolidate-plan-" + op.operationId + ".json";
        var planBody = JSON.stringify({ items: relinkItems });

        if (typeof PardCopyQueue !== "undefined" && PardCopyQueue.writeText) {
            if (!PardCopyQueue.writeText(planPath, planBody)) {
                callback(new Error("Не удалось записать план перелинковки во временный файл"));
                return;
            }
        } else {
            try {
                ensureDir(tempRoot(workspaceRoot));
                fs.writeFileSync(nativePath(planPath), planBody, "utf8");
            } catch (ePlan) {
                callback(new Error("Не удалось записать план перелинковки: " + ePlan.message));
                return;
            }
        }

        adapter.commitFromFileJson(planPath, function (raw) {
            try { fs.unlinkSync(nativePath(planPath)); } catch (eUnlink) {}

            var parsed = null;
            try { parsed = JSON.parse(String(raw || "")); } catch (e) { parsed = null; }

            if (!parsed) {
                callback(new Error("Хост вернул повреждённый ответ на план перелинковки"));
                return;
            }

            var failures = parsed.failures || [];
            var relinkedMap = {};
            var failMap = {};
            for (var f = 0; f < failures.length; f++) {
                failMap[failures[f].id] = failures[f];
            }

            var relinkedCount = 0;
            var skippedCount = 0;
            var failedCount = 0;

            for (var t = 0; t < op.targets.length; t++) {
                var target = op.targets[t];
                if (target.status === "relinked") {
                    relinkedCount++;
                    continue;
                }
                var failure = failMap[target.id];
                if (failure) {
                    if (failure.code === "RELINK_SOURCE_CHANGED") {
                        target.status = "skipped";
                        target.error = failure.reason;
                        skippedCount++;
                    } else {
                        target.status = "failed";
                        target.error = failure.reason;
                        failedCount++;
                    }
                } else {
                    target.status = "relinked";
                    relinkedCount++;
                }
            }

            op.results = {
                total: op.targets.length,
                relinked: relinkedCount,
                skipped: skippedCount,
                failed: failedCount,
                failures: failures
            };

            callback(null, parsed);
        });
    };

    /* ---------------------------------------------------- run state machine */

    api.run = function (options, callback) {
        var opt = options || {};
        var cb = callback || function () {};
        var workspace = normalizePath(opt.workspace || "");
        var op = opt.operation || (opt.operationId ? api.loadOperation(workspace, opt.operationId) : null);
        var auditItems = opt.auditItems || [];
        var hostAdapter = opt.hostAdapter;

        if (!op) {
            try {
                op = api.createOperation(opt);
            } catch (eCreate) {
                cb(eCreate, null);
                return;
            }
        }

        /* Idempotency check */
        if (op.state === "completed") {
            cb(null, { ok: true, op: op, idempotent: true });
            return;
        }

        function fail(errMessage) {
            op.state = "failed";
            op.error = errMessage;
            api.saveOperation(workspace, op);
            cb(new Error(errMessage), op);
        }

        /* State: planned -> verified */
        function stepVerify() {
            api.reverify(workspace, op, auditItems, function (errV) {
                if (errV) {
                    fail(errV.message);
                    return;
                }
                op.state = "verified";
                api.saveOperation(workspace, op);
                stepCanonicalReady();
            });
        }

        /* State: verified -> canonical_ready */
        function stepCanonicalReady() {
            api.ensureCanonicalReady(workspace, op, opt, function (errC, readyPath) {
                if (errC) {
                    fail(errC.message);
                    return;
                }
                op.state = "canonical_ready";
                api.saveOperation(workspace, op);
                stepRelink();
            });
        }

        /* State: canonical_ready -> relinking -> completed / partial / failed */
        function stepRelink() {
            op.state = "relinking";
            api.saveOperation(workspace, op);

            api.executeRelink(workspace, op, hostAdapter, auditItems, function (errR, hostRes) {
                if (errR) {
                    fail(errR.message);
                    return;
                }

                var res = op.results;
                if (res.relinked === res.total) {
                    op.state = "completed";
                } else if (res.relinked > 0) {
                    op.state = "partial";
                } else {
                    op.state = "failed";
                    op.error = hostRes.error || "Ни один элемент не был перелинкован";
                }

                /* Journal event */
                if (typeof PardWorkspaceStore !== "undefined" && PardWorkspaceStore.appendEvent && (res.relinked > 0 || op.state === "completed")) {
                    try {
                        var evRes = PardWorkspaceStore.appendEvent(workspace, {
                            type: "consolidate_duplicates",
                            projectId: op.projectId,
                            contentId: op.contentId,
                            canonical: op.canonical,
                            relinkedCount: res.relinked,
                            totalCount: res.total,
                            operationId: op.operationId
                        });
                        if (evRes && evRes.eventId) op.eventId = evRes.eventId;
                    } catch (eEv) {}
                }

                api.saveOperation(workspace, op);
                cb(null, { ok: op.state === "completed", partial: op.state === "partial", op: op });
            });
        }

        if (op.state === "planned") {
            stepVerify();
        } else if (op.state === "verified") {
            stepCanonicalReady();
        } else if (op.state === "canonical_ready" || op.state === "relinking") {
            stepRelink();
        } else {
            cb(null, { ok: op.state === "completed", op: op });
        }
    };

    return api;
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = PardConsolidation;
}
