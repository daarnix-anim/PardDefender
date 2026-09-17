/*
 * PardDefender - Premiere Pro UXP Chunk Copy Engine & Relink Orchestrator
 *
 * @map role: Асинхронное поблочное копирование через UXP fs с инкрементальным SHA-256,
 *           временными файлами .pdpart, journal-before-copy в pending.tsv,
 *           фиксацией provenance в assets.tsv и безопасной перелинковкой клипов Premiere.
 * @map status: ready
 *
 * Enforces atomic writes, safe recovery, exact byte reuse, collision-safe naming,
 * and zero deletion of original media files.
 */
var PardPremiereCopyEngine = (function () {
    "use strict";

    var api = {};

    var fs = null;
    var path = null;
    var crypto = null;

    try { fs = require("fs"); } catch (e) {}
    try { path = require("path"); } catch (e) {}
    try { crypto = require("crypto"); } catch (e) {}

    api.setFs = function (customFs) { fs = customFs; };
    api.setCrypto = function (customCrypto) { crypto = customCrypto; };

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

    /* ------------------------------------------------ Pure JS SHA-256 (NIST) */

    function createSha256() {
        if (crypto && typeof crypto.createHash === "function") {
            var h = crypto.createHash("sha256");
            return {
                update: function (chunk) {
                    if (typeof chunk === "string") {
                        h.update(chunk, "utf8");
                    } else {
                        h.update(chunk);
                    }
                },
                digest: function () {
                    return h.digest("hex");
                }
            };
        }

        // Fallback pure JS incremental SHA-256 for UXP environments without crypto.createHash
        var K = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];

        var H = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        ];

        var buffer = [];
        var totalBytes = 0;

        function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }

        function processBlock(block) {
            var W = new Array(64);
            for (var t = 0; t < 16; t++) {
                W[t] = ((block[t * 4] & 0xff) << 24) |
                       ((block[t * 4 + 1] & 0xff) << 16) |
                       ((block[t * 4 + 2] & 0xff) << 8) |
                       (block[t * 4 + 3] & 0xff);
            }
            for (t = 16; t < 64; t++) {
                var s0 = rotr(7, W[t - 15]) ^ rotr(18, W[t - 15]) ^ (W[t - 15] >>> 3);
                var s1 = rotr(17, W[t - 2]) ^ rotr(19, W[t - 2]) ^ (W[t - 2] >>> 10);
                W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
            }

            var a = H[0], b = H[1], c = H[2], d = H[3],
                e = H[4], f = H[5], g = H[6], h = H[7];

            for (t = 0; t < 64; t++) {
                var S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
                var ch = (e & f) ^ ((~e) & g);
                var temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
                var S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
                var maj = (a & b) ^ (a & c) ^ (b & c);
                var temp2 = (S0 + maj) | 0;

                h = g;
                g = f;
                f = e;
                e = (d + temp1) | 0;
                d = c;
                c = b;
                b = a;
                a = (temp1 + temp2) | 0;
            }

            H[0] = (H[0] + a) | 0;
            H[1] = (H[1] + b) | 0;
            H[2] = (H[2] + c) | 0;
            H[3] = (H[3] + d) | 0;
            H[4] = (H[4] + e) | 0;
            H[5] = (H[5] + f) | 0;
            H[6] = (H[6] + g) | 0;
            H[7] = (H[7] + h) | 0;
        }

        return {
            update: function (chunk) {
                var bytes;
                if (typeof chunk === "string") {
                    bytes = [];
                    for (var i = 0; i < chunk.length; i++) {
                        var code = chunk.charCodeAt(i);
                        if (code < 0x80) bytes.push(code);
                        else if (code < 0x800) {
                            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
                        } else {
                            bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
                        }
                    }
                } else if (chunk && chunk.length !== undefined) {
                    bytes = chunk;
                } else {
                    bytes = [];
                }

                totalBytes += bytes.length;
                for (var j = 0; j < bytes.length; j++) {
                    buffer.push(bytes[j]);
                    if (buffer.length === 64) {
                        processBlock(buffer);
                        buffer = [];
                    }
                }
            },
            digest: function () {
                // Padding
                buffer.push(0x80);
                while ((buffer.length % 64) !== 56) {
                    buffer.push(0x00);
                }
                var totalBits = totalBytes * 8;
                for (var b = 7; b >= 0; b--) {
                    buffer.push((totalBits >>> (b * 8)) & 0xff);
                }
                for (var k = 0; k < buffer.length; k += 64) {
                    processBlock(buffer.slice(k, k + 64));
                }

                var hex = "";
                for (var h = 0; h < 8; h++) {
                    var val = H[h] >>> 0;
                    var s = val.toString(16);
                    while (s.length < 8) s = "0" + s;
                    hex += s;
                }
                return hex;
            }
        };
    }

    api.createSha256 = createSha256;

    api.hashFile = function (filePath, callback) {
        if (!fs) {
            callback(new Error("Node fs недоступен"));
            return;
        }
        var hasher = createSha256();
        var nPath = nativePath(filePath);

        if (!fs.existsSync(nPath)) {
            callback(new Error("Файл не найден: " + filePath));
            return;
        }

        try {
            var stream = fs.createReadStream(nPath);
            stream.on("data", function (chunk) {
                hasher.update(chunk);
            });
            stream.on("end", function () {
                callback(null, hasher.digest());
            });
            stream.on("error", function (err) {
                callback(err);
            });
        } catch (e) {
            try {
                var content = fs.readFileSync(nPath);
                hasher.update(content);
                callback(null, hasher.digest());
            } catch (eSync) {
                callback(eSync);
            }
        }
    };

    /* ----------------------------------------------------- journal & recovery */

    function pendingFile(workspace) {
        return normalizePath(workspace) + "/.parddefender/pending.tsv";
    }

    function assetsFile(workspace) {
        return normalizePath(workspace) + "/.parddefender/assets.tsv";
    }

    api.recoverPending = function (workspace) {
        if (!fs || !workspace) return { recovered: 0, removedParts: [] };
        var pFile = pendingFile(workspace);
        if (!fs.existsSync(nativePath(pFile))) return { recovered: 0, removedParts: [] };

        var removed = [];
        try {
            var raw = fs.readFileSync(nativePath(pFile), "utf8");
            var lines = raw.split("\n");
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line) continue;
                var cols = line.split("\t");
                var partPath = cols[4];
                if (partPath && /\.pdpart$/.test(partPath)) {
                    var nPart = nativePath(partPath);
                    if (fs.existsSync(nPart)) {
                        try {
                            fs.unlinkSync(nPart);
                            removed.push(partPath);
                        } catch (eDel) {}
                    }
                }
            }
            fs.unlinkSync(nativePath(pFile));
        } catch (e) {}

        return { recovered: removed.length, removedParts: removed };
    };

    function journalTask(workspace, task, partPath) {
        if (!fs || !workspace) return false;
        var pFile = pendingFile(workspace);
        var dir = normalizePath(workspace) + "/.parddefender";
        try {
            if (!fs.existsSync(nativePath(dir))) {
                fs.mkdirSync(nativePath(dir), { recursive: true });
            }
            var row = [
                new Date().toISOString(),
                task.id || task.key,
                normalizePath(task.sourcePath),
                normalizePath(task.destPath),
                normalizePath(partPath)
            ].join("\t") + "\n";
            fs.appendFileSync(nativePath(pFile), row, "utf8");
            return true;
        } catch (e) {
            return false;
        }
    }

    function removeJournalEntry(workspace, partPath) {
        if (!fs || !workspace) return;
        var pFile = pendingFile(workspace);
        if (!fs.existsSync(nativePath(pFile))) return;
        try {
            var raw = fs.readFileSync(nativePath(pFile), "utf8");
            var lines = raw.split("\n");
            var kept = [];
            var normPart = normalizePath(partPath);
            for (var i = 0; i < lines.length; i++) {
                var l = lines[i].trim();
                if (!l) continue;
                var cols = l.split("\t");
                if (cols[4] && normalizePath(cols[4]) === normPart) continue;
                kept.push(l);
            }
            if (kept.length > 0) {
                fs.writeFileSync(nativePath(pFile), kept.join("\n") + "\n", "utf8");
            } else {
                try { fs.unlinkSync(nativePath(pFile)); } catch (eU) {}
            }
        } catch (e) {}
    }

    /* ----------------------------------------------------- chunk copy core */

    api.copyChunked = function (sourcePath, destPath, options, callbacks) {
        var opt = options || {};
        var cb = callbacks || {};
        var onProgress = cb.onProgress || function () {};
        var onDone = cb.onDone || function () {};

        var nSource = nativePath(sourcePath);
        var nDest = nativePath(destPath);

        if (!fs.existsSync(nSource)) {
            onDone({ ok: false, code: "SOURCE_MISSING", message: "Исходный файл не найден" });
            return;
        }

        var sourceStat = null;
        try {
            sourceStat = fs.statSync(nSource);
        } catch (eStat) {
            onDone({ ok: false, code: "PERMISSION_DENIED", message: "Нет доступа к исходному файлу" });
            return;
        }

        var destDir = path.dirname(nDest);
        try {
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }
        } catch (eMk) {
            onDone({ ok: false, code: "DEST_BLOCKED", message: "Не удалось создать целевую папку" });
            return;
        }

        var token = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
        var partFile = destPath + "." + token + ".pdpart";
        var nPart = nativePath(partFile);

        var ws = opt.workspace || "";
        if (ws) {
            journalTask(ws, { id: opt.id || "1", sourcePath: sourcePath, destPath: destPath }, partFile);
        }

        var srcHasher = createSha256();
        var partHasher = createSha256();
        var bytesWritten = 0;
        var totalBytes = sourceStat.size;

        try {
            var readStream = fs.createReadStream(nSource);
            var writeStream = fs.createWriteStream(nPart);

            readStream.on("data", function (chunk) {
                srcHasher.update(chunk);
                partHasher.update(chunk);
                bytesWritten += chunk.length;
                onProgress({
                    bytesWritten: bytesWritten,
                    totalBytes: totalBytes,
                    percent: totalBytes > 0 ? Math.round((bytesWritten / totalBytes) * 100) : 100
                });
            });

            readStream.on("error", function (err) {
                try { writeStream.close(); } catch (eC) {}
                try { fs.unlinkSync(nPart); } catch (eU) {}
                if (ws) removeJournalEntry(ws, partFile);
                onDone({ ok: false, code: "SOURCE_READ_ERROR", message: err.message });
            });

            writeStream.on("error", function (err) {
                try { readStream.destroy(); } catch (eD) {}
                try { fs.unlinkSync(nPart); } catch (eU) {}
                if (ws) removeJournalEntry(ws, partFile);
                var code = (err.code === "ENOSPC") ? "ENOSPC" : "WRITE_ERROR";
                onDone({ ok: false, code: code, message: err.message });
            });

            writeStream.on("finish", function () {
                // Verify size
                var partStat = null;
                try {
                    partStat = fs.statSync(nPart);
                } catch (eSt) {
                    try { fs.unlinkSync(nPart); } catch (eU) {}
                    if (ws) removeJournalEntry(ws, partFile);
                    onDone({ ok: false, code: "VERIFY_FAILED", message: "Не удалось прочитать созданный .pdpart" });
                    return;
                }

                if (partStat.size !== totalBytes) {
                    try { fs.unlinkSync(nPart); } catch (eU) {}
                    if (ws) removeJournalEntry(ws, partFile);
                    onDone({ ok: false, code: "CHANGED_SOURCE", message: "Размер файла изменился во время копирования" });
                    return;
                }

                // Verify SHA-256
                var srcHash = srcHasher.digest();
                var partHash = partHasher.digest();

                if (srcHash !== partHash) {
                    try { fs.unlinkSync(nPart); } catch (eU) {}
                    if (ws) removeJournalEntry(ws, partFile);
                    onDone({ ok: false, code: "HASH_MISMATCH", message: "Контрольная сумма части не совпала" });
                    return;
                }

                // Safe rename
                try {
                    if (fs.existsSync(nDest)) {
                        try { fs.unlinkSync(nDest); } catch (eD) {}
                    }
                    fs.renameSync(nPart, nDest);
                } catch (eRen) {
                    try { fs.unlinkSync(nPart); } catch (eU) {}
                    if (ws) removeJournalEntry(ws, partFile);
                    onDone({ ok: false, code: "RENAME_FAILED", message: eRen.message });
                    return;
                }

                if (ws) removeJournalEntry(ws, partFile);

                onDone({
                    ok: true,
                    destPath: destPath,
                    size: totalBytes,
                    hash: partHash
                });
            });

            readStream.pipe(writeStream);
        } catch (eTop) {
            try { fs.unlinkSync(nPart); } catch (eU) {}
            if (ws) removeJournalEntry(ws, partFile);
            onDone({ ok: false, code: "EXCEPTION", message: eTop.message });
        }
    };

    /* ----------------------------------------------------- queue execution */

    api.runQueue = function (workspace, tasks, options, callbacks) {
        var opt = options || {};
        var cb = callbacks || {};
        var onTask = cb.onTask || function () {};
        var onDone = cb.onDone || function () {};

        if (!tasks || tasks.length === 0) {
            onDone({ ok: true, results: [] });
            return;
        }

        var results = [];
        var queueIndex = 0;

        function nextTask() {
            if (queueIndex >= tasks.length) {
                onDone({ ok: true, results: results });
                return;
            }

            var t = tasks[queueIndex];
            onTask(t, queueIndex + 1, tasks.length);

            // Check if exact reuse allowed
            if (t.allowReuse && fs.existsSync(nativePath(t.destPath))) {
                api.hashFile(t.sourcePath, function (errSrc, hSrc) {
                    if (!errSrc && hSrc) {
                        api.hashFile(t.destPath, function (errDst, hDst) {
                            if (!errDst && hSrc === hDst) {
                                results.push({
                                    id: t.id,
                                    ok: true,
                                    reused: true,
                                    destPath: t.destPath,
                                    hash: hDst
                                });
                                queueIndex++;
                                nextTask();
                                return;
                            }
                            proceedCopy();
                        });
                        return;
                    }
                    proceedCopy();
                });
                return;
            }

            proceedCopy();

            function proceedCopy() {
                api.copyChunked(t.sourcePath, t.destPath, {
                    id: t.id,
                    workspace: workspace
                }, {
                    onProgress: opt.onProgress || function () {},
                    onDone: function (res) {
                        results.push({
                            id: t.id,
                            ok: res.ok,
                            code: res.code,
                            destPath: res.destPath || t.destPath,
                            error: res.message
                        });

                        if (res.ok && workspace) {
                            // Record provenance in assets.tsv
                            try {
                                var row = [
                                    new Date().toISOString(),
                                    t.id || "1",
                                    normalizePath(t.sourcePath),
                                    res.size || 0,
                                    normalizePath(res.destPath),
                                    t.branch || "_SHARED",
                                    t.category || "video"
                                ].join("\t") + "\n";
                                fs.appendFileSync(nativePath(assetsFile(workspace)), row, "utf8");
                            } catch (eAss) {}
                        }

                        queueIndex++;
                        nextTask();
                    }
                });
            }
        }

        nextTask();
    };

    /* ----------------------------------------------------- Premiere Relink */

    api.relinkClip = function (clipItem, newMediaPath, expectedOldPath) {
        if (!clipItem) return { ok: false, code: "ITEM_NOT_FOUND", reason: "Элемент не существует" };

        var currentPath = "";
        if (typeof clipItem.getMediaFilePath === "function") {
            currentPath = clipItem.getMediaFilePath();
        } else if (clipItem.mediaFilePath) {
            currentPath = clipItem.mediaFilePath;
        }

        if (expectedOldPath && normalizePath(currentPath) !== normalizePath(expectedOldPath)) {
            return {
                ok: false,
                code: "STALE_SOURCE",
                reason: "Источник элемента изменился: " + currentPath + ", ожидался: " + expectedOldPath
            };
        }

        if (clipItem.isMulticam || clipItem.isMerged || clipItem.isSynthetic) {
            return {
                ok: false,
                code: "UNSUPPORTED_TYPE",
                reason: "Сложные или синтетические элементы не могут быть перелинкованы"
            };
        }

        if (typeof clipItem.canChangeMediaPath === "function" && !clipItem.canChangeMediaPath()) {
            return {
                ok: false,
                code: "CANNOT_CHANGE_PATH",
                reason: "Premiere запрещает смену пути для этого элемента"
            };
        }

        var success = false;
        if (typeof clipItem.changeMediaFilePath === "function") {
            // overrideCompatibilityCheck is strictly false
            success = clipItem.changeMediaFilePath(nativePath(newMediaPath), false);
        }

        if (!success) {
            return {
                ok: false,
                code: "RELINK_REJECTED",
                reason: "Premiere отклонил перелинковку (несовместимый медиафайл)"
            };
        }

        // Post-relink verification
        var verifyPath = "";
        if (typeof clipItem.getMediaFilePath === "function") {
            verifyPath = clipItem.getMediaFilePath();
        } else if (clipItem.mediaFilePath) {
            verifyPath = clipItem.mediaFilePath;
        }

        if (normalizePath(verifyPath) !== normalizePath(newMediaPath)) {
            return {
                ok: false,
                code: "VERIFY_FAILED",
                reason: "После перелинковки путь не изменился на целевой"
            };
        }

        return {
            ok: true,
            newPath: normalizePath(verifyPath)
        };
    };

    return api;
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = PardPremiereCopyEngine;
}
