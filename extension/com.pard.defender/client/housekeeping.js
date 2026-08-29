/*
 * PardDefender - workspace weight and reversible deletion.
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
     * explorer.exe wants "/select,<path>" as ONE argument - the comma binds the
     * path to the switch. Passing them as two argv entries, which is the obvious
     * thing to write, silently opens nothing at all.
     */
    api.reveal = function (target) {
        if (!childProcess || !target) return false;
        var native = toNative(target);
        var exists = false;
        try { exists = !!fs.statSync(native); } catch (e) { exists = false; }

        var args = exists
            ? ["/select," + native]
            /* The file is gone - the next best thing is its folder. */
            : [toNative(toSlash(target).replace(/\/[^\/]*$/, ""))];

        try {
            childProcess.execFile("explorer.exe", args, { windowsHide: true },
                function () { /* explorer exits non-zero even on success */ });
            return true;
        } catch (e2) { return false; }
    };

    return api;
})();
