/*
 * PardDefender - the verified copy layer.
 *
 * @map role: Проверенное копирование: потоковая запись в .pdpart, сверка
 *           размера, дедуп по SHA-256, откат и коды ошибок. Оригинал не
 *           трогается никогда.
 * @map status: ready
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
    function codeForError(error, fallback, side) {
        var errno = error && error.code ? String(error.code) : "";
        /*
         * The same errno means opposite things on the two sides. ENOENT while
         * reading is a missing source; ENOENT while WRITING means the
         * destination folder is not there - and reporting that as "исходник не
         * найден" sent the owner looking for a file that was never lost.
         */
        if (errno === "ENOENT" && side === "dest") return "DEST_UNWRITABLE";
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

    /*
     * Returns { ok, code, blockedBy }. It must never answer "yes" for a path
     * that exists but is a FILE.
     *
     * Found on a live project 2026-08-29: 1.0.0 had written media as a file
     * literally called "VIDEO" (no extension), exactly where 1.0.1 then needed
     * the VIDEO folder. mkdirSync throws EEXIST, the per-segment fallback
     * swallows it, and the old `statOf(dir) !== null` check was happy - a file
     * stats just fine. The copy then died with ENOENT on the write, and because
     * ENOENT was read as a source problem the owner was told the исходник was
     * missing while it sat there perfectly readable.
     */
    function ensureDir(dir) {
        var native = toNative(dir);
        var existing = statOf(dir);

        if (existing) {
            if (existing.isDirectory()) return { ok: true };
            return { ok: false, code: "DEST_BLOCKED", blockedBy: toSlash(dir) };
        }

        try {
            fs.mkdirSync(native, { recursive: true });
        } catch (e) {
            /* Older Node in some CEP builds has no recursive mkdir. Walk down
             * and stop at the first segment that is occupied by a file. */
            var parts = toSlash(dir).split("/"), current = "", i, segment;
            for (i = 0; i < parts.length; i++) {
                current = current ? current + "/" + parts[i] : parts[i];
                if (!current || /^[A-Za-z]:$/.test(current)) continue;
                segment = statOf(current);
                if (segment && !segment.isDirectory()) {
                    return { ok: false, code: "DEST_BLOCKED", blockedBy: current };
                }
                if (segment) continue;
                try { fs.mkdirSync(toNative(current)); } catch (e2) {}
            }
        }

        var made = statOf(dir);
        if (made && made.isDirectory()) return { ok: true };
        if (made) return { ok: false, code: "DEST_BLOCKED", blockedBy: toSlash(dir) };
        return { ok: false, code: "DEST_UNWRITABLE" };
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
    function resolveDestination(sourcePath, destPath, allowReuse, callback) {
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
                    if (allowReuse && destHash && destHash === sourceHash) {
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

    function uniqueFolderName(folderPath) {
        var base = toSlash(folderPath).replace(/\/$/, "");
        var counter = 2, candidate;
        while (counter < 1000) {
            candidate = base + " (" + counter + ")";
            if (!statOf(candidate)) return candidate;
            counter++;
        }
        return base + " (" + Date.now() + ")";
    }

    /*
     * A sequence must keep one coherent filename pattern. Resolving collisions
     * frame by frame can produce shot_00002 (2).png while After Effects keeps
     * reading shot_00002.png from the pattern selected by the first frame.
     * Decide once for the whole folder: reuse a fully compatible folder only
     * when the manifest already says it is ours, otherwise use a fresh sibling.
     */
    function sequenceFolderFor(sources, preferred, descriptor, allowReuse, callback) {
        var existingFolder = statOf(preferred);
        if (!existingFolder) { callback(preferred); return; }
        if (!existingFolder.isDirectory()) { callback(preferred); return; }
        if (!allowReuse) { callback(uniqueFolderName(preferred)); return; }

        var expected = {}, names, n;
        for (n = 0; n < sources.length; n++) {
            expected[toSlash(sources[n]).replace(/^.*\//, "").toLowerCase()] = true;
        }
        try { names = fs.readdirSync(toNative(preferred)); }
        catch (readError) { callback(uniqueFolderName(preferred)); return; }
        var memberPattern = new RegExp(
            "^" + escapeRegExp(descriptor.prefix) +
            "\\d{" + Math.max(1, Number(descriptor.padding) || 1) + "}" +
            escapeRegExp(descriptor.suffix) + "$", "i");
        for (n = 0; n < names.length; n++) {
            if (memberPattern.test(names[n]) && !expected[names[n].toLowerCase()]) {
                callback(uniqueFolderName(preferred));
                return;
            }
        }

        var index = 0;
        function next() {
            if (index >= sources.length) { callback(preferred); return; }
            var source = sources[index++];
            var leaf = toSlash(source).replace(/^.*\//, "");
            var target = toSlash(preferred) + "/" + leaf;
            var sourceStats = statOf(source), targetStats = statOf(target);
            if (!targetStats) { next(); return; }
            if (!sourceStats || !targetStats.isFile() ||
                targetStats.size !== sourceStats.size) {
                callback(uniqueFolderName(preferred));
                return;
            }
            api.hashFile(source, function (sourceHash) {
                if (!sourceHash) { callback(uniqueFolderName(preferred)); return; }
                api.hashFile(target, function (targetHash) {
                    if (!targetHash || targetHash !== sourceHash) {
                        callback(uniqueFolderName(preferred));
                        return;
                    }
                    next();
                });
            });
        }
        next();
    }

    /*
     * Имя журнала. Своё у каждого хоста, и это не косметика.
     *
     * До 2.3.5 After Effects и Premiere писали в ОДИН <workspace>/.parddefender/
     * pending.tsv, при несовместимых форматах (4 колонки против 5) и
     * несовместимых процедурах восстановления. AE писал файл целиком через
     * writeText, то есть началом своего прохода стирал журнал незавершённого
     * копирования Premiere; восстановление каждого из них удаляло файл целиком,
     * выбрасывая строки другого.
     */
    var JOURNAL_NAME = "pending-ae.tsv";
    var LEGACY_JOURNAL_NAME = "pending.tsv";

    api.JOURNAL_NAME = JOURNAL_NAME;
    api.LEGACY_JOURNAL_NAME = LEGACY_JOURNAL_NAME;

    api.journalPath = function (metaDir) {
        return toSlash(metaDir).replace(/\/$/, "") + "/" + JOURNAL_NAME;
    };

    api.legacyJournalPath = function (metaDir) {
        return toSlash(metaDir).replace(/\/$/, "") + "/" + LEGACY_JOURNAL_NAME;
    };

    function newPartToken() {
        return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    }

    api.newPartToken = newPartToken;

    /*
     * Токен задачи попадает И в имя .pdpart, И в журнал. Это единственное, что
     * позволяет откату удалить ровно свои недописанные файлы.
     *
     * Раньше имя было случайным и нигде не записывалось, поэтому восстановление
     * сносило ВСЕ .pdpart в папке назначения — включая тот, в который Premiere
     * (или вторая копия AE) писал прямо в этот момент. Для секвенции токен один
     * на все кадры: задача одна, и откатывается она целиком.
     */
    function partialNameFor(destPath, token) {
        return toSlash(destPath) + "." + (token || newPartToken()) + ".pdpart";
    }

    api.partialNameFor = partialNameFor;

    function partialSuffixFor(token) {
        return "." + token + ".pdpart";
    }

    function removeQuietly(target) {
        try { fs.unlinkSync(toNative(target)); return true; } catch (e) { return false; }
    }

    api.removeQuietly = removeQuietly;

    /*
     * Copies one file and verifies it. The destination is only ever created by
     * the final rename, so an interrupted copy leaves a .pdpart and nothing the
     * project could be relinked to.
     */
    function copyOne(sourcePath, destPath, stallMs, onDone, partToken) {
        var sourceStats = statOf(sourcePath);
        if (!sourceStats) {
            onDone({
                ok: false,
                code: "SOURCE_MISSING",
                reason: "Исходник исчез до начала копирования."
            });
            return;
        }
        var folder = ensureDir(toSlash(destPath).replace(/\/[^\/]*$/, ""));
        if (!folder.ok) {
            onDone({
                ok: false,
                code: folder.code,
                reason: folder.code === "DEST_BLOCKED"
                    ? "На месте папки лежит файл: " + folder.blockedBy
                    : "Не удалось создать папку назначения."
            });
            return;
        }

        var partial = partialNameFor(destPath, partToken);
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
            abort(codeForError(error, "SOURCE_UNREADABLE", "source"), "Чтение не удалось: " + error);
        });

        writeStream.on("error", function (error) {
            abort(codeForError(error, "DEST_UNWRITABLE", "dest"), "Запись не удалась: " + error);
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
                    code: codeForError(renameError, "DEST_UNWRITABLE", "dest"),
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

        /*
         * One element can produce two tasks - itself and its proxy - so the
         * element id is no longer unique. Results echo the caller's key, and
         * fall back to the id for callers that never set one.
         */
        var taskKey = task.key || task.id;

        /*
         * Один токен на задачу: он попадает в имя каждого .pdpart этой задачи и
         * в её строку журнала, так что откат находит ровно свои недописанные
         * файлы. Журнал пишет клиент, поэтому обычно токен уже задан; значение
         * по умолчанию нужно вызовам в обход журнала (например копированию
         * каноникала в consolidation.js).
         */
        var partToken = task.partToken || newPartToken();

        if (!sources.length) {
            done({
                ok: false,
                key: taskKey,
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
        var records = [];

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
                key: taskKey,
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
                    key: taskKey,
                    id: task.id,
                    destPath: firstDest,
                    files: copiedFiles,
                    bytes: copiedBytes,
                    reusedFiles: reusedFiles,
                    reusedBytes: reusedBytes,
                    records: records,
                    /*
                     * Exactly which files were read. The legacy pass needs this:
                     * it may only send a leftover to the Recycle Bin if that
                     * precise file is the one just copied and verified.
                     */
                    sources: sources
                });
                return;
            }

            var source = sources[index++];
            var leaf = toSlash(source).replace(/^.*\//, "");
            var target = task.isSequence ? destFolder + "/" + leaf : toSlash(task.destPath);

            resolveDestination(source, target, task.allowReuse === true, function (decision) {
                if (decision.action === "error") {
                    fail(decision.code || "SOURCE_UNREADABLE", decision.reason);
                    return;
                }

                if (decision.action === "reuse") {
                    if (!firstDest) firstDest = decision.destPath;
                    reusedFiles++;
                    reusedBytes += decision.bytes || 0;
                    records.push({
                        sourcePath: source,
                        destPath: decision.destPath,
                        size: decision.bytes || 0,
                        created: false
                    });
                    if (hooks && hooks.onFile) {
                        hooks.onFile(task, leaf, index, sources.length, "reuse");
                    }
                    next();
                    return;
                }

                if (task.isSequence && decision.action === "rename") {
                    fail("SEQUENCE_DEST_CHANGED",
                        "Папка секвенции изменилась во время копирования; проход будет повторён.");
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
                    records.push({
                        sourcePath: source,
                        destPath: finalTarget,
                        size: result.bytes || 0,
                        created: true
                    });
                    if (!firstDest) firstDest = finalTarget;
                    next();
                }, partToken);
            });
        }

        if (!task.isSequence) { next(); return; }

        sequenceFolderFor(sources, destFolder, task.sequence, task.allowReuse === true,
            function (chosenFolder) {
                destFolder = chosenFolder;
                var seqFolder = ensureDir(destFolder);
                if (!seqFolder.ok) {
                    fail(seqFolder.code, seqFolder.code === "DEST_BLOCKED"
                        ? "На месте папки секвенции лежит файл: " + seqFolder.blockedBy
                        : "Не удалось создать папку секвенции: " + destFolder);
                    return;
                }
                next();
            });
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
            if (task.isSequence && task.sequence) {
                var members = api.expandSequence(task.sequence), m, memberStats;
                needed = 0;
                for (m = 0; m < members.length; m++) {
                    memberStats = statOf(members[m]);
                    if (memberStats) needed += memberStats.size || 0;
                }
            }
            if (freeBytes > 0 && needed + reserve > freeBytes) {
                results.push({
                    ok: false,
                    key: task.key || task.id,
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
    /*
     * Строка журнала: ts, key, sourcePath, destPath, partToken.
     *
     * Удаляется только то, что принадлежит записанным здесь задачам. Раньше
     * удалялись ВСЕ .pdpart в папке назначения — ровно то, чего этот модуль
     * обещает не делать: «deleting something we did not certainly write is the
     * one mistake this whole design exists to avoid». На общей рабочей папке
     * это сносило недописанный файл Premiere прямо во время его копирования,
     * потому что откат AE запускается на каждую смену проекта.
     *
     * options.ownColumns  — обрабатывать только строки с таким числом колонок
     *                       (для старого общего pending.tsv: строки AE там ровно
     *                       из четырёх, строки Premiere — из пяти).
     * options.keepForeign — чужие строки не выбрасывать: файл перезаписывается
     *                       без наших, и удаляется только когда пуст.
     */
    api.recoverJournal = function (journalPath, options) {
        var opt = options || {};
        var raw = api.readText(journalPath);
        var summary = { removedPartials: 0, folders: 0, unattributed: 0, keptRows: 0 };
        if (!raw) return summary;

        /* folderKey -> { folder, tokens: {}, prefixes: {} } */
        var byFolder = {}, order = [];
        var kept = [], lines = raw.split(/\r?\n/), i, fields;

        function folderEntry(folder) {
            var key = folder.toLowerCase();
            if (!byFolder[key]) {
                byFolder[key] = { folder: folder, tokens: {}, prefixes: {} };
                order.push(key);
            }
            return byFolder[key];
        }

        for (i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            fields = lines[i].split("\t");
            if (fields.length < 4) continue;
            if (opt.ownColumns && fields.length !== opt.ownColumns) {
                if (opt.keepForeign) { kept.push(lines[i]); summary.keptRows++; }
                continue;
            }

            var dest = toSlash(fields[3]);
            if (!dest) continue;
            var token = fields.length > 4 ? String(fields[4] || "") : "";

            /*
             * Для обычного файла назначение — сам файл, для секвенции — папка.
             * Смотрим оба варианта: лишний каталог просто не даст совпадений,
             * потому что сверка идёт по токену.
             */
            var candidates = [dest.replace(/\/[^\/]*$/, ""), dest];
            var c, entry;
            for (c = 0; c < candidates.length; c++) {
                if (!candidates[c]) continue;
                entry = folderEntry(candidates[c]);
                if (token) {
                    entry.tokens[partialSuffixFor(token).toLowerCase()] = true;
                } else {
                    /*
                     * Строка из версии до 2.3.5: токена нет. Удаляем только
                     * недописанные файлы ЭТОГО назначения — "clip.mp4.<что-то>
                     * .pdpart" рядом с clip.mp4. Кадры секвенции так не
                     * опознаются и остаются на диске: безвредный мусор лучше
                     * удаления по догадке.
                     */
                    var leaf = dest.substring(dest.lastIndexOf("/") + 1);
                    if (leaf) entry.prefixes[(leaf + ".").toLowerCase()] = true;
                }
            }
        }

        for (i = 0; i < order.length; i++) {
            var folderInfo = byFolder[order[i]];
            var names;
            try { names = fs.readdirSync(toNative(folderInfo.folder)); } catch (e) { continue; }
            summary.folders++;

            var j, name, lower, matched, prefix;
            for (j = 0; j < names.length; j++) {
                name = names[j];
                if (!/\.pdpart$/i.test(name)) continue;
                lower = name.toLowerCase();

                matched = false;
                for (var suffix in folderInfo.tokens) {
                    if (!folderInfo.tokens.hasOwnProperty(suffix)) continue;
                    if (lower.length > suffix.length &&
                        lower.substring(lower.length - suffix.length) === suffix) {
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    for (prefix in folderInfo.prefixes) {
                        if (!folderInfo.prefixes.hasOwnProperty(prefix)) continue;
                        if (lower.indexOf(prefix) === 0) { matched = true; break; }
                    }
                }

                if (!matched) { summary.unattributed++; continue; }
                if (removeQuietly(folderInfo.folder + "/" + name)) summary.removedPartials++;
            }
        }

        if (kept.length) api.writeText(journalPath, kept.join("\n") + "\n");
        else removeQuietly(journalPath);
        return summary;
    };

    return api;
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = PardCopyQueue;
}
