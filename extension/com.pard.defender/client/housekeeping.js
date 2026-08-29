/*
 * PardDefender - workspace weight and reversible deletion.
 *
 * @map role: Вес проекта на диске, удаление в Корзину и открытие файла в
 *           проводнике.
 * @map status: ready
 *
 * Two jobs that both touch the whole project folder, so they share the same
 * careful walking code:
 *
 *   1. How much the project weighs on disk, shown next to how much room is left
 *      on the drive it sits on.
 *   2. Sending unused protected copies to the Recycle Bin.
 *
 * Deletion here is ALWAYS to the Recycle Bin, never a permanent unlink. The
 * whole product exists so that assets stop disappearing; a cleanup button that
 * destroys files outright would contradict it. If the Recycle Bin is
 * unavailable, the file is reported as not deleted - it is never hard-deleted
 * as a fallback.
 */
var PardHousekeeping = (function () {
    var api = {};

    var fs = null, path = null, os = null, childProcess = null;
    try { fs = require("fs"); } catch (e) {}
    try { path = require("path"); } catch (e2) {}
    try { os = require("os"); } catch (e3) {}
    try { childProcess = require("child_process"); } catch (e4) {}

    function toNative(p) { return String(p || "").replace(/\//g, path ? path.sep : "\\"); }
    function toSlash(p) { return String(p || "").replace(/\\/g, "/"); }

    api.available = function () { return !!(fs && path); };

    /* --------------------------------------------------------------- weight */

    /*
     * Walks the workspace in slices, yielding to the UI between them. A project
     * folder can hold thousands of frames, and a synchronous walk would freeze
     * the panel for as long as it took.
     */
    api.measure = function (root, callback) {
        if (!api.available() || !root) {
            callback({ ok: false, bytes: 0, files: 0 });
            return;
        }

        var pending = [toSlash(root)];
        var bytes = 0, files = 0, folders = 0;
        var guard = 0;

        function slice() {
            var budget = 400;
            while (pending.length && budget-- > 0) {
                if (guard++ > 400000) { break; }
                var dir = pending.pop();
                var names;
                try { names = fs.readdirSync(toNative(dir)); }
                catch (e) { continue; }
                folders++;

                var i, full, stats;
                for (i = 0; i < names.length; i++) {
                    full = dir + "/" + names[i];
                    try { stats = fs.lstatSync(toNative(full)); }
                    catch (e2) { continue; }
                    /* Symlinks are not followed: a junction pointing back into
                     * the tree would otherwise make the walk never finish. */
                    if (stats.isSymbolicLink()) continue;
                    if (stats.isDirectory()) { pending.push(full); continue; }
                    bytes += stats.size;
                    files++;
                }
            }

            if (pending.length && guard <= 400000) {
                setTimeout(slice, 0);
                return;
            }
            callback({ ok: true, bytes: bytes, files: files, folders: folders });
        }

        setTimeout(slice, 0);
    };

    /* ------------------------------------------------------------- deletion */

    var RECYCLE_SCRIPT = [
        "Add-Type -AssemblyName Microsoft.VisualBasic",
        "$ok = 0",
        "$fail = 0",
        "foreach ($line in [System.IO.File]::ReadAllLines($args[0], [System.Text.Encoding]::UTF8)) {",
        "  if ([string]::IsNullOrWhiteSpace($line)) { continue }",
        "  try {",
        "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(" +
            "$line, 'OnlyErrorDialogs', 'SendToRecycleBin')",
        "    $ok = $ok + 1",
        "  } catch { $fail = $fail + 1 }",
        "}",
        "Write-Output \"$ok/$fail\""
    ].join("\n");

    function scratchDir() {
        var base = os && os.tmpdir ? toSlash(os.tmpdir()) : "";
        var dir = base + "/parddefender-client";
        try { fs.mkdirSync(toNative(dir), { recursive: true }); } catch (e) {}
        return dir;
    }

    /*
     * Paths are handed over through a UTF-8 file rather than the command line:
     * project folders routinely contain spaces, Cyrillic and quotes, and every
     * one of those is a way for shell quoting to delete the wrong thing.
     */
    api.recycle = function (paths, callback) {
        if (!api.available() || !childProcess || !paths || !paths.length) {
            callback({ ok: false, recycled: 0, failed: 0, error: "Нечего удалять." });
            return;
        }

        var dir = scratchDir();
        var listFile = dir + "/recycle-list.txt";
        var scriptFile = dir + "/recycle.ps1";

        try {
            fs.writeFileSync(toNative(listFile), paths.map(toNative).join("\r\n"), "utf8");
            fs.writeFileSync(toNative(scriptFile), RECYCLE_SCRIPT, "utf8");
        } catch (e) {
            callback({ ok: false, recycled: 0, failed: paths.length,
                error: "Не удалось подготовить список: " + e });
            return;
        }

        try {
            childProcess.execFile(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                    "-File", toNative(scriptFile), toNative(listFile)],
                { windowsHide: true, timeout: 120000 },
                function (error, stdout) {
                    var match = /(\d+)\/(\d+)/.exec(String(stdout || ""));
                    if (!match) {
                        callback({
                            ok: false, recycled: 0, failed: paths.length,
                            error: "Корзина недоступна, файлы не тронуты" +
                                (error ? ": " + error : ".")
                        });
                        return;
                    }
                    callback({
                        ok: true,
                        recycled: Number(match[1]) || 0,
                        failed: Number(match[2]) || 0,
                        error: ""
                    });
                }
            );
        } catch (e2) {
            callback({ ok: false, recycled: 0, failed: paths.length,
                error: "Не удалось запустить удаление: " + e2 });
        }
    };

    /* ------------------------------------------------------------- explorer */

    /*
     * Opening a file's location in Explorer, which is fiddlier than it looks.
     *
     * explorer.exe does not use CRT argv parsing - it reads the raw command
     * line. `execFile("explorer.exe", ["/select," + path])` looks right and is
     * what 1.0.1 shipped, but Node quotes any argument containing a space, so
     * explorer receives ONE quoted token `"/select,C:\a folder\clip.mp4"`,
     * fails to recognise the switch, and silently does nothing. Every path in
     * this project has spaces in it, so the button never worked once.
     *
     * The quotes have to wrap the PATH only. That means handing cmd a raw
     * command line rather than an argv array.
     *
     * Returns a reason instead of a bare boolean: the caller has to be able to
     * tell "opened" from "that file is not there any more".
     */
    function looksInjectable(value) {
        /* Windows forbids " in a file name, and % would be expanded by cmd. */
        return /["%]/.test(String(value));
    }

    function openFolder(folder) {
        try {
            childProcess.execFile("explorer.exe", [toNative(folder)],
                { windowsHide: true }, function () {});
            return true;
        } catch (e) { return false; }
    }

    api.revealFile = function (target) {
        if (!childProcess || !fs) return { ok: false, code: "unavailable" };
        if (!target) return { ok: false, code: "none" };

        var slash = toSlash(target);
        var folder = slash.replace(/\/[^\/]*$/, "");
        var stats = null;
        try { stats = fs.statSync(toNative(slash)); } catch (e) { stats = null; }

        if (stats) {
            if (looksInjectable(slash)) {
                /* Cannot quote this safely - settle for the containing folder. */
                return openFolder(folder)
                    ? { ok: true, code: "folder", path: folder }
                    : { ok: false, code: "unavailable" };
            }
            try {
                childProcess.exec(
                    'explorer.exe /select,"' + toNative(slash) + '"',
                    { windowsHide: true },
                    function () { /* explorer always exits non-zero */ }
                );
                return { ok: true, code: "selected", path: slash };
            } catch (e2) { return { ok: false, code: "unavailable" }; }
        }

        /* The file is gone. Its folder is still useful if it survived. */
        var folderStats = null;
        try { folderStats = fs.statSync(toNative(folder)); } catch (e3) {}
        if (folderStats && folderStats.isDirectory()) {
            return openFolder(folder)
                ? { ok: false, code: "fileGone", path: slash, folder: folder }
                : { ok: false, code: "missing", path: slash };
        }
        return { ok: false, code: "missing", path: slash };
    };

    /* Kept for callers that only need "try to show this". */
    api.reveal = function (target) { return api.revealFile(target).ok; };

    return api;
})();
