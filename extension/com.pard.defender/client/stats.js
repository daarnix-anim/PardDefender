/*
 * PardDefender - cumulative metrics, scoped to one project.
 *
 * @map role: Накопительные счётчики по проекту и дельта за текущую
 *           сессию.
 * @map status: ready
 *
 * Lives at <workspace>/.parddefender/stats.json, so it travels with the project
 * to another machine and into the archive. Nothing is written to the user
 * profile: a number that survives the project it describes is a number nobody
 * can check.
 *
 * These are counters, not state. The live figures - how much is protected right
 * now, how much is queued - come from the audit and are never stored, because a
 * stored copy of them would go stale the moment the owner touches the project.
 */
var PardStats = (function () {
    var api = {};

    var workspace = "";
    var data = null;
    var sessionBase = null;
    var dirty = false;

    function blank() {
        return {
            version: 1,
            createdAt: new Date().toISOString(),
            lastPassAt: "",
            filesProcessed: 0,
            bytesCopied: 0,
            filesReused: 0,
            bytesSaved: 0,
            sequencesProcessed: 0,
            panelMoves: 0,
            foldersPruned: 0,
            /* Old copies the legacy pass sent to the Recycle Bin after their
             * replacement had been verified and relinked. */
            filesRelocated: 0,
            errorsTotal: 0,
            passes: 0
        };
    }

    function storePath() { return workspace + "/.parddefender/stats.json"; }

    function snapshot(source) {
        var out = {}, key;
        for (key in source) { if (source.hasOwnProperty(key)) out[key] = source[key]; }
        return out;
    }

    api.attach = function (workspacePath) {
        workspace = String(workspacePath || "");
        data = blank();
        dirty = false;
        if (workspace) {
            var raw = PardCopyQueue.readText(storePath());
            if (raw) {
                var parsed = null;
                try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
                if (parsed && typeof parsed === "object") {
                    var fresh = blank(), key;
                    for (key in fresh) {
                        if (!fresh.hasOwnProperty(key)) continue;
                        if (typeof fresh[key] === "number") {
                            fresh[key] = Number(parsed[key]) || 0;
                        } else if (parsed[key]) {
                            fresh[key] = String(parsed[key]);
                        }
                    }
                    data = fresh;
                }
            }
        }
        /* Everything since the panel opened is measured against this. */
        sessionBase = snapshot(data);
    };

    api.save = function () {
        if (!workspace || !dirty || !data) return;
        PardCopyQueue.writeText(storePath(), JSON.stringify(data));
        dirty = false;
    };

    api.add = function (changes) {
        if (!data) return;
        var key;
        for (key in changes) {
            if (!changes.hasOwnProperty(key)) continue;
            if (typeof data[key] !== "number") continue;
            data[key] += Number(changes[key]) || 0;
        }
        dirty = true;
    };

    api.markPass = function () {
        if (!data) return;
        data.lastPassAt = new Date().toISOString();
        data.passes++;
        dirty = true;
    };

    api.total = function () { return data ? snapshot(data) : blank(); };

    /* What this session alone has achieved - the number that tells the owner the
     * panel is actually working right now rather than idling. */
    api.session = function () {
        var out = blank(), key;
        if (!data || !sessionBase) return out;
        for (key in out) {
            if (!out.hasOwnProperty(key)) continue;
            if (typeof out[key] !== "number") continue;
            out[key] = (data[key] || 0) - (sessionBase[key] || 0);
        }
        return out;
    };

    api.formatDate = function (iso) {
        if (!iso) return "";
        var d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        function pad(n) { return (n < 10 ? "0" : "") + n; }
        return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear();
    };

    api.formatTime = function (iso) {
        if (!iso) return "";
        var d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        function pad(n) { return (n < 10 ? "0" : "") + n; }
        return pad(d.getHours()) + ":" + pad(d.getMinutes());
    };

    return api;
})();
