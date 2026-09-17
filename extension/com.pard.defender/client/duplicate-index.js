/*
 * PardDefender - exact duplicate detection engine.
 *
 * @map role: Движок поиска точных дубликатов: группировка по размерам, потоковый SHA-256, hash-cache и секвенции.
 * @map status: ready
 *
 * Scans project items for exact byte duplicates without moving or relinking files.
 * Caches hashes in .parddefender/hash-cache.json and ranks recommended canonicals.
 */
var PardDuplicateIndex = (function () {
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

    api.normalizePath = function (p) {
        if (!p) return "";
        var s = String(p).replace(/\\/g, "/").trim().replace(/\/+/g, "/");
        if (/^[a-zA-Z]:\//.test(s)) {
            s = s.charAt(0).toLowerCase() + s.substring(1);
        }
        if (s.length > 3 && s.charAt(s.length - 1) === "/") {
            s = s.substring(0, s.length - 1);
        }
        return s;
    };

    /* ------------------------------------------------------------- cache */

    api.loadCache = function (workspaceRoot) {
        if (!fs || !workspaceRoot) return { schemaVersion: SCHEMA_VERSION, entries: {} };
        var cacheFile = api.normalizePath(workspaceRoot) + "/.parddefender/hash-cache.json";
        try {
            var raw = fs.readFileSync(nativePath(cacheFile), "utf8");
            var parsed = JSON.parse(raw);
            if (parsed && typeof parsed.entries === "object") return parsed;
        } catch (e) {}
        return { schemaVersion: SCHEMA_VERSION, entries: {} };
    };

    api.saveCache = function (workspaceRoot, cache) {
        if (!fs || !workspaceRoot || !cache) return false;
        var metaDir = api.normalizePath(workspaceRoot) + "/.parddefender";
        try { fs.mkdirSync(nativePath(metaDir), { recursive: true }); } catch (eDir) {}
        if (!fs.existsSync(nativePath(metaDir))) return false;
        var cacheFile = metaDir + "/hash-cache.json";
        var token = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
        var tmpFile = cacheFile + "." + token + ".tmp";

        try {
            fs.writeFileSync(nativePath(tmpFile), JSON.stringify(cache, null, 2), "utf8");
            if (fs.existsSync(nativePath(cacheFile))) {
                try { fs.renameSync(nativePath(tmpFile), nativePath(cacheFile)); return true; }
                catch (eRen) { fs.unlinkSync(nativePath(cacheFile)); }
            }
            fs.renameSync(nativePath(tmpFile), nativePath(cacheFile));
            return true;
        } catch (e) {
            try { fs.unlinkSync(nativePath(tmpFile)); } catch (e2) {}
            return false;
        }
    };

    /* ----------------------------------------------------------- hashing */

    api.hashFile = function (filePath, options, callback) {
        var opt = options || {};
        var cb = callback || function () {};

        if (!fs || !crypto) {
            cb(new Error("Node fs/crypto недоступен"), null);
            return;
        }

        if (opt.cancelToken && opt.cancelToken.cancelled) {
            cb(new Error("CANCELLED"), null);
            return;
        }

        var hasher = crypto.createHash("sha256");
        var stream = null;

        try {
            stream = fs.createReadStream(nativePath(filePath));
        } catch (eStream) {
            cb(eStream, null);
            return;
        }

        var finished = false;
        function finish(err, digest) {
            if (finished) return;
            finished = true;
            cb(err, digest);
        }

        stream.on("data", function (chunk) {
            if (opt.cancelToken && opt.cancelToken.cancelled) {
                try { stream.destroy(); } catch (eDest) {}
                finish(new Error("CANCELLED"), null);
                return;
            }
            hasher.update(chunk);
        });

        stream.on("end", function () {
            finish(null, hasher.digest("hex"));
        });

        stream.on("error", function (err) {
            finish(err, null);
        });
    };

    /* ------------------------------------------------------- assets.tsv */

    api.loadOwnedPaths = function (workspaceRoot) {
        var owned = {};
        if (!fs || !workspaceRoot) return owned;
        var manifestFile = api.normalizePath(workspaceRoot) + "/.parddefender/assets.tsv";
        var raw = "";
        try {
            raw = fs.readFileSync(nativePath(manifestFile), "utf8");
        } catch (e) {
            return owned;
        }

        var lines = raw.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            var cols = lines[i].split("\t");
            if (cols.length >= 5 && cols[4]) {
                owned[api.normalizePath(cols[4])] = true;
            }
        }
        return owned;
    };

    /* --------------------------------------------------------- canonical */

    api.rankCanonical = function (fileA, fileB) {
        /*
         * Canonical preference:
         * 1. verified owned path (assets.tsv)
         * 2. inside workspace
         * 3. non-temporary route
         * 4. stable lexical path
         */
        if (fileA.isOwned !== fileB.isOwned) return fileA.isOwned ? -1 : 1;
        if (fileA.inWorkspace !== fileB.inWorkspace) return fileA.inWorkspace ? -1 : 1;
        if (fileA.isTemporaryRoute !== fileB.isTemporaryRoute) return fileA.isTemporaryRoute ? 1 : -1;
        return fileA.normalizedPath.localeCompare(fileB.normalizedPath);
    };

    api.canonicalReasons = function (file) {
        var reasons = [];
        if (file.isOwned) reasons.push("Файл проверен и принадлежит проекту (assets.tsv)");
        if (file.inWorkspace) reasons.push("Файл расположен внутри рабочей папки");
        if (!file.isTemporaryRoute) reasons.push("Файл расположен в постоянном маршруте");
        reasons.push("Стабильный путь в алфавитном порядке");
        return reasons;
    };

    /* ------------------------------------------------------- scan engine */

    api.scan = function (options, callback) {
        var opt = options || {};
        var cb = callback || function () {};
        var workspaceRoot = api.normalizePath(opt.workspaceRoot || "");
        var items = opt.items || [];
        var cancelToken = opt.cancelToken || { cancelled: false };
        var onProgress = typeof opt.onProgress === "function" ? opt.onProgress : function () {};

        var cache = api.loadCache(workspaceRoot);
        var ownedPaths = api.loadOwnedPaths(workspaceRoot);
        var cacheDirty = false;

        var terminalCalled = false;
        function done(err, result) {
            if (terminalCalled) return;
            terminalCalled = true;
            if (cacheDirty && workspaceRoot) {
                try { api.saveCache(workspaceRoot, cache); } catch (eSave) {}
            }
            cb(err, result);
        }

        if (cancelToken.cancelled) {
            done(new Error("CANCELLED"), null);
            return;
        }

        /*
         * Step 1: Collect unique physical targets and separate originals from proxies.
         * Project items pointing to the exact same normalized path are stored as references.
         */
        var uniqueFiles = {}; // key: normPath -> fileDescriptor
        var sequences = [];

        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var rawP = String(it.path || "");
            var normP = api.normalizePath(rawP);
            if (!normP) continue;

            if (it.isSequence === true) {
                sequences.push(it);
                continue;
            }

            var key = (it.isProxy ? "proxy:" : "orig:") + normP;
            if (!uniqueFiles[key]) {
                var inWs = workspaceRoot ? normP.indexOf(workspaceRoot + "/") === 0 : false;
                var isTemp = /\/(00_UNUSED|parddefender-client|temp|tmp)\//i.test(normP);
                uniqueFiles[key] = {
                    key: key,
                    path: rawP,
                    normalizedPath: normP,
                    name: it.name || normP.substring(normP.lastIndexOf("/") + 1),
                    isProxy: !!it.isProxy,
                    inWorkspace: inWs,
                    isOwned: !!ownedPaths[normP],
                    isTemporaryRoute: isTemp,
                    references: [String(it.id || it.name || it.key || "")],
                    size: null,
                    mtimeMs: null,
                    statError: null,
                    sha256: null
                };
            } else {
                uniqueFiles[key].references.push(String(it.id || it.name || it.key || ""));
            }
        }

        var fileList = [];
        var k;
        for (k in uniqueFiles) {
            if (uniqueFiles.hasOwnProperty(k)) fileList.push(uniqueFiles[k]);
        }

        /* Step 2: Stat all files and group by (isProxy, size) */
        for (var s = 0; s < fileList.length; s++) {
            var f = fileList[s];
            if (!fs) {
                f.statError = "fs unavailable";
                continue;
            }
            try {
                var st = fs.statSync(nativePath(f.path));
                f.size = st.size;
                f.mtimeMs = st.mtimeMs || (st.mtime ? st.mtime.getTime() : 0);
            } catch (eStat) {
                f.statError = eStat.message;
            }
        }

        /* Separate groups of size > 1 */
        var sizeBuckets = {}; // "orig:12345" -> [f1, f2, ...]
        for (var b = 0; b < fileList.length; b++) {
            var fileObj = fileList[b];
            if (fileObj.statError || fileObj.size === null) continue;
            var bucketKey = (fileObj.isProxy ? "proxy:" : "orig:") + fileObj.size;
            if (!sizeBuckets[bucketKey]) sizeBuckets[bucketKey] = [];
            sizeBuckets[bucketKey].push(fileObj);
        }

        var filesToHash = [];
        for (var bKey in sizeBuckets) {
            if (sizeBuckets.hasOwnProperty(bKey) && sizeBuckets[bKey].length > 1) {
                for (var fIdx = 0; fIdx < sizeBuckets[bKey].length; fIdx++) {
                    filesToHash.push(sizeBuckets[bKey][fIdx]);
                }
            }
        }

        var totalCandidateBytes = 0;
        for (var tb = 0; tb < filesToHash.length; tb++) {
            totalCandidateBytes += (filesToHash[tb].size || 0);
        }
        var hashedBytes = 0;

        var totalSteps = filesToHash.length + sequences.length;
        var currentStep = 0;

        function reportProg(phase) {
            var pct = totalSteps > 0 ? Math.min(100, Math.round((currentStep / totalSteps) * 100)) : 100;
            onProgress({
                phase: phase,
                current: currentStep,
                total: totalSteps,
                scannedFiles: currentStep,
                totalFiles: totalSteps,
                scannedBytes: hashedBytes,
                totalBytes: totalCandidateBytes,
                percent: pct
            });
        }

        reportProg("init");

        /* Step 3: Sequential async hashing of files needing SHA-256 */
        var hashIdx = 0;

        function processNextFile() {
            if (cancelToken.cancelled) {
                done(new Error("CANCELLED"), null);
                return;
            }

            if (hashIdx >= filesToHash.length) {
                processSequences();
                return;
            }

            var item = filesToHash[hashIdx++];
            var cached = cache.entries[item.normalizedPath];

            /* Check cache validity: size and mtime must match */
            if (cached && cached.size === item.size && cached.mtimeMs === item.mtimeMs && cached.sha256) {
                item.sha256 = cached.sha256;
                hashedBytes += (item.size || 0);
                currentStep++;
                reportProg("hash");
                processNextFile();
                return;
            }

            api.hashFile(item.path, { cancelToken: cancelToken }, function (err, digest) {
                if (err) {
                    if (err.message === "CANCELLED" || (cancelToken && cancelToken.cancelled)) {
                        done(new Error("CANCELLED"), null);
                        return;
                    }
                    item.hashError = err.message;
                } else {
                    item.sha256 = digest;
                    cache.entries[item.normalizedPath] = {
                        size: item.size,
                        mtimeMs: item.mtimeMs,
                        sha256: digest
                    };
                    cacheDirty = true;
                }
                hashedBytes += (item.size || 0);
                currentStep++;
                reportProg("hash");
                processNextFile();
            });
        }

        /* Step 4: Process image sequences */
        function processSequences() {
            var seqIdx = 0;
            var seqResults = [];

            function nextSeq() {
                if (cancelToken.cancelled) {
                    done(new Error("CANCELLED"), null);
                    return;
                }

                if (seqIdx >= sequences.length) {
                    buildFinalResult(seqResults);
                    return;
                }

                var seqItem = sequences[seqIdx++];
                var seqData = seqItem.sequence || {};
                var pattern = String(seqData.pattern || seqItem.name || "");
                var frames = seqData.files || [];

                if (!frames.length) {
                    currentStep++;
                    reportProg("sequence");
                    nextSeq();
                    return;
                }

                /* Check all frames for existence and hash */
                var frameHashes = [];
                var frameErr = null;
                var frameIdx = 0;

                function nextFrame() {
                    if (cancelToken.cancelled) {
                        done(new Error("CANCELLED"), null);
                        return;
                    }

                    if (frameIdx >= frames.length) {
                        if (!frameErr) {
                            var combo = pattern + "\n" + frameHashes.join("\n");
                            var seqHash = crypto.createHash("sha256").update(combo).digest("hex");
                            seqResults.push({
                                seqItem: seqItem,
                                pattern: pattern,
                                contentId: seqHash,
                                framesCount: frames.length,
                                totalSize: frames.reduce(function (sum, f) { return sum + (Number(f.size) || 0); }, 0)
                            });
                        }
                        currentStep++;
                        reportProg("sequence");
                        nextSeq();
                        return;
                    }

                    var fr = frames[frameIdx++];
                    var frPath = api.normalizePath(fr.path || fr);
                    var cachedFr = cache.entries[frPath];

                    try {
                        var st = fs.statSync(nativePath(frPath));
                        if (cachedFr && cachedFr.size === st.size && cachedFr.mtimeMs === st.mtimeMs) {
                            frameHashes.push((fr.name || frPath) + ":" + st.size + ":" + cachedFr.sha256);
                            nextFrame();
                            return;
                        }

                        api.hashFile(frPath, { cancelToken: cancelToken }, function (errH, digestH) {
                            if (errH) {
                                frameErr = errH.message;
                            } else {
                                cache.entries[frPath] = { size: st.size, mtimeMs: st.mtimeMs, sha256: digestH };
                                cacheDirty = true;
                                frameHashes.push((fr.name || frPath) + ":" + st.size + ":" + digestH);
                            }
                            nextFrame();
                        });
                    } catch (eFrStat) {
                        frameErr = "Missing frame: " + frPath;
                        nextFrame();
                    }
                }

                nextFrame();
            }

            nextSeq();
        }

        /* Step 5: Group duplicates into final report */
        function buildFinalResult(seqResults) {
            var duplicateGroups = [];
            var gCounter = 1;

            /* Group files by (isProxy, sha256) */
            var hashGroups = {};
            for (var i = 0; i < filesToHash.length; i++) {
                var f = filesToHash[i];
                if (!f.sha256 || f.hashError) continue;
                var gKey = (f.isProxy ? "proxy:" : "orig:") + f.sha256;
                if (!hashGroups[gKey]) hashGroups[gKey] = [];
                hashGroups[gKey].push(f);
            }

            for (var hKey in hashGroups) {
                if (hashGroups.hasOwnProperty(hKey) && hashGroups[hKey].length > 1) {
                    var groupFiles = hashGroups[hKey].slice();
                    groupFiles.sort(api.rankCanonical);

                    var canonical = groupFiles[0];
                    var itemSize = canonical.size || 0;
                    var allRefs = [];
                    for (var r = 0; r < groupFiles.length; r++) {
                        allRefs = allRefs.concat(groupFiles[r].references);
                    }

                    duplicateGroups.push({
                        groupId: "group-" + (gCounter++),
                        kind: canonical.isProxy ? "proxy" : "file",
                        contentId: canonical.sha256,
                        size: itemSize,
                        files: groupFiles,
                        references: allRefs,
                        totalBytes: groupFiles.length * itemSize,
                        reclaimableBytes: (groupFiles.length - 1) * itemSize,
                        recommendedCanonical: canonical.path,
                        reasons: api.canonicalReasons(canonical)
                    });
                }
            }

            /* Group sequences by contentId */
            var seqGroups = {};
            for (var q = 0; q < seqResults.length; q++) {
                var sObj = seqResults[q];
                if (!seqGroups[sObj.contentId]) seqGroups[sObj.contentId] = [];
                seqGroups[sObj.contentId].push(sObj);
            }

            for (var sKey in seqGroups) {
                if (seqGroups.hasOwnProperty(sKey) && seqGroups[sKey].length > 1) {
                    var sList = seqGroups[sKey];
                    var seqSize = sList[0].totalSize || 0;

                    duplicateGroups.push({
                        groupId: "group-" + (gCounter++),
                        kind: "sequence",
                        contentId: sKey,
                        size: seqSize,
                        files: sList.map(function (s) {
                            return {
                                path: s.seqItem.path,
                                normalizedPath: api.normalizePath(s.seqItem.path),
                                name: s.seqItem.name,
                                isOwned: !!ownedPaths[api.normalizePath(s.seqItem.path)],
                                inWorkspace: workspaceRoot ? api.normalizePath(s.seqItem.path).indexOf(workspaceRoot + "/") === 0 : false,
                                isTemporaryRoute: false,
                                references: [String(s.seqItem.id || s.seqItem.name || "")]
                            };
                        }),
                        references: sList.map(function (s) { return String(s.seqItem.id || s.seqItem.name || ""); }),
                        totalBytes: sList.length * seqSize,
                        reclaimableBytes: (sList.length - 1) * seqSize,
                        recommendedCanonical: sList[0].seqItem.path,
                        reasons: ["Секвенция с совпадающим набором кадров и шаблоном"]
                    });
                }
            }

            var totalReclaimable = 0;
            for (var d = 0; d < duplicateGroups.length; d++) {
                totalReclaimable += duplicateGroups[d].reclaimableBytes;
            }

            var errors = [];
            for (var fi = 0; fi < fileList.length; fi++) {
                var ff = fileList[fi];
                if (ff.statError) {
                    errors.push({
                        path: ff.path,
                        code: "UNREADABLE",
                        message: ff.statError,
                        isProxy: ff.isProxy,
                        references: ff.references
                    });
                } else if (ff.hashError) {
                    errors.push({
                        path: ff.path,
                        code: "HASH_FAILED",
                        message: ff.hashError,
                        isProxy: ff.isProxy,
                        references: ff.references
                    });
                }
            }

            for (var mi = 0; mi < items.length; mi++) {
                var itm = items[mi];
                if (itm && (itm.state === "missing" || itm.missing === true || itm.offline === true)) {
                    errors.push({
                        path: itm.path || itm.name || ("item #" + itm.id),
                        code: "MISSING",
                        message: "Файл отсутствует на диске",
                        isProxy: !!itm.isProxy,
                        references: [String(itm.id || itm.name || "")]
                    });
                }
            }

            done(null, {
                ok: true,
                scannedFiles: fileList.length,
                hashedFiles: filesToHash.length,
                scannedSequences: sequences.length,
                duplicateGroups: duplicateGroups,
                errors: errors,
                reclaimableBytes: totalReclaimable
            });
        }

        processNextFile();
    };

    return api;
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = PardDuplicateIndex;
}
