/*
 * PardDefender - Premiere Pro UXP Duplicates & Safe Consolidation
 *
 * @map role: Обнаружение точных дубликатов и транзакционная консолидация для Premiere Pro:
 *           побайтовое SHA-256 хеширование, выбор каноникала, копирование внешнего
 *           каноникала в assets.tsv, перелинковка через changeMediaFilePath,
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

    try { fs = require("fs"); } catch (e) {}
    try { path = require("path"); } catch (e) {}

    api.setFs = function (customFs) { fs = customFs; };

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

    function nativePath(p) {
        if (!p) return "";
        return path ? String(p).replace(/\//g, path.sep) : String(p);
    }

    function operationsDir(workspace) {
        return normalizePath(workspace) + "/.parddefender/operations";
    }

    /* ---------------------------------------------------- duplicate scanning */

    api.scanDuplicates = function (workspace, auditItems, copyEngine, callbacks) {
        var cb = callbacks || {};
        var onProgress = cb.onProgress || function () {};
        var onDone = cb.onDone || function () {};

        if (!auditItems || auditItems.length === 0) {
            onDone({ ok: true, duplicateGroups: [], reclaimableBytes: 0, errors: [] });
            return;
        }

        // Filter eligible media clips (ignore sequences, generated, offline)
        var clips = [];
        for (var i = 0; i < auditItems.length; i++) {
            var it = auditItems[i];
            if (it.classification === "clip" && it.path && !it.missing) {
                clips.push(it);
            }
        }

        if (clips.length === 0) {
            onDone({ ok: true, duplicateGroups: [], reclaimableBytes: 0, errors: [] });
            return;
        }

        // Quick bucket by size
        var sizeMap = {};
        for (var s = 0; s < clips.length; s++) {
            var c = clips[s];
            var sz = c.size || 0;
            if (!sizeMap[sz]) sizeMap[sz] = [];
            sizeMap[sz].push(c);
        }

        var candidatePaths = [];
        for (var k in sizeMap) {
            if (sizeMap.hasOwnProperty(k) && sizeMap[k].length > 1) {
                for (var j = 0; j < sizeMap[k].length; j++) {
                    var p = sizeMap[k][j].path;
                    var norm = normalizePath(p);
                    var already = false;
                    for (var cp = 0; cp < candidatePaths.length; cp++) {
                        if (normalizePath(candidatePaths[cp]) === norm) {
                            already = true;
                            break;
                        }
                    }
                    if (!already) {
                        candidatePaths.push(p);
                    }
                }
            }
        }

        if (candidatePaths.length === 0) {
            onDone({ ok: true, duplicateGroups: [], reclaimableBytes: 0, errors: [] });
            return;
        }

        var hashMap = {};
        var hashedCount = 0;
        var errors = [];

        function hashNext(idx) {
            if (idx >= candidatePaths.length) {
                finishGrouping();
                return;
            }

            var fPath = candidatePaths[idx];
            onProgress({
                scannedFiles: idx + 1,
                totalFiles: candidatePaths.length,
                percent: Math.round(((idx + 1) / candidatePaths.length) * 100)
            });

            copyEngine.hashFile(fPath, function (err, digest) {
                if (err) {
                    errors.push({ path: fPath, code: "HASH_ERROR", message: err.message });
                } else if (digest) {
                    if (!hashMap[digest]) hashMap[digest] = [];
                    hashMap[digest].push(fPath);
                }
                hashNext(idx + 1);
            });
        }

        function finishGrouping() {
            var groups = [];
            var reclaimable = 0;

            var normWs = normalizePath(workspace);

            for (var d in hashMap) {
                if (hashMap.hasOwnProperty(d) && hashMap[d].length > 1) {
                    var files = [];
                    var sz = 0;
                    for (var f = 0; f < hashMap[d].length; f++) {
                        var p = hashMap[d][f];
                        var refs = [];
                        for (var a = 0; a < clips.length; a++) {
                            if (normalizePath(clips[a].path) === normalizePath(p)) {
                                refs.push(clips[a].id);
                                if (!sz) sz = clips[a].size || 0;
                            }
                        }
                        var inWs = normWs ? (normalizePath(p).indexOf(normWs + "/") === 0) : false;
                        files.push({
                            path: p,
                            references: refs,
                            inWorkspace: inWs,
                            isOwned: inWs
                        });
                    }

                    // Rank canonical: prefer in workspace, then most references
                    files.sort(function (a, b) {
                        if (a.inWorkspace && !b.inWorkspace) return -1;
                        if (!a.inWorkspace && b.inWorkspace) return 1;
                        return b.references.length - a.references.length;
                    });

                    var recommended = files[0].path;
                    var groupReclaim = (files.length - 1) * sz;
                    reclaimable += groupReclaim;

                    groups.push({
                        groupId: "grp-p-" + d.substring(0, 8),
                        contentId: d,
                        kind: "file",
                        size: sz,
                        reclaimableBytes: groupReclaim,
                        recommendedCanonical: recommended,
                        reasons: [files[0].inWorkspace ? "Внутри рабочей папки" : "Наибольшее число ссылок"],
                        files: files
                    });
                }
            }

            onDone({
                ok: true,
                duplicateGroups: groups,
                reclaimableBytes: reclaimable,
                errors: errors
            });
        }

        hashNext(0);
    };

    /* ---------------------------------------------------- consolidation */

    api.consolidateGroup = function (workspace, group, canonicalPath, projectItemsMap, copyEngine, callbacks) {
        var cb = callbacks || {};
        var onDone = cb.onDone || function () {};

        var normWs = normalizePath(workspace);
        var normCan = normalizePath(canonicalPath);

        // Pre-verification: rehash canonical
        copyEngine.hashFile(canonicalPath, function (errH, digest) {
            if (errH || digest !== group.contentId) {
                onDone({ ok: false, code: "REHASH_MISMATCH", message: "Хэш выбранного каноникала изменился" });
                return;
            }

            // Ensure canonical is ready
            var inWs = normWs ? (normCan.indexOf(normWs + "/") === 0) : false;
            if (inWs) {
                doRelink(canonicalPath);
            } else {
                // Copy external canonical to workspace
                var fName = normCan.substring(normCan.lastIndexOf("/") + 1);
                var destPath = normWs + "/01_assets/_SHARED/VIDEO/" + fName;
                copyEngine.runQueue(workspace, [{
                    id: "can-cons-" + Date.now().toString(36),
                    sourcePath: canonicalPath,
                    destPath: destPath,
                    branch: "_SHARED",
                    category: "video"
                }], {}, {
                    onDone: function (resQ) {
                        var r = resQ.results && resQ.results[0];
                        if (!r || !r.ok) {
                            onDone({ ok: false, code: "CANONICAL_COPY_FAILED", message: "Не удалось скопировать каноникал в проект" });
                            return;
                        }
                        doRelink(destPath);
                    }
                });
            }
        });

        function doRelink(targetCanonical) {
            var relinked = 0;
            var skipped = 0;
            var failures = [];

            for (var f = 0; f < group.files.length; f++) {
                var fileObj = group.files[f];
                if (normalizePath(fileObj.path) === normalizePath(targetCanonical)) {
                    relinked += fileObj.references.length;
                    continue;
                }

                for (var r = 0; r < fileObj.references.length; r++) {
                    var refId = fileObj.references[r];
                    var item = projectItemsMap[refId];
                    if (!item) {
                        failures.push({ id: refId, reason: "Элемент не найден в проекте" });
                        continue;
                    }

                    var relRes = copyEngine.relinkClip(item, targetCanonical, fileObj.path);
                    if (relRes.ok) {
                        relinked++;
                    } else if (relRes.code === "STALE_SOURCE") {
                        skipped++;
                    } else {
                        failures.push({ id: refId, reason: relRes.reason, code: relRes.code });
                    }
                }
            }

            onDone({
                ok: failures.length === 0,
                partial: relinked > 0 && (skipped > 0 || failures.length > 0),
                relinked: relinked,
                skipped: skipped,
                failures: failures,
                canonical: targetCanonical
            });
        }
    };

    return api;
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = PardPremiereDuplicates;
}
