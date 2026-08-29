/*
 * PardDefender - rolling verification of already-protected files.
 *
 * @map role: Скользящая сверка защищённых файлов с манифестом — по 64 за
 *           проход. Она же отвечает, какие файлы положило туда само
 *           расширение.
 * @map status: ready
 *
 * "Protected" without this module is a claim about the past: the file was copied
 * into the workspace once. This makes it a claim about the present.
 *
 * After Effects will not notice a protected file that was deleted or truncated
 * outside the application - `footageMissing` only flips when AE next tries to
 * read the frames, which is typically at render. Checking the paths ourselves
 * surfaces it while there is still time to do something.
 *
 * A bounded number of files per pass, resuming where the last pass stopped, so a
 * project with two thousand assets costs the same per pass as one with twenty.
 */
var PardVerify = (function () {
    var api = {};

    var DEFAULT_BUDGET = 64;

    var workspace = "";
    var manifest = {};
    var cursor = 0;

    api.DEFAULT_BUDGET = DEFAULT_BUDGET;

    function key(path) { return String(path || "").replace(/\\/g, "/").toLowerCase(); }

    /*
     * The manifest is the record of what PardDefender itself put on disk:
     *   ts, id, sourcePath, sourceSize, destPath, branch, category
     * Later lines win - a file copied twice under the same name has its most
     * recent size as the authority.
     */
    api.attach = function (workspacePath) {
        workspace = String(workspacePath || "");
        manifest = {};
        cursor = 0;
        if (!workspace) return;

        var raw = PardCopyQueue.readText(workspace + "/.parddefender/assets.tsv");
        if (!raw) return;

        var lines = raw.split(/\r?\n/), i, fields;
        for (i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            fields = lines[i].split("\t");
            if (fields.length < 5) continue;
            manifest[key(fields[4])] = {
                sourcePath: fields[2],
                size: Number(fields[3]) || 0,
                destPath: fields[4]
            };
        }
    };

    api.manifestSize = function () {
        var count = 0, k;
        for (k in manifest) { if (manifest.hasOwnProperty(k)) count++; }
        return count;
    };

    /*
     * The manifest is also the answer to "did WE put this file here?" - and that
     * question gates deletion. An asset the owner had already filed in the
     * workspace before protection started has no manifest row, so cleanup can
     * never reach it: it is their file, in their folder, and we did not create
     * it.
     */
    api.recordFor = function (destPath) {
        return manifest[key(destPath)] || null;
    };

    api.wasCopiedByUs = function (destPath) {
        return !!manifest[key(destPath)];
    };

    /*
     * `items` is the audit's item list. Only entries already inside the
     * workspace are checked; everything else is the copy queue's problem, not
     * this module's.
     */
    api.sweep = function (items, budget) {
        var limit = budget || DEFAULT_BUDGET;
        var findings = [], checked = 0, scanned = 0;

        if (!items || !items.length || !PardCopyQueue.available()) {
            return { findings: findings, checked: 0, wrapped: false };
        }

        var wrapped = false;
        while (checked < limit && scanned < items.length) {
            if (cursor >= items.length) { cursor = 0; wrapped = true; }
            var item = items[cursor++];
            scanned++;
            if (!item || item.state !== "protected" || !item.path) continue;

            checked++;
            var stats = PardCopyQueue.statOf(item.path);

            if (!stats) {
                findings.push({
                    key: "i" + item.id,
                    id: item.id,
                    name: item.name,
                    path: item.path,
                    code: "PROTECTED_GONE",
                    detail: item.path,
                    sourceSize: item.size
                });
                continue;
            }

            /*
             * Size is only compared against a file PardDefender wrote itself.
             * An asset that was already inside the workspace before protection
             * started has no recorded size, and inventing one from the current
             * state would make every such file look verified when it is not.
             */
            var record = manifest[key(item.path)];
            if (record && record.size > 0 && stats.size !== record.size) {
                findings.push({
                    key: "i" + item.id,
                    id: item.id,
                    name: item.name,
                    path: item.path,
                    code: "PROTECTED_CHANGED",
                    detail: "было " + record.size + " байт, стало " + stats.size,
                    sourceSize: stats.size
                });
            }
        }

        return { findings: findings, checked: checked, wrapped: wrapped };
    };

    /* Full sweep on demand - what the owner runs before archiving a project. */
    api.sweepAll = function (items) {
        cursor = 0;
        return api.sweep(items, items ? items.length : 0);
    };

    api.reset = function () { cursor = 0; };

    return api;
})();
