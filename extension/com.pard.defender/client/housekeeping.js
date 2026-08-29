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

    /* ----------------------------------------------------------- cloud sync */

    /*
     * A workspace inside a synced folder is the normal case here, not a
     * problem: the owner wants the cloud copy as a backup. What they do NOT
     * want is the local file being evicted to save space, because then opening
     * last month's project means waiting for tens of gigabytes to come back
     * down - and a placeholder that has not been rehydrated reads as a stalled
     * source to the copy queue.
     *
     * Windows has one answer for every provider that uses the Cloud Files API:
     * FILE_ATTRIBUTE_PINNED (0x00080000) means "always keep this on the
     * device". Setting it is what Explorer's own "Always keep on this device"
     * does, and clearing FILE_ATTRIBUTE_UNPINNED alongside it is what stops the
     * provider from evicting the file again.
     */
    var PINNED = 0x00080000;

    var CLOUD_PROVIDERS = [
        { test: /(^|\/)yandex[ ._-]?disk($|\/)/i, label: "Яндекс.Диск" },
        { test: /(^|\/)yandexdisk($|\/)/i, label: "Яндекс.Диск" },
        { test: /(^|\/)onedrive[^\/]*($|\/)/i, label: "OneDrive" },
        { test: /(^|\/)dropbox($|\/)/i, label: "Dropbox" },
        { test: /(^|\/)google\s?drive($|\/)/i, label: "Google Drive" }
    ];

    /*
     * Answers from the PATH rather than from a running process. The folder is
     * what decides whether files get evicted, and it keeps answering correctly
     * when the client is not running - which is exactly when the owner opens an
     * old project and wonders why nothing loads.
     */
    api.cloudInfo = function (workspace) {
        var slash = toSlash(workspace), i, match;
        if (!slash) return { cloud: false, label: "", root: "" };

        for (i = 0; i < CLOUD_PROVIDERS.length; i++) {
            match = CLOUD_PROVIDERS[i].test.exec(slash);
            if (!match) continue;
            var cut = slash.indexOf(match[0]) + match[0].length;
            return {
                cloud: true,
                label: CLOUD_PROVIDERS[i].label,
                root: slash.substring(0, cut).replace(/\/$/, "")
            };
        }
        return { cloud: false, label: "", root: "" };
    };

    /*
     * Reads the attribute back on a sample of the tree rather than trusting the
     * write. Not every provider honours the flag, and a panel that says
     * "закреплено" when nothing was closed is worse than one that admits it
     * could not.
     */
    var PIN_SCRIPT = [
        "$root = $args[0]",
        "$mode = $args[1]",
        "if ($mode -eq 'set') {",
        "  & attrib.exe +P -U \"$root\\*\" /S /D 2>$null | Out-Null",
        "  & attrib.exe +P -U \"$root\" /D 2>$null | Out-Null",
        "}",
        "$pin = 524288",
        "$total = 0",
        "$pinned = 0",
        "Get-ChildItem -LiteralPath $root -Recurse -Force -File " +
            "-ErrorAction SilentlyContinue |",
        "  Select-Object -First 300 |",
        "  ForEach-Object {",
        "    $total = $total + 1",
        "    try {",
        "      $a = [int][System.IO.File]::GetAttributes($_.FullName)",
        "      if ($a -band $pin) { $pinned = $pinned + 1 }",
        "    } catch { }",
        "  }",
        "Write-Output \"$pinned/$total\""
    ].join("\n");

    function runPin(root, mode, callback) {
        if (!api.available() || !childProcess || !root) {
            callback({ ok: false, pinned: 0, sampled: 0, error: "Node недоступен." });
            return;
        }

        var scriptFile = scratchDir() + "/pin.ps1";
        try {
            fs.writeFileSync(toNative(scriptFile), PIN_SCRIPT, "utf8");
        } catch (e) {
            callback({ ok: false, pinned: 0, sampled: 0,
                error: "Не удалось подготовить скрипт: " + e });
            return;
        }

        try {
            childProcess.execFile(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                    "-File", toNative(scriptFile), toNative(root), mode],
                { windowsHide: true, timeout: 600000 },
                function (error, stdout) {
                    var match = /(\d+)\/(\d+)/.exec(String(stdout || ""));
                    if (!match) {
                        callback({
                            ok: false, pinned: 0, sampled: 0,
                            error: "Windows не ответил" + (error ? ": " + error : ".")
                        });
                        return;
                    }
                    var pinned = Number(match[1]) || 0;
                    var sampled = Number(match[2]) || 0;
                    callback({
                        ok: true,
                        pinned: pinned,
                        sampled: sampled,
                        /* Nothing to judge if the folder holds no files yet. */
                        allPinned: sampled > 0 && pinned === sampled,
                        error: ""
                    });
                }
            );
        } catch (e2) {
            callback({ ok: false, pinned: 0, sampled: 0,
                error: "Не удалось запустить проверку: " + e2 });
        }
    }

    api.PINNED = PINNED;
    api.pinState = function (root, callback) { runPin(root, "read", callback); };
    api.pinAlways = function (root, callback) { runPin(root, "set", callback); };

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
