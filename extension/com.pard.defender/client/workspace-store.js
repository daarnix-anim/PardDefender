/*
 * PardDefender - workspace and project registry.
 *
 * @map role: Общий слой метаданных рабочей зоны: идентификация проектов, блокировки и журнал событий.
 * @map status: ready
 *
 * Manages .parddefender/workspace.json, projects/<id>.json, project-paths.json,
 * locks/ and append-only events.jsonl across After Effects and Premiere Pro.
 */
var PardWorkspaceStore = (function () {
    "use strict";

    var api = {};

    var fs = null;
    var path = null;
    var crypto = null;

    try { fs = require("fs"); } catch (e) {}
    try { path = require("path"); } catch (e) {}
    try { crypto = require("crypto"); } catch (e) {}

    var SCHEMA_VERSION = 1;
    var DEFAULT_LOCK_TIMEOUT_MS = 2500;
    var DEFAULT_STALE_LOCK_MS = 5000;
    var DEFAULT_POLL_MS = 40;

    var currentWorkspace = "";
    var currentSession = { projectId: "" };

    api.attach = function (workspaceRoot) {
        var norm = api.normalizePath(workspaceRoot);
        if (norm !== currentWorkspace) {
            currentWorkspace = norm;
            currentSession.projectId = "";
        }
        if (currentWorkspace) {
            api.ensureWorkspace(currentWorkspace);
        }
    };

    api.detach = function () {
        currentWorkspace = "";
        currentSession.projectId = "";
    };

    api.currentSession = function () {
        return currentSession;
    };

    function nativePath(p) {
        if (!p) return "";
        return path ? String(p).replace(/\//g, path.sep) : String(p);
    }

    function generateId(prefix) {
        var pre = prefix ? String(prefix) + "-" : "";
        if (crypto && typeof crypto.randomBytes === "function") {
            try {
                return pre + crypto.randomBytes(8).toString("hex");
            } catch (e) {}
        }
        return pre + Date.now().toString(36) + "-" + Math.random().toString(36).substring(2, 10);
    }

    api.normalizePath = function (p) {
        if (!p) return "";
        var s = String(p).replace(/\\/g, "/").trim();
        /* Strip redundant duplicate slashes */
        s = s.replace(/\/+/g, "/");
        /* Standardize windows drive letter to lowercase: e.g. c:/ -> c:/ */
        if (/^[a-zA-Z]:\//.test(s)) {
            s = s.charAt(0).toLowerCase() + s.substring(1);
        }
        /* Strip trailing slash unless root */
        if (s.length > 3 && s.charAt(s.length - 1) === "/") {
            s = s.substring(0, s.length - 1);
        }
        return s;
    };

    api.metaDir = function (workspaceRoot) {
        return api.normalizePath(workspaceRoot) + "/.parddefender";
    };

    function ensureDir(dirPath) {
        if (!fs) return false;
        try {
            fs.mkdirSync(nativePath(dirPath), { recursive: true });
            return true;
        } catch (e) {
            return fs.existsSync(nativePath(dirPath));
        }
    }

    api.writeJsonAtomic = function (filePath, data, hookBeforeRename) {
        if (!fs) return false;
        var norm = api.normalizePath(filePath);
        var dir = norm.substring(0, norm.lastIndexOf("/"));
        if (!ensureDir(dir)) return false;

        var token = generateId("tmp");
        var tmpPath = norm + "." + token + ".tmp";
        var content = JSON.stringify(data, null, 2);

        try {
            fs.writeFileSync(nativePath(tmpPath), content, "utf8");
        } catch (eWrite) {
            return false;
        }

        if (typeof hookBeforeRename === "function") {
            try {
                hookBeforeRename(tmpPath, norm);
            } catch (eHook) {
                try { fs.unlinkSync(nativePath(tmpPath)); } catch (eClean) {}
                throw eHook;
            }
        }

        try {
            /* On Windows renameSync fails if target exists in older runtimes */
            if (fs.existsSync(nativePath(norm))) {
                try {
                    fs.renameSync(nativePath(tmpPath), nativePath(norm));
                    return true;
                } catch (eRename) {
                    fs.unlinkSync(nativePath(norm));
                }
            }
            fs.renameSync(nativePath(tmpPath), nativePath(norm));
            return true;
        } catch (e) {
            try {
                fs.copyFileSync(nativePath(tmpPath), nativePath(norm));
                fs.unlinkSync(nativePath(tmpPath));
                return true;
            } catch (e2) {
                try { fs.unlinkSync(nativePath(tmpPath)); } catch (eClean2) {}
                return false;
            }
        }
    };

    api.readJson = function (filePath) {
        if (!fs) return null;
        try {
            var raw = fs.readFileSync(nativePath(filePath), "utf8");
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    };

    /* ------------------------------------------------------------- locks */

    function removeDirRecursive(dirPath) {
        if (!fs) return;
        var native = nativePath(dirPath);
        try {
            if (typeof fs.rmSync === "function") {
                fs.rmSync(native, { recursive: true, force: true });
                return;
            }
            var entries = fs.readdirSync(native);
            for (var i = 0; i < entries.length; i++) {
                var p = nativePath(dirPath + "/" + entries[i]);
                try {
                    var s = fs.statSync(p);
                    if (s.isDirectory()) removeDirRecursive(p);
                    else fs.unlinkSync(p);
                } catch (e1) {}
            }
            fs.rmdirSync(native);
        } catch (e) {}
    }

    api.withLock = function (workspaceRoot, lockName, fn, options) {
        if (!fs) return fn();
        var opt = options || {};
        var meta = api.metaDir(workspaceRoot);
        var locksDir = meta + "/locks";
        ensureDir(locksDir);

        var name = (lockName || "workspace").replace(/[^a-zA-Z0-9_\-]/g, "_");
        var lockDir = locksDir + "/" + name + ".lock";
        var ownerFile = lockDir + "/owner.json";

        var timeoutMs = opt.timeoutMs !== undefined ? opt.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
        var staleMs = opt.staleMs !== undefined ? opt.staleMs : DEFAULT_STALE_LOCK_MS;
        var pollMs = opt.pollMs !== undefined ? opt.pollMs : DEFAULT_POLL_MS;
        var token = opt.token || generateId("lock");

        var start = Date.now();
        var acquired = false;

        while (!acquired) {
            try {
                fs.mkdirSync(nativePath(lockDir));
                acquired = true;
                /* Record owner info */
                var info = { token: token, at: Date.now(), pid: (typeof process !== "undefined" ? process.pid : 0) };
                try {
                    fs.writeFileSync(nativePath(ownerFile), JSON.stringify(info), "utf8");
                } catch (eOwner) {}
                break;
            } catch (eMkdir) {
                var now = Date.now();
                /* Lock exists. Check if stale */
                var owner = api.readJson(ownerFile);
                var lockAge = owner && owner.at ? (now - owner.at) : null;

                if (lockAge !== null && lockAge > staleMs) {
                    /* Stale lock: break safely */
                    removeDirRecursive(lockDir);
                    continue;
                }

                if (now - start >= timeoutMs) {
                    throw new Error("Lock timeout on " + name + " after " + (now - start) + "ms");
                }

                /* Synchronous wait */
                var sleepUntil = Date.now() + pollMs;
                while (Date.now() < sleepUntil) {}
            }
        }

        try {
            return fn();
        } finally {
            if (acquired) {
                /* Verify we are still owner before releasing */
                var curOwner = api.readJson(ownerFile);
                if (!curOwner || curOwner.token === token) {
                    removeDirRecursive(lockDir);
                }
            }
        }
    };

    /* --------------------------------------------------------- workspace */

    api.ensureWorkspace = function (workspaceRoot) {
        var normRoot = api.normalizePath(workspaceRoot);
        if (!normRoot) return { ok: false, error: "Не указана рабочая папка." };

        return api.withLock(normRoot, "workspace", function () {
            var meta = api.metaDir(normRoot);
            ensureDir(meta);
            ensureDir(meta + "/projects");
            ensureDir(meta + "/locks");

            var wsFile = meta + "/workspace.json";
            var existing = api.readJson(wsFile);
            var now = new Date().toISOString();

            if (existing && existing.workspaceId) {
                existing.updatedAt = now;
                existing.root = normRoot;
                api.writeJsonAtomic(wsFile, existing);
                return { ok: true, workspace: existing, workspaceId: existing.workspaceId };
            }

            var ws = {
                schemaVersion: SCHEMA_VERSION,
                workspaceId: generateId("ws"),
                root: normRoot,
                createdAt: now,
                updatedAt: now
            };

            var ok = api.writeJsonAtomic(wsFile, ws);
            if (!ok) return { ok: false, error: "Не удалось сохранить workspace.json" };
            return { ok: true, workspace: ws, workspaceId: ws.workspaceId };
        });
    };

    /* ----------------------------------------------------------- project */

    api.registerProject = function (workspaceRoot, projectInfo, session) {
        var normRoot = api.normalizePath(workspaceRoot);
        if (!normRoot) return { ok: false, error: "Не указана рабочая папка." };

        var wsRes = api.ensureWorkspace(normRoot);
        if (!wsRes.ok) return wsRes;
        var workspaceId = wsRes.workspaceId;

        var info = projectInfo || {};
        var host = String(info.host || "after-effects");
        var rawPath = String(info.path || "");
        var normPath = api.normalizePath(rawPath);
        var projectGuid = info.projectGuid ? String(info.projectGuid) : null;
        var sess = session || {};

        if (!normPath) return { ok: false, error: "Не указан путь к проекту." };

        return api.withLock(normRoot, "projects", function () {
            var meta = api.metaDir(normRoot);
            var projectsDir = meta + "/projects";
            ensureDir(projectsDir);

            var pathIndexFile = meta + "/project-paths.json";
            var pathIndex = api.readJson(pathIndexFile) || {};
            var indexKey = host + ":" + normPath;

            var existingId = null;
            var now = new Date().toISOString();

            /* 1. Premiere GUID-based lookup */
            if (host === "premiere-pro" && projectGuid) {
                var projectFiles = [];
                try {
                    projectFiles = fs.readdirSync(nativePath(projectsDir));
                } catch (eDir) {}

                for (var i = 0; i < projectFiles.length; i++) {
                    if (!/\.json$/i.test(projectFiles[i])) continue;
                    var pRecord = api.readJson(projectsDir + "/" + projectFiles[i]);
                    if (pRecord && pRecord.host === "premiere-pro" && pRecord.projectGuid === projectGuid) {
                        existingId = pRecord.projectId;
                        break;
                    }
                }
            }

            /* 2. Session-based lookup for Save As in current AE session */
            if (!existingId && sess.projectId) {
                var sessFile = projectsDir + "/" + sess.projectId + ".json";
                var sessRecord = api.readJson(sessFile);
                if (sessRecord && sessRecord.host === host) {
                    existingId = sess.projectId;
                }
            }

            /* 3. Path index lookup */
            if (!existingId && pathIndex[indexKey]) {
                existingId = pathIndex[indexKey];
            }

            /* Check for conflict: another project with different ID claiming this path */
            if (pathIndex[indexKey] && existingId && pathIndex[indexKey] !== existingId) {
                return {
                    ok: false,
                    conflict: true,
                    error: "Конфликт: путь " + normPath + " уже зарегистрирован за проектом " + pathIndex[indexKey],
                    claimedBy: pathIndex[indexKey],
                    attemptedId: existingId
                };
            }

            var record = null;
            if (existingId) {
                var recFile = projectsDir + "/" + existingId + ".json";
                record = api.readJson(recFile);
            }

            if (record) {
                /* Check if projectGuid conflicts */
                if (projectGuid && record.projectGuid && record.projectGuid !== projectGuid) {
                    return {
                        ok: false,
                        conflict: true,
                        error: "Конфликт GUID для проекта " + existingId,
                        claimedGuid: record.projectGuid,
                        attemptedGuid: projectGuid
                    };
                }

                /* Update path if changed (e.g. Save As) */
                var oldKey = record.host + ":" + record.normalizedPath;
                if (oldKey !== indexKey && pathIndex[oldKey] === record.projectId) {
                    delete pathIndex[oldKey];
                }

                record.path = rawPath;
                record.normalizedPath = normPath;
                if (projectGuid) record.projectGuid = projectGuid;
                record.lastSeenAt = now;
                record.workspaceId = workspaceId;

                api.writeJsonAtomic(projectsDir + "/" + record.projectId + ".json", record);
                pathIndex[indexKey] = record.projectId;
                api.writeJsonAtomic(pathIndexFile, pathIndex);

                if (sess) sess.projectId = record.projectId;
                return { ok: true, project: record, projectId: record.projectId, updated: true };
            }

            /* Create brand new project record */
            var newId = generateId("proj");
            record = {
                schemaVersion: SCHEMA_VERSION,
                projectId: newId,
                workspaceId: workspaceId,
                host: host,
                projectGuid: projectGuid,
                path: rawPath,
                normalizedPath: normPath,
                firstSeenAt: now,
                lastSeenAt: now
            };

            api.writeJsonAtomic(projectsDir + "/" + newId + ".json", record);
            pathIndex[indexKey] = newId;
            api.writeJsonAtomic(pathIndexFile, pathIndex);

            if (sess) sess.projectId = newId;
            return { ok: true, project: record, projectId: newId, created: true };
        });
    };

    /* ------------------------------------------------------------ events */

    api.appendEvent = function (workspaceRoot, eventData) {
        var normRoot = api.normalizePath(workspaceRoot);
        if (!normRoot) return { ok: false, error: "Не указана рабочая папка." };
        if (!fs) return { ok: false, error: "Node fs недоступен." };

        var ev = eventData || {};
        var eventId = ev.eventId || generateId("ev");
        var now = ev.createdAt || new Date().toISOString();

        return api.withLock(normRoot, "events", function () {
            var meta = api.metaDir(normRoot);
            ensureDir(meta);
            var eventsFile = meta + "/events.jsonl";

            /* Idempotency check */
            var existingRaw = "";
            try {
                existingRaw = fs.readFileSync(nativePath(eventsFile), "utf8");
            } catch (e) {}

            if (existingRaw) {
                var lines = existingRaw.split(/\r?\n/);
                for (var i = 0; i < lines.length; i++) {
                    var l = lines[i].trim();
                    if (!l) continue;
                    try {
                        var parsed = JSON.parse(l);
                        if (parsed && parsed.eventId === eventId) {
                            return { ok: true, eventId: eventId, duplicate: true };
                        }
                    } catch (eParse) {}
                }
            }

            var record = {
                schemaVersion: SCHEMA_VERSION,
                eventId: eventId,
                workspaceId: ev.workspaceId || "",
                projectId: ev.projectId || "",
                host: ev.host || "",
                type: String(ev.type || "generic"),
                createdAt: now,
                payload: ev.payload || {}
            };

            var line = JSON.stringify(record) + "\n";
            try {
                fs.appendFileSync(nativePath(eventsFile), line, "utf8");
                return { ok: true, eventId: eventId, event: record };
            } catch (eAppend) {
                return { ok: false, error: "Не удалось записать в events.jsonl: " + eAppend.message };
            }
        });
    };

    api.readEvents = function (workspaceRoot) {
        var normRoot = api.normalizePath(workspaceRoot);
        if (!normRoot) return { ok: false, error: "Не указана рабочая папка.", events: [] };
        if (!fs) return { ok: false, error: "Node fs недоступен.", events: [] };

        var meta = api.metaDir(normRoot);
        var eventsFile = meta + "/events.jsonl";
        var raw = "";
        try {
            raw = fs.readFileSync(nativePath(eventsFile), "utf8");
        } catch (e) {
            return { ok: true, events: [] };
        }

        var lines = raw.split(/\r?\n/);
        var nonEmpty = [];
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].trim().length > 0) nonEmpty.push({ index: i, text: lines[i] });
        }

        var out = [];
        var truncatedLast = false;

        for (var j = 0; j < nonEmpty.length; j++) {
            var item = nonEmpty[j];
            var isLast = (j === nonEmpty.length - 1);
            try {
                var parsed = JSON.parse(item.text);
                out.push(parsed);
            } catch (e) {
                if (isLast) {
                    /* Tolerate truncated last line */
                    truncatedLast = true;
                } else {
                    return {
                        ok: false,
                        error: "Повреждена строка " + (item.index + 1) + " в events.jsonl",
                        corruptedLine: item.index + 1,
                        events: out
                    };
                }
            }
        }

        return { ok: true, events: out, truncatedLastLine: truncatedLast };
    };

    return api;
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = PardWorkspaceStore;
}
