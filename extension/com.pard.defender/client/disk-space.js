/*
 * Free-space reporting for the volume that holds the workspace.
 *
 * Three sources, in order of preference:
 *   1. fs.statfs  - present from Node 18.15. Newer After Effects builds have it.
 *   2. fsutil     - always present on Windows, needs no elevation, and its
 *                   output order is stable even on a localised system, so the
 *                   numbers are read by position rather than by label.
 *   3. df         - macOS and Linux.
 *
 * wmic is deliberately not used: it is removed on Windows 11 24H2 and later,
 * which is exactly the platform this panel runs on.
 */
var PardDiskSpace = (function () {
    var api = {};

    var fs = null;
    var childProcess = null;
    try { fs = require("fs"); } catch (e) { fs = null; }
    try { childProcess = require("child_process"); } catch (e2) { childProcess = null; }

    function volumeOf(path) {
        var p = String(path || "").replace(/\\/g, "/");
        var match = /^([A-Za-z]:)/.exec(p);
        if (match) return match[1];
        return "/";
    }

    api.volumeOf = volumeOf;

    function result(free, total, source) {
        var f = Number(free) || 0;
        var t = Number(total) || 0;
        return {
            ok: t > 0,
            freeBytes: f,
            totalBytes: t,
            usedBytes: Math.max(0, t - f),
            usedRatio: t > 0 ? Math.max(0, Math.min(1, (t - f) / t)) : 0,
            source: source
        };
    }

    function viaStatfs(path, callback) {
        if (!fs || typeof fs.statfs !== "function") return false;
        try {
            fs.statfs(path, function (error, stats) {
                if (error || !stats) { callback(null); return; }
                var block = Number(stats.bsize) || 0;
                callback(result(
                    block * (Number(stats.bavail) || 0),
                    block * (Number(stats.blocks) || 0),
                    "statfs"
                ));
            });
            return true;
        } catch (e) { return false; }
    }

    /*
     * fsutil prints three lines: free bytes, total bytes, available free bytes.
     * The labels are translated, the order is not - so every digit group is
     * extracted and read by index.
     */
    function parseFsutil(output) {
        var text = String(output || "");
        var numbers = [];
        var lines = text.split(/\r?\n/);
        var i, cleaned, match;
        for (i = 0; i < lines.length; i++) {
            /* Digit grouping is locale dependent: space, nbsp, comma, apostrophe. */
            cleaned = lines[i].replace(/[\s,']/g, "");
            match = /(\d{4,})\s*$/.exec(cleaned);
            if (match) numbers.push(Number(match[1]));
        }
        if (numbers.length < 2) return null;
        var free = numbers.length >= 3 ? numbers[2] : numbers[0];
        return result(free, numbers[1], "fsutil");
    }

    function parseDf(output) {
        var lines = String(output || "").split(/\r?\n/);
        if (lines.length < 2) return null;
        var parts = lines[1].replace(/^\s+/, "").split(/\s+/);
        if (parts.length < 4) return null;
        /* df -k: filesystem, 1K-blocks, used, available */
        var total = Number(parts[1]) * 1024;
        var free = Number(parts[3]) * 1024;
        if (!isFinite(total) || !isFinite(free)) return null;
        return result(free, total, "df");
    }

    function runCommand(command, args, callback) {
        if (!childProcess || typeof childProcess.execFile !== "function") {
            callback(null);
            return;
        }
        try {
            childProcess.execFile(
                command,
                args,
                { windowsHide: true, timeout: 8000 },
                function (error, stdout) {
                    callback(error ? null : String(stdout || ""));
                }
            );
        } catch (e) { callback(null); }
    }

    api.query = function (path, callback) {
        var target = String(path || "");
        if (!target) { callback(result(0, 0, "none")); return; }

        var handled = viaStatfs(target, function (stats) {
            if (stats && stats.ok) { callback(stats); return; }
            fallback();
        });
        if (handled) return;
        fallback();

        function fallback() {
            var isWindows = /^[A-Za-z]:/.test(target.replace(/\\/g, "/"));
            if (isWindows) {
                runCommand("fsutil.exe", ["volume", "diskfree", volumeOf(target)],
                    function (output) {
                        var parsed = output ? parseFsutil(output) : null;
                        callback(parsed || result(0, 0, "unavailable"));
                    });
                return;
            }
            runCommand("df", ["-k", target], function (output) {
                var parsed = output ? parseDf(output) : null;
                callback(parsed || result(0, 0, "unavailable"));
            });
        }
    };

    api.formatBytes = function (bytes) {
        var value = Number(bytes) || 0;
        var units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
        var index = 0;
        while (value >= 1024 && index < units.length - 1) {
            value = value / 1024;
            index++;
        }
        var digits = value >= 100 || index === 0 ? 0 : 1;
        return value.toFixed(digits) + " " + units[index];
    };

    return api;
})();
