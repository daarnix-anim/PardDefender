/*
 * PardDefender - Premiere Pro UXP Duplicates & Safe Consolidation
 *
 * @map role: Обнаружение точных дубликатов и транзакционная консолидация для Premiere Pro:
 *           вся библиотека проекта и точное использование на таймлайнах, SHA-256,
 *           приоритет защищённого AE, повторная проверка и асинхронная перелинковка,
 *           двухкликовое подтверждение и строгое отсутствие удалений файлов.
 * @map status: ready
 *
 * Fully compatible with core PardDefender duplicate/operations schemas.
 */
var PardPremiereDuplicates = (function () {
    "use strict";

    var api = {};

    var fs = null;
    var path = null;
    try { fs = require("fs"); } catch (eFs) {}
    try { path = require("path"); } catch (ePath) {}

    function ensurePathFallback(targetPath) {
        if (targetPath && typeof targetPath.dirname === "function" && targetPath.sep) return targetPath;
        var isWin = (typeof process !== "undefined" && process.platform === "win32") ||
                    (typeof navigator !== "undefined" && /win/i.test(navigator.platform || navigator.userAgent)) ||
                    true; // Premiere Windows default
        var sepChar = isWin ? "\\" : "/";
        return {
            sep: sepChar,
            dirname: function (p) {
                if (!p) return ".";
                var s = String(p).replace(/\\/g, "/");
                var idx = s.lastIndexOf("/");
                if (idx === -1) return ".";
                if (idx === 0) return "/";
                var d = s.substring(0, idx);
                return sepChar === "\\" ? d.replace(/\//g, "\\") : d;
            },
            basename: function (p, ext) {
                if (!p) return "";
                var s = String(p).replace(/\\/g, "/");
                var b = s.substring(s.lastIndexOf("/") + 1);
                if (ext && b.indexOf(ext) === b.length - ext.length) b = b.substring(0, b.length - ext.length);
                return b;
            },
            join: function () {
                var parts = [];
                for (var i = 0; i < arguments.length; i++) {
                    if (arguments[i]) parts.push(String(arguments[i]));
                }
                var joined = parts.join("/").replace(/\\/g, "/").replace(/\/+/g, "/");
                return sepChar === "\\" ? joined.replace(/\//g, "\\") : joined;
            }
        };
    }

    path = ensurePathFallback(path);

    api.setFs = function (customFs) { fs = customFs; };
    api.setPath = function (customPath) { path = ensurePathFallback(customPath); };

    function normalizePath(p) {
        if (!p) return "";
        var s = String(p).trim().replace(/\\/g, "/");
        s = s.replace(/^\/+(\?|\.)\//, "");
        var isUnc = s.indexOf("//") === 0;
        s = s.replace(/\/+/g, "/");
        if (isUnc) s = "/" + s;
        if (/^[a-zA-Z]:\//.test(s)) {
            s = s.charAt(0).toLowerCase() + s.substring(1);
        }
        if (s.length > 3 && s.charAt(s.length - 1) === "/") {
            s = s.substring(0, s.length - 1);
        }
        return s;
    }

    api.normalizePath = normalizePath;

    function nativePath(p) {
        if (!p) return "";
        return path ? String(p).replace(/\//g, path.sep) : String(p);
    }

    function pathKey(p) {
        var normalized = normalizePath(p);
        return /^[a-z]:\//i.test(normalized) || /^[/\\]{2}/.test(p) ? normalized.toLowerCase() : normalized;
    }

    function eligible(it) {
        return it && it.classification === "clip" && it.path && !it.missing &&
            !it.isProxy && !it.hasProxy && !it.isSequence && !it.isImageSequence &&
            !/\d{3,}\.(png|jpe?g|exr|tiff?|dpx|tga|bmp)$/i.test(it.path);
    }

    function hashFile(engine, p) {
        return new Promise(function (resolve, reject) {
            engine.hashFile(p, function (err, digest) {
                if (err) reject(err);
                else if (!digest) reject(new Error("Не получена контрольная сумма: " + p));
                else resolve(digest);
            });
        });
    }

    async function readSize(file) {
        if (!fs) return file.size;
        var statFn = fs.lstat || fs.stat;
        if (typeof statFn === "function") {
            var stat = await new Promise(function (resolve, reject) {
                statFn.call(fs, nativePath(file.path), function (err, result) {
                    if (err) reject(err); else resolve(result);
                });
            });
            return stat.size;
        }
        if (fs.promises && fs.promises.stat) return (await fs.promises.stat(nativePath(file.path))).size;
        return file.size;
    }

    /* ---------------------------------------------------- duplicate scanning */

    api.scanDuplicates = function (workspace, auditItems, copyEngine, callbacks) {
        var cb = callbacks || {};
        var onProgress = cb.onProgress || function () {};
        var onDone = cb.onDone || function () {};

        async function scan() {
            var byPath = Object.create(null), errors = [], normWs = pathKey(workspace);
            function addFile(p, size) {
                var key = pathKey(p);
                if (!byPath[key]) byPath[key] = { path: p, size: size, references: [], items: [],
                    inWorkspace: !!normWs && key.indexOf(normWs + "/") === 0, isOwned: false, isAeProtected: false };
                return byPath[key];
            }
            var clips = (auditItems || []).filter(eligible);
            if (!clips.length) return { ok: true, duplicateGroups: [], reclaimableBytes: 0, errors: [] };
            clips.forEach(function (it) {
                var file = addFile(it.path, it.size);
                if (file.references.indexOf(it.id) === -1) {
                    file.references.push(it.id);
                    file.items.push({ id: it.id, name: it.name || "", binPath: it.binPath || "",
                        usedOnTimeline: it.usedOnTimelineExact === undefined ? it.usedOnTimeline === true : it.usedOnTimelineExact,
                        timelineOccurrences: it.timelineOccurrences || 0 });
                }
            });
            // AE metadata is only a candidate. The current bytes must join the same hash group.
            var aeItems = (cb.aeProtectedItems || []).slice();
            clips.forEach(function (it) { if (it.crossHost && it.crossHost.isAeProtected) aeItems.push(it.crossHost); });
            aeItems.forEach(function (ae) {
                var p = ae.canonicalPath || ae.path;
                if (!p || ae.isAeProtected === false || !eligible({ classification: ae.classification || "clip", path: p,
                    hasProxy: ae.hasProxy, isProxy: ae.isProxy, isSequence: ae.isSequence })) return;
                if (!copyEngine.isInProjectMediaFolder || !copyEngine.isInProjectMediaFolder(p, workspace)) return;
                addFile(p, ae.size).isAeProtected = true;
            });
            var all = Object.keys(byPath).map(function (key) { return byPath[key]; });
            var sizes = Object.create(null), projectSizes = Object.create(null), unknownSize = false;
            for (var i = 0; i < all.length; i++) {
                try {
                    all[i].size = await readSize(all[i]);
                    if (typeof all[i].size !== "number") unknownSize = true;
                    else {
                        sizes[all[i].size] = (sizes[all[i].size] || 0) + 1;
                        if (all[i].references.length) projectSizes[all[i].size] = true;
                    }
                } catch (eStat) {
                    all[i].unreadable = true;
                    errors.push({ path: all[i].path, code: "STAT_ERROR", message: eStat.message });
                }
            }
            var candidates = all.filter(function (file) {
                return !file.unreadable && (file.references.length > 1 || unknownSize || (projectSizes[file.size] && sizes[file.size] > 1));
            });
            var byHash = Object.create(null);
            for (var c = 0; c < candidates.length; c++) {
                var file = candidates[c];
                onProgress({ scannedFiles: c + 1, totalFiles: candidates.length,
                    percent: Math.round((c + 1) / candidates.length * 100) });
                try {
                    var digest = await hashFile(copyEngine, file.path);
                    if (!byHash[digest]) byHash[digest] = [];
                    byHash[digest].push(file);
                } catch (eHash) { errors.push({ path: file.path, code: "HASH_ERROR", message: eHash.message }); }
            }
            var groups = [], reclaimable = 0;
            Object.keys(byHash).forEach(function (digest) {
                var files = byHash[digest], itemCount = 0, timelineCount = 0;
                files.forEach(function (file) {
                    itemCount += file.references.length;
                    timelineCount += file.items.filter(function (it) { return it.usedOnTimeline; }).length;
                });
                // Do not report unrelated AE-only media. The project library is the starting point.
                if (!itemCount || (files.length === 1 && itemCount < 2)) return;
                files.sort(function (a, b) {
                    return Number(b.isAeProtected) - Number(a.isAeProtected) ||
                        Number(b.inWorkspace) - Number(a.inWorkspace) || b.references.length - a.references.length ||
                        (pathKey(a.path) < pathKey(b.path) ? -1 : 1);
                });
                var size = files[0].size || 0, bytes = (files.length - 1) * size;
                reclaimable += bytes;
                groups.push({ groupId: "grp-p-" + digest, contentId: digest,
                    kind: files.length === 1 ? "project-items" : "file", size: size, reclaimableBytes: bytes,
                    projectItemCount: itemCount, timelineItemCount: timelineCount,
                    recommendedCanonical: files[0].path, canonicalLocked: files[0].isAeProtected,
                    canConsolidate: files.length > 1, mergeProjectItemsSupported: false,
                    reasons: [files[0].isAeProtected ? "Проверенный защищённый файл After Effects" :
                        files[0].inWorkspace ? "Внутри рабочей папки" : "Наибольшее число ссылок"], files: files });
            });
            return { ok: true, duplicateGroups: groups, reclaimableBytes: reclaimable, errors: errors };
        }
        scan().then(onDone, function (err) { onDone({ ok: false, duplicateGroups: [], errors: [{ code: "SCAN_FAILED", message: err.message }] }); });
    };

    /* ---------------------------------------------------- consolidation */

    api.consolidateGroup = function (workspace, group, canonicalPath, projectItemsMap, copyEngine, callbacks) {
        var cb = callbacks || {};
        var onDone = cb.onDone || function () {};

        var relinked = 0, unchanged = 0, skipped = 0, failures = [], links = [];
        function fail(code, message) { var err = new Error(message); err.code = code; throw err; }
        async function checkProject() {
            if (cb.checkProject && await cb.checkProject() === false) fail("PROJECT_CHANGED", "Активный проект изменился. Повторите поиск дубликатов.");
        }
        async function consolidate() {
            if (!group || !group.files || !group.contentId) fail("INVALID_GROUP", "Некорректная группа дубликатов");
            var selected = group.files.filter(function (file) { return pathKey(file.path) === pathKey(canonicalPath); })[0];
            if (!selected) fail("INVALID_CANONICAL", "Выбранный файл отсутствует в проверенной группе");
            var aeFiles = group.files.filter(function (file) { return file.isAeProtected; });
            if (aeFiles.length && !selected.isAeProtected) fail("AE_CANONICAL_REQUIRED", "Основным должен быть защищённый файл After Effects");
            await checkProject();
            // Recheck every file and every live project reference before the first mutation.
            for (var f = 0; f < group.files.length; f++) {
                var file = group.files[f];
                if (await hashFile(copyEngine, file.path) !== group.contentId) fail("REHASH_MISMATCH", "Содержимое файла изменилось: " + file.path);
                for (var r = 0; r < file.references.length; r++) {
                    var id = file.references[r], item = projectItemsMap[id];
                    if (!item || typeof item.getMediaFilePath !== "function") fail("ITEM_NOT_FOUND", "Элемент не найден в проекте: " + id);
                    if (pathKey(await item.getMediaFilePath()) !== pathKey(file.path)) fail("STALE_SOURCE", "Источник элемента изменился: " + id);
                }
            }
            var target = canonicalPath;
            var canonicalIsManaged = copyEngine.isInProjectMediaFolder(canonicalPath, workspace);
            if (!canonicalIsManaged) {
                if (selected.isAeProtected) fail("AE_CANONICAL_OUTSIDE_WORKSPACE", "Защищённый файл AE находится вне рабочей папки");
                var sampleId = selected.references[0], sample = cb.auditItems && cb.auditItems.filter(function (it) { return it.id === sampleId; })[0];
                var route = copyEngine.resolveDestination(sample || { path: canonicalPath }, workspace, {});
                await checkProject();
                var copied = await new Promise(function (resolve) {
                    copyEngine.runQueue(workspace, [{ id: "can-cons-" + Date.now().toString(36), sourcePath: canonicalPath,
                        destPath: route.destPath, branch: route.branch, category: route.category, allowReuse: true }], {}, {
                        onDone: function (res) { resolve(res.results && res.results[0]); }
                    });
                });
                if (!copied || !copied.ok || !copied.destPath) fail("CANONICAL_COPY_FAILED", "Не удалось скопировать основной файл в проект");
                target = copied.destPath;
            }
            if (await hashFile(copyEngine, target) !== group.contentId) fail("REHASH_MISMATCH", "Содержимое основного файла изменилось");
            for (var fi = 0; fi < group.files.length; fi++) {
                var source = group.files[fi];
                for (var ri = 0; ri < source.references.length; ri++) {
                    var refId = source.references[ri], clip = projectItemsMap[refId];
                    await checkProject();
                    try {
                        if (pathKey(await clip.getMediaFilePath()) !== pathKey(source.path)) {
                            skipped++; failures.push({ id: refId, code: "STALE_SOURCE", reason: "Источник элемента изменился" }); continue;
                        }
                        if (pathKey(source.path) === pathKey(target)) { relinked++; unchanged++; continue; }
                        // Await official UXP promises; preserve the existing items, cuts and effects.
                        var result = await (copyEngine.relinkVerifiedClip ? copyEngine.relinkVerifiedClip(clip, target, source.path) :
                            copyEngine.relinkClip(clip, target, source.path));
                        if (result && result.ok) {
                            relinked++; links.push({ id: refId, oldPath: source.path, path: target, contentId: group.contentId });
                        } else {
                            if (result && result.code === "STALE_SOURCE") skipped++;
                            failures.push({ id: refId, code: result && result.code, reason: result && result.reason || "Сбой перелинковки" });
                        }
                    } catch (errRelink) { failures.push({ id: refId, code: "RELINK_FAILED", reason: errRelink.message }); }
                }
            }
            return { ok: failures.length === 0 && skipped === 0, partial: links.length > 0 && failures.length > 0,
                relinked: relinked, unchanged: unchanged, skipped: skipped, failures: failures, links: links, canonical: target };
        }
        consolidate().then(onDone, function (err) {
            onDone({ ok: false, code: err.code || "CONSOLIDATION_FAILED", message: err.message,
                partial: links.length > 0, relinked: relinked, unchanged: unchanged, skipped: skipped, failures: failures, links: links });
        });
    };

    return api;
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = PardPremiereDuplicates;
}
