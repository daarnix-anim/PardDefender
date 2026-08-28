/*
 * PardDefender - the verified copy layer.
 *
 * Everything here runs in the CEP/Node process, never in ExtendScript. The
 * rules that matter:
 *
 *   - One file at a time. A parallel batch on a spinning disk or a cloud-synced
 *     folder is slower, not faster, and it makes failure much harder to undo.
 *   - Every write goes to a uniquely named .pdpart file beside its destination,
 *     is size-verified, and only then renamed into place. A half-written file
 *     can therefore never be relinked.
 *   - Every plan is journalled before the first byte is written. A crash leaves
 *     a record the next panel start can roll back.
 *   - The original is never deleted, moved or modified. Ever.
 */
var PardCopyQueue = (function () {
    var api = {};

    var fs = null, path = null, crypto = null;
    try { fs = require("fs"); } catch (e) {}
    try { path = require("path"); } catch (e2) {}
    try { crypto = require("crypto"); } catch (e3) {}

    api.available = function () { return !!(fs && path && crypto); };

    /* Above this size a byte-for-byte hash costs more than it is worth; such a
     * file is given a fresh name instead of being deduplicated. */
    var HASH_LIMIT_BYTES = 1073741824;

    /* No progress for this long means the source is not going to deliver. */
    var DEFAULT_STALL_MS = 60000;

    api.DEFAULT_STALL_MS = DEFAULT_STALL_MS;

    /*
     * Maps a Node errno onto the vocabulary the issue store reasons about.
     * Everything downstream - retry schedule, wording, whether the owner has to
     * do something - keys off the code, never off the message text, so a Node
     * version that rewords an error cannot change PardDefender's behaviour.
     */
    function codeForError(error, fallback) {
        var errno = error && error.code ? String(error.code) : "";
        switch (errno) {
        case "ENOENT": return "SOURCE_MISSING";
        case "EACCES":
        case "EPERM": return "ACCESS_DENIED";
        case "EBUSY":
        case "ETXTBSY": return "SOURCE_BUSY";
        case "ENOSPC": return "DISK_FULL";
        case "EIO":
        case "EHOSTDOWN":
        case "ENETDOWN":
        case "ENODEV": return "SOURCE_STALLED";
        case "EROFS": return "DEST_UNWRITABLE";
        case "EMFILE":
        case "ENFILE": return "TOO_MANY_FILES";
        case "EISDIR":
        case "ENOTDIR": return "PATH_INVALID";
        case "ENAMETOOLONG": return "PATH_TOO_LONG";
        default: return fallback || "COPY_FAILED";
        }
    }

    api.codeForError = codeForError;

    function toNative(p) { return String(p || "").replace(/\//g, path.sep); }
    function toSlash(p) { return String(p || "").replace(/\\/g, "/"); }

    api.toSlash = toSlash;

    function statOf(target) {
        try { return fs.statSync(toNative(target)); } catch (e) { return null; }
    }

    api.statOf = statOf;

    api.exists = function (target) { return statOf(target) !== null; };

    function ensureDir(dir) {
        var native = toNative(dir);
        try {
            fs.mkdirSync(native, { recursive: true });
            return true;
        } catch (e) {
            /* Older Node in some CEP builds has no recursive mkdir. */
            var parts = toSlash(dir).split("/"), current = "", i;
            for (i = 0; i < parts.length; i++) {
                current = current ? current + "/" + parts[i] : parts[i];
                if (!current || /^[A-Za-z]:$/.test(current)) continue;
                try { fs.mkdirSync(toNative(current)); } catch (e2) {}
            }
            return statOf(dir) !== null;
        }
    }

    api.ensureDir = ensureDir;

    function escapeRegExp(value) {
        return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    /*
     * Rebuilds the member list of an image sequence from the numbering pattern
     * the host reported. Enumerating here rather than in ExtendScript keeps a
     * 2000-frame sequence off the single-threaded host.
     */
    api.expandSequence = function (descriptor) {
        if (!descriptor || !descriptor.folder) return [];
        var pattern = new RegExp(
            "^" + escapeRegExp(descriptor.prefix) +
            "\\d{" + Math.max(1, Number(descriptor.padding) || 1) + "}" +
            escapeRegExp(descriptor.suffix) + "$",
            "i"
        );
        var names;
        try { names = fs.readdirSync(toNative(descriptor.folder)); }
        catch (e) { return []; }

        var out = [], i;
        for (i = 0; i < names.length; i++) {
            if (pattern.test(names[i])) out.push(toSlash(descriptor.folder) + "/" + names[i]);
        }
        out.sort();
        return out;
    };

    api.hashFile = function (target, callback) {
        var stats = statOf(target);
        if (!stats) { callback(null); return; }
        if (stats.size > HASH_LIMIT_BYTES) { callback(null); return; }

        var hash, stream;
        try {
            hash = crypto.createHash("sha256");
            stream = fs.createReadStream(toNative(target));
        } catch (e) { callback(null); return; }

        stream.on("error", function () { callback(null); });
        stream.on("data", function (chunk) {
            try { hash.update(chunk); } catch (e2) {}
        });
        stream.on("end", function () {
            var digest = null;
            try { digest = hash.digest("hex"); } catch (e3) { digest = null; }
            callback(digest);
        });
    };

    /*
     * A destination that already holds identical bytes is reused rather than
     * duplicated - that is what keeps a re-imported logo from becoming
     * "logo (2).png", "logo (3).png" across a long project.
     */
    function resolveDestination(sourcePath, destPath, callback) {
        var sourceStats = statOf(sourcePath);
        if (!sourceStats) {
            callback({
                action: "error",
                code: "SOURCE_MISSING",
                reason: "Исходник не читается."
            });
            return;
        }

        var existing = statOf(destPath);
        if (!existing) { callback({ action: "copy", destPath: destPath }); return; }

        if (existing.size === sourceStats.size) {
            api.hashFile(sourcePath, function (sourceHash) {
                if (!sourceHash) { callback({ action: "rename", destPath: uniqueName(destPath) }); return; }
                api.hashFile(destPath, function (destHash) {
                    if (destHash && destHash === sourceHash) {
                        callback({
                            action: "reuse",
                            destPath: destPath,
                            hash: destHash,
                            bytes: existing.size
                        });
                        return;
                    }
                    callback({ action: "rename", destPath: uniqueName(destPath) });
                });
            });
            return;
        }

        callback({ action: "rename", destPath: uniqueName(destPath) });
    }

    function uniqueName(destPath) {
        var p = toSlash(destPath);
        var dot = p.lastIndexOf(".");
        var slash = p.lastIndexOf("/");
        var stem = dot > slash ? p.substring(0, dot) : p;
        var ext = dot > slash ? p.substring(dot) : "";
        var counter = 2, candidate;
        while (counter < 1000) {
            candidate = stem + " (" + counter + ")" + ext;
            if (!statOf(candidate)) return candidate;
            counter++;
        }
        return stem + " (" + Date.now() + ")" + ext;
    }

    function partialNameFor(destPath) {
        return toSlash(destPath) + "." +
            Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36) +
            ".pdpart";
    }

    api.partialNameFor = partialNameFor;

    function removeQuietly(target) {
        try { fs.unlinkSync(toNative(target)); return true; } catch (e) { return false; }
    }

    api.removeQuietly = removeQuietly;

    /*
     * Copies one file and verifies it. The destination is only ever created by
     * the final rename, so an interrupted copy leaves a .pdpart and nothing the
     * project could be relinked to.
     */
    function copyOne(sourcePath, destPath, stallMs, onDone) {
        var sourceStats = statOf(sourcePath);
        if (!sourceStats) {
            onDone({
                ok: false,
                code: "SOURCE_MISSING",
                reason: "Исходник исчез до начала копирования."
            });
            return;
        }
        if (!ensureDir(toSlash(destPath).replace(/\/[^\/]*$/, ""))) {
            onDone({
                ok: false,
                code: "DEST_UNWRITABLE",
                reason: "Не удалось создать папку назначения."
            });
            return;
        }

        var partial = partialNameFor(destPath);
        var settled = false;

        function finish(result) {
            if (settled) return;
            settled = true;
            onDone(result);
        }

        var readStream, writeStream, stallTimer = null;
        var written = 0, lastProgress = 0, lastCheckedAt = Date.now();

        function stopStall() {
            if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
        }

        function abort(code, reason) {
            stopStall();
            try { readStream.destroy(); } catch (e1) {}
            try { writeStream.destroy(); } catch (e2) {}
            removeQuietly(partial);
            finish({ ok: false, code: code, reason: reason });
        }

        try {
            readStream = fs.createReadStream(toNative(sourcePath));
            writeStream = fs.createWriteStream(toNative(partial));
        } catch (e) {
            removeQuietly(partial);
            finish({
                ok: false,
                code: codeForError(e, "COPY_FAILED"),
                reason: "Не удалось открыть поток копирования: " + e
            });
            return;
        }

        /*
         * A cloud placeholder that has not been downloaded, a sleeping external
         * drive or a dropped network share all present the same way: the stream
         * opens, reports no error, and then simply stops delivering bytes.
         * Detecting an absence of progress covers all three without having to
         * interrogate file attributes, which are unreliable across cloud clients.
         */
        if (stallMs > 0) {
            stallTimer = setInterval(function () {
                if (written !== lastProgress) {
                    lastProgress = written;
                    lastCheckedAt = Date.now();
                    return;
                }
                if (Date.now() - lastCheckedAt >= stallMs) {
                    abort("SOURCE_STALLED",
                        "Источник не отдаёт данные — возможно, файл не скачан из облака " +
                        "или диск недоступен.");
                }
            }, Math.max(1000, Math.min(stallMs, 5000)));
        }

        readStream.on("data", function (chunk) {
            written += chunk.length;
        });

        readStream.on("error", function (error) {
            abort(codeForError(error, "SOURCE_UNREADABLE"), "Чтение не удалось: " + error);
        });

        writeStream.on("error", function (error) {
            abort(codeForError(error, "DEST_UNWRITABLE"), "Запись не удалась: " + error);
        });

        writeStream.on("close", function () {
            stopStall();
            if (settled) return;
            var stats = statOf(partial);
            if (!stats || stats.size !== sourceStats.size) {
                removeQuietly(partial);
                finish({
                    ok: false,
                    code: "SIZE_MISMATCH",
                    reason: "Размер копии не совпал с исходником (" +
                        (stats ? stats.size : 0) + " из " + sourceStats.size + " байт)."
                });
                return;
            }
            try {
                fs.renameSync(toNative(partial), toNative(destPath));
            } catch (renameError) {
                removeQuietly(partial);
                finish({
                    ok: false,
                    code: codeForError(renameError, "DEST_UNWRITABLE"),
                    reason: "Проверенную копию не удалось поставить на место: " + renameError
                });
                return;
            }
            /* Keep the original timestamp so the copy stays recognisable as the
             * same asset in Explorer and in later dedup passes. */
            try { fs.utimesSync(toNative(destPath), sourceStats.atime, sourceStats.mtime); }
            catch (timeError) {}
            finish({ ok: true, destPath: destPath, bytes: sourceStats.size });
        });

        readStream.pipe(writeStream);
    }

    api.copyOne = copyOne;

    /*
     * Runs one task: a single file, or every member of an image sequence.
     * A sequence is all-or-nothing - a partially copied sequence would render
     * with holes in it, which is worse than not protecting it at all.
     */
    function runTask(task, options, hooks, done) {
        var sources = task.isSequence && task.sequence
            ? api.expandSequence(task.sequence)
            : [task.sourcePath];

        if (!sources.length) {
            done({
                ok: false,
                id: task.id,
                code: task.isSequence ? "SEQUENCE_EMPTY" : "SOURCE_MISSING",
                reason: "Не найдено ни одного файла-исходника."
            });
            return;
        }

        var stallMs = options && options.stallMs !== undefined
            ? Number(options.stallMs)
            : DEFAULT_STALL_MS;

        var destFolder = task.isSequence
            ? toSlash(task.destPath)
            : toSlash(task.destPath).replace(/\/[^\/]*$/, "");

        var created = [], index = 0, firstDest = "";
        var copiedBytes = 0, copiedFiles = 0, reusedFiles = 0, reusedBytes = 0;

        /*
         * A sequence is all-or-nothing, so a failure removes every frame this
         * task created. Frames that were REUSED are never removed - they were
         * already there and belong to whoever put them there.
         */
        function fail(code, reason) {
            var i;
            for (i = 0; i < created.length; i++) removeQuietly(created[i]);
            done({
                ok: false,
                id: task.id,
                code: code || "COPY_FAILED",
                reason: reason,
                rolledBack: created.length
            });
        }

        function next() {
            if (index >= sources.length) {
                done({
                    ok: true,
                    id: task.id,
                    destPath: firstDest,
                    files: copiedFiles,
                    bytes: copiedBytes,
                    reusedFiles: reusedFiles,
                    reusedBytes: reusedBytes
                });
                return;
            }

            var source = sources[index++];
            var leaf = toSlash(source).replace(/^.*\//, "");
            var target = task.isSequence ? destFolder + "/" + leaf : toSlash(task.destPath);

            resolveDestination(source, target, function (decision) {
                if (decision.action === "error") {
                    fail(decision.code || "SOURCE_UNREADABLE", decision.reason);
                    return;
                }

                if (decision.action === "reuse") {
                    if (!firstDest) firstDest = decision.destPath;
                    reusedFiles++;
                    reusedBytes += decision.bytes || 0;
                    if (hooks && hooks.onFile) {
                        hooks.onFile(task, leaf, index, sources.length, "reuse");
                    }
                    next();
                    return;
                }

                var finalTarget = decision.destPath;
                if (hooks && hooks.onFile) {
                    hooks.onFile(task, leaf, index, sources.length, "copy");
                }

                copyOne(source, finalTarget, stallMs, function (result) {
                    if (!result.ok) { fail(result.code, result.reason); return; }
                    created.push(finalTarget);
                    copiedBytes += result.bytes;
                    copiedFiles++;
                    if (!firstDest) firstDest = finalTarget;
                    next();
                });
            });
        }

        if (task.isSequence && !ensureDir(destFolder)) {
            fail("DEST_UNWRITABLE", "Не удалось создать папку секвенции: " + destFolder);
            return;
        }
        next();
    }

    /*
     * Processes the whole queue strictly in order and reports each outcome.
     * `budgetBytes` is checked per task rather than up front, so a queue that is
     * too large overall still protects everything that does fit.
     */
    api.run = function (tasks, options, hooks, done) {
        var results = [], index = 0;
        var reserve = Number(options && options.reserveBytes) || 0;
        var freeBytes = Number(options && options.freeBytes) || 0;

        function next() {
            if (index >= tasks.length) { done(results); return; }
            var task = tasks[index++];

            var needed = Number(task.size) || 0;
            if (freeBytes > 0 && needed + reserve > freeBytes) {
                results.push({
                    ok: false,
                    id: task.id,
                    code: "DISK_FULL",
                    reason: "Не хватает свободного места с учётом резерва."
                });
                next();
                return;
            }

            if (hooks && hooks.onTask) hooks.onTask(task, index, tasks.length);

            runTask(task, options || {}, hooks, function (result) {
                results.push(result);
                if (result.ok) freeBytes = Math.max(0, freeBytes - (result.bytes || 0));
                if (hooks && hooks.onResult) hooks.onResult(task, result);
                next();
            });
        }

        next();
    };

    /* --------------------------------------------------------- journalling */

    api.readText = function (target) {
        try { return fs.readFileSync(toNative(target), "utf8"); } catch (e) { return null; }
    };

    api.writeText = function (target, content) {
        try {
            ensureDir(toSlash(target).replace(/\/[^\/]*$/, ""));
            fs.writeFileSync(toNative(target), String(content), "utf8");
            return true;
        } catch (e) { return false; }
    };

    api.appendText = function (target, content) {
        try {
            ensureDir(toSlash(target).replace(/\/[^\/]*$/, ""));
            fs.appendFileSync(toNative(target), String(content), "utf8");
            return true;
        } catch (e) { return false; }
    };

    /*
     * Rolls back whatever a previous session left behind. Only .pdpart files are
     * removed: an unexpected file at a destination is left in place and reported,
     * because deleting something we did not certainly write is the one mistake
     * this whole design exists to avoid.
     */
    api.recoverJournal = function (journalPath) {
        var raw = api.readText(journalPath);
        var summary = { removedPartials: 0, folders: 0 };
        if (!raw) return summary;

        var seen = {}, lines = raw.split(/\r?\n/), i, fields, folder;
        for (i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            fields = lines[i].split("\t");
            /* ts, id, sourcePath, destPath - the destination folder is what we
             * need; the partial file inside it carries a random name. */
            if (fields.length < 4) continue;
            folder = toSlash(fields[3]).replace(/\/[^\/]*$/, "");
            if (!folder || seen[folder.toLowerCase()]) continue;
            seen[folder.toLowerCase()] = true;
            summary.folders++;

            var names;
            try { names = fs.readdirSync(toNative(folder)); } catch (e) { continue; }
            var j;
            for (j = 0; j < names.length; j++) {
                if (!/\.pdpart$/i.test(names[j])) continue;
                if (removeQuietly(folder + "/" + names[j])) summary.removedPartials++;
            }
        }
        removeQuietly(journalPath);
        return summary;
    };

    return api;
})();
