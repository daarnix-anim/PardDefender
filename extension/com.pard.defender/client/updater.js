/*
 * PardDefender - update check.
 *
 * @map role: Проверка обновлений: сначала публичный фид, потом GitHub
 *           Releases. Белый список хостов, токен внутрь не зашивается.
 * @map status: ready
 *
 * Two sources are tried in order, first usable answer wins:
 *
 *   1. A release feed - one small public JSON containing nothing but a version
 *      number, a one-sentence summary and a link. Unset by default. It exists so
 *      that a PRIVATE repository can still announce a version: learning that
 *      1.1.0 exists does not require access to the source.
 *   2. The GitHub releases API for the repository itself. The repository is
 *      public as of 1.1.0, so this is the live path; the unauthenticated API
 *      cannot see a private one, which is what source 1 is held in reserve for.
 *
 * No credential is ever embedded. A token shipped inside an extension is a token
 * published to everyone who installs it, so the private-repository case is
 * solved with a public feed rather than with a secret.
 *
 * Failure is always silent. A panel that cannot reach the network protects files
 * exactly as well as one that can, and an update banner is never worth
 * interrupting the owner with an error.
 *
 * Feed shape:
 *   { "version": "1.1.0",
 *     "summary": "Одно предложение о том, что нового.",
 *     "url": "https://github.com/daarnix-anim/PardDefender/releases" }
 *
 * GitHub release-notes convention: the FIRST non-empty line of the release body
 * is the one-sentence summary shown in the panel.
 */
var PardUpdater = (function () {
    var api = {};

    var OWNER = "daarnix-anim";
    var REPO = "PardDefender";

    /*
     * Empty, and normally stays empty: the repository is public, so source 2
     * answers. Set it to a public raw-JSON URL (a Gist raw link works well) if
     * the repository is ever made private again.
     *
     * It can also be set without editing this file, by adding "feedUrl" to
     * %APPDATA%/PardDefender/update.json.
     */
    var FEED_URL = "";

    /* Only these hosts are ever contacted, whatever a response claims. */
    var ALLOWED_HOSTS = [
        "api.github.com",
        "github.com",
        "raw.githubusercontent.com",
        "gist.githubusercontent.com",
        "objects.githubusercontent.com"
    ];

    var CHECK_INTERVAL_MS = 86400000;   /* once a day is plenty */
    var REQUEST_TIMEOUT_MS = 8000;
    var MAX_BODY_BYTES = 262144;

    var https = null, os = null, fs = null, path = null, child_process = null;
    try { https = require("https"); } catch (e) {}
    try { os = require("os"); } catch (e2) {}
    try { fs = require("fs"); } catch (e3) {}
    try { path = require("path"); } catch (e4) {}
    try { child_process = require("child_process"); } catch (e5) {}

    var currentVersion = "0.0.0";
    var cache = null;

    api.releasesUrl = function () {
        return "https://github.com/" + OWNER + "/" + REPO + "/releases";
    };

    /* --------------------------------------------------------------- state */

    /*
     * Update state is application-level, not project-level: once a day should
     * mean once a day rather than once per project opened, and dismissing a
     * version in one project should dismiss it everywhere.
     */
    function statePath() {
        var base = "";
        if (typeof process !== "undefined" && process.env && process.env.APPDATA) {
            base = process.env.APPDATA;
        } else if (os && os.homedir) {
            base = os.homedir();
        }
        if (!base) return "";
        return String(base).replace(/\\/g, "/") + "/PardDefender/update.json";
    }

    function loadState() {
        if (cache) return cache;
        cache = { lastCheckAt: 0, dismissedVersion: "", latest: null, feedUrl: "" };
        var target = statePath();
        if (!target) return cache;
        var raw = PardCopyQueue.readText(target);
        if (!raw) return cache;
        try {
            var parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                cache.lastCheckAt = Number(parsed.lastCheckAt) || 0;
                cache.dismissedVersion = String(parsed.dismissedVersion || "");
                cache.feedUrl = String(parsed.feedUrl || "");
                cache.latest = parsed.latest || null;
            }
        } catch (e) {}
        return cache;
    }

    function saveState() {
        var target = statePath();
        if (target && cache) PardCopyQueue.writeText(target, JSON.stringify(cache));
    }

    /* ------------------------------------------------------------ helpers */

    /* Numeric, segment by segment: "1.10.0" is newer than "1.9.3". */
    function compareVersions(a, b) {
        var pa = String(a).replace(/^v/i, "").split(/[.\-+]/);
        var pb = String(b).replace(/^v/i, "").split(/[.\-+]/);
        var i, na, nb;
        for (i = 0; i < Math.max(pa.length, pb.length); i++) {
            na = parseInt(pa[i], 10);
            nb = parseInt(pb[i], 10);
            if (isNaN(na)) na = 0;
            if (isNaN(nb)) nb = 0;
            if (na !== nb) return na > nb ? 1 : -1;
        }
        return 0;
    }

    api.compareVersions = compareVersions;

    /* The convention that keeps the banner to one readable line. */
    function summaryFrom(body) {
        var lines = String(body || "").split(/\r?\n/), i, line;
        for (i = 0; i < lines.length; i++) {
            line = lines[i].replace(/^[\s>*\-#]+/, "").replace(/\s+$/, "");
            if (line) {
                if (line.length > 160) line = line.substring(0, 159) + "…";
                return line;
            }
        }
        return "Подробности — на странице релиза.";
    }

    api.summaryFrom = summaryFrom;

    function isAllowedHost(host) {
        var h = String(host || "").toLowerCase();
        for (var i = 0; i < ALLOWED_HOSTS.length; i++) {
            if (h === ALLOWED_HOSTS[i]) return true;
        }
        if (h.slice(-11) === ".github.com" ||
            h.slice(-22) === ".githubusercontent.com" ||
            h.slice(-14) === ".amazonaws.com") {
            return true;
        }
        return false;
    }

    function extractChanges(body) {
        if (!body) return [];
        var lines = String(body).split(/\r?\n/);
        var items = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            if (/^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
                var clean = line.replace(/^[-*•\d.]+\s+/, "").trim();
                if (clean) items.push(clean);
            }
        }
        return items;
    }

    api.extractChanges = extractChanges;

    function parseUrl(url) {
        var match = /^https:\/\/([A-Za-z0-9.\-]+)(\/[^\s]*)?$/.exec(String(url || ""));
        if (!match) return null;
        var host = match[1].toLowerCase();
        if (isAllowedHost(host)) {
            return { hostname: host, path: match[2] || "/" };
        }
        return null;
    }

    api.parseUrl = parseUrl;

    api.configure = function (version) {
        currentVersion = String(version || "0.0.0");
    };

    /* ------------------------------------------------------------ requests */

    function getJson(url, callback) {
        var target = parseUrl(url);
        if (!https || !target) { callback(null); return; }

        var settled = false;
        function done(value) {
            if (settled) return;
            settled = true;
            callback(value);
        }

        var req;
        try {
            req = https.request({
                hostname: target.hostname,
                path: target.path,
                method: "GET",
                headers: {
                    /* GitHub rejects requests without a User-Agent outright. */
                    "User-Agent": "PardDefender/" + currentVersion,
                    "Accept": "application/vnd.github+json, application/json"
                }
            }, function (res) {
                var body = "";
                res.setEncoding("utf8");
                res.on("data", function (chunk) {
                    body += chunk;
                    /* A malformed or hostile response must not grow unbounded. */
                    if (body.length > MAX_BODY_BYTES) {
                        try { res.destroy(); } catch (e) {}
                        done(null);
                    }
                });
                res.on("end", function () {
                    if (res.statusCode !== 200) { done(null); return; }
                    try { done(JSON.parse(body)); } catch (e) { done(null); }
                });
                res.on("error", function () { done(null); });
            });
        } catch (e) { done(null); return; }

        req.on("error", function () { done(null); });
        req.setTimeout(REQUEST_TIMEOUT_MS, function () {
            try { req.destroy(); } catch (e) {}
            done(null);
        });
        req.end();
    }

    function normalizeFeed(payload) {
        if (!payload || !payload.version) return null;
        var ver = String(payload.version).replace(/^v/i, "");
        var body = payload.summary || payload.notes || "";
        return {
            version: ver,
            summary: summaryFrom(body),
            changes: extractChanges(body),
            body: body,
            url: parseUrl(payload.url) ? String(payload.url) : api.releasesUrl(),
            downloadUrl: payload.downloadUrl || ("https://github.com/" + OWNER + "/" + REPO + "/releases/download/v" + ver + "/PardDefender-" + ver + ".zip"),
            publishedAt: payload.publishedAt || ""
        };
    }

    api.normalizeFeed = normalizeFeed;

    function normalizeRelease(payload) {
        if (!payload || !payload.tag_name) return null;
        var tag = String(payload.tag_name).replace(/^v/i, "");
        var downloadUrl = "";
        if (payload.assets && payload.assets.length) {
            for (var a = 0; a < payload.assets.length; a++) {
                var asset = payload.assets[a];
                if (asset && asset.name && asset.name.slice(-4) === ".zip") {
                    downloadUrl = asset.browser_download_url;
                    break;
                }
            }
        }
        if (!downloadUrl) {
            downloadUrl = "https://github.com/" + OWNER + "/" + REPO + "/releases/download/v" + tag + "/PardDefender-" + tag + ".zip";
        }
        return {
            version: tag,
            summary: summaryFrom(payload.body),
            changes: extractChanges(payload.body),
            body: payload.body || "",
            url: parseUrl(payload.html_url) ? String(payload.html_url) : api.releasesUrl(),
            downloadUrl: downloadUrl,
            publishedAt: payload.published_at || ""
        };
    }

    api.normalizeRelease = normalizeRelease;

    /*
     * Feed first, then the releases API. Neither answering is a normal, silent
     * outcome - most often it just means the machine is offline.
     */
    function fetchLatest(feedUrl, callback) {
        function fromReleases() {
            getJson(
                "https://api.github.com/repos/" + OWNER + "/" + REPO + "/releases/latest",
                function (payload) { callback(normalizeRelease(payload)); }
            );
        }

        if (!feedUrl) { fromReleases(); return; }

        getJson(feedUrl, function (payload) {
            var fromFeed = normalizeFeed(payload);
            if (fromFeed) { callback(fromFeed); return; }
            fromReleases();
        });
    }

    function evaluate(latest, state) {
        if (!latest || !latest.version) return null;
        if (compareVersions(latest.version, currentVersion) <= 0) return null;
        if (state.dismissedVersion &&
            compareVersions(latest.version, state.dismissedVersion) <= 0) return null;
        return {
            available: true,
            version: latest.version,
            summary: latest.summary,
            changes: latest.changes || [],
            body: latest.body || "",
            url: latest.url,
            downloadUrl: latest.downloadUrl,
            publishedAt: latest.publishedAt
        };
    }

    api.evaluate = evaluate;

    /*
     * callback receives null when there is nothing to show - no network, no
     * release, already current, or this version was dismissed.
     */
    api.check = function (force, callback) {
        var state = loadState();

        if (!force && state.latest &&
            (Date.now() - state.lastCheckAt) < CHECK_INTERVAL_MS) {
            callback(evaluate(state.latest, state));
            return;
        }

        fetchLatest(state.feedUrl || FEED_URL, function (latest) {
            if (!latest) {
                /* Fall back to whatever the last successful check found. */
                callback(state.latest ? evaluate(state.latest, state) : null);
                return;
            }
            state.lastCheckAt = Date.now();
            state.latest = latest;
            saveState();
            callback(evaluate(latest, state));
        });
    };

    api.dismiss = function (version) {
        var state = loadState();
        state.dismissedVersion = String(version || "");
        saveState();
    };

    api.setFeedUrl = function (url) {
        var state = loadState();
        state.feedUrl = parseUrl(url) ? String(url) : "";
        state.lastCheckAt = 0;
        saveState();
        return state.feedUrl;
    };

    api.openReleasePage = function (url) {
        /*
         * The URL arrives from a network response and is about to be handed to a
         * shell. Re-checking it against the host allowlist here means a spoofed
         * or compromised response cannot turn this into command execution.
         */
        var target = parseUrl(url) ? String(url) : api.releasesUrl();
        try {
            require("child_process").execFile(
                "cmd.exe", ["/c", "start", "", target],
                { windowsHide: true }, function () {}
            );
            return true;
        } catch (e) { return false; }
    };

    /* --------------------------------------------------- background install */

    function getExtensionRoot() {
        if (typeof window !== "undefined" && window.location && window.location.pathname) {
            var p = decodeURIComponent(window.location.pathname).replace(/\\/g, "/");
            if (/^\/[a-zA-Z]:\//.test(p)) p = p.substring(1);
            var clientIdx = p.lastIndexOf("/client");
            if (clientIdx !== -1) return p.substring(0, clientIdx);
            var slash = p.lastIndexOf("/");
            if (slash !== -1) return p.substring(0, slash);
        }
        if (typeof process !== "undefined" && process.env && process.env.APPDATA) {
            return process.env.APPDATA.replace(/\\/g, "/") + "/Adobe/CEP/extensions/com.pard.defender";
        }
        return "";
    }

    api.getExtensionRoot = getExtensionRoot;

    function copyDirRecursive(src, dest) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        var entries = fs.readdirSync(src, { withFileTypes: true });
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var sPath = path.join(src, entry.name);
            var dPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                copyDirRecursive(sPath, dPath);
            } else {
                try {
                    fs.copyFileSync(sPath, dPath);
                } catch (e1) {
                    try { fs.unlinkSync(dPath); } catch (e2) {}
                    fs.copyFileSync(sPath, dPath);
                }
            }
        }
    }

    function findExtensionSourceDir(dir) {
        if (!fs || !dir) return null;
        if (fs.existsSync(path.join(dir, "CSXS", "manifest.xml"))) return dir;
        var cand = path.join(dir, "extension", "com.pard.defender");
        if (fs.existsSync(path.join(cand, "CSXS", "manifest.xml"))) return cand;

        var items = [];
        try { items = fs.readdirSync(dir); } catch (e) { return null; }
        for (var i = 0; i < items.length; i++) {
            var sub = path.join(dir, items[i]);
            try {
                if (fs.statSync(sub).isDirectory()) {
                    if (fs.existsSync(path.join(sub, "CSXS", "manifest.xml"))) return sub;
                    var subCand = path.join(sub, "extension", "com.pard.defender");
                    if (fs.existsSync(path.join(subCand, "CSXS", "manifest.xml"))) return subCand;
                }
            } catch (eSub) {}
        }
        return null;
    }

    function findUxpSourceDir(dir) {
        if (!fs || !dir) return null;
        if (fs.existsSync(path.join(dir, "manifest.json")) && !fs.existsSync(path.join(dir, "CSXS"))) return dir;
        var cand = path.join(dir, "premiere", "com.pard.defender.uxp");
        if (fs.existsSync(path.join(cand, "manifest.json"))) return cand;

        var items = [];
        try { items = fs.readdirSync(dir); } catch (e) { return null; }
        for (var i = 0; i < items.length; i++) {
            var sub = path.join(dir, items[i]);
            try {
                if (fs.statSync(sub).isDirectory()) {
                    var subCand = path.join(sub, "premiere", "com.pard.defender.uxp");
                    if (fs.existsSync(path.join(subCand, "manifest.json"))) return subCand;
                }
            } catch (eSub) {}
        }
        return null;
    }

    function downloadFileWithRedirects(sourceUrl, destPath, onProgress, callback) {
        var maxRedirects = 6;
        var redirectCount = 0;

        function fetch(currentUrl) {
            var target = parseUrl(currentUrl);
            if (!https || !target) {
                callback(new Error("Недопустимый URL или модуль https недоступен: " + currentUrl));
                return;
            }

            var req = https.get({
                hostname: target.hostname,
                path: target.path,
                headers: {
                    "User-Agent": "PardDefender/" + currentVersion,
                    "Accept": "application/octet-stream, application/zip, */*"
                }
            }, function (res) {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    redirectCount++;
                    if (redirectCount > maxRedirects) {
                        callback(new Error("Превышено максимальное число перенаправлений"));
                        return;
                    }
                    var newLoc = res.headers.location;
                    if (!/^https?:\/\//i.test(newLoc)) {
                        newLoc = "https://" + target.hostname + newLoc;
                    }
                    fetch(newLoc);
                    return;
                }

                if (res.statusCode !== 200) {
                    callback(new Error("Ошибка скачивания: HTTP " + res.statusCode));
                    return;
                }

                var totalBytes = parseInt(res.headers["content-length"] || "0", 10);
                var receivedBytes = 0;
                var outStream = fs.createWriteStream(destPath);

                res.on("data", function (chunk) {
                    receivedBytes += chunk.length;
                    if (totalBytes > 0 && typeof onProgress === "function") {
                        var pct = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
                        onProgress({ received: receivedBytes, total: totalBytes, percent: pct });
                    }
                });

                res.pipe(outStream);

                outStream.on("finish", function () {
                    outStream.close(function () {
                        callback(null, destPath);
                    });
                });

                outStream.on("error", function (err) {
                    try { fs.unlinkSync(destPath); } catch (e) {}
                    callback(err);
                });
            });

            req.on("error", function (err) {
                callback(err);
            });

            req.setTimeout(60000, function () {
                try { req.destroy(); } catch (e) {}
                callback(new Error("Таймаут скачивания обновления (60 сек)"));
            });
        }

        fetch(sourceUrl);
    }

    api.installUpdate = function (updateInfo, onProgress, callback) {
        var cb = typeof callback === "function" ? callback : function () {};
        var prog = typeof onProgress === "function" ? onProgress : function () {};

        if (!fs || !os) {
            cb(new Error("Файловая система Node.js недоступна."));
            return;
        }

        var targetVer = updateInfo && updateInfo.version ? String(updateInfo.version) : "latest";
        var downloadUrl = updateInfo && updateInfo.downloadUrl ? updateInfo.downloadUrl : null;
        if (!downloadUrl) {
            downloadUrl = "https://github.com/" + OWNER + "/" + REPO + "/releases/download/v" + targetVer + "/PardDefender-" + targetVer + ".zip";
        }

        var tmpDir = os.tmpdir();
        var zipPath = path.join(tmpDir, "parddefender-update-" + targetVer + "-" + Date.now() + ".zip");
        var extractDir = path.join(tmpDir, "parddefender-extract-" + Date.now());

        prog({ stage: "downloading", percent: 0, message: "Подключение к GitHub..." });

        downloadFileWithRedirects(downloadUrl, zipPath, function (p) {
            prog({
                stage: "downloading",
                percent: p.percent,
                received: p.received,
                total: p.total,
                message: "Скачивание обновления (" + p.percent + "%)..."
            });
        }, function (err) {
            if (err) {
                var fallbackUrl = "https://github.com/" + OWNER + "/" + REPO + "/archive/refs/tags/v" + targetVer + ".zip";
                if (downloadUrl !== fallbackUrl) {
                    prog({ stage: "downloading", percent: 0, message: "Повторная попытка скачивания архива..." });
                    downloadFileWithRedirects(fallbackUrl, zipPath, function (p) {
                        prog({
                            stage: "downloading",
                            percent: p.percent,
                            received: p.received,
                            total: p.total,
                            message: "Скачивание архива (" + p.percent + "%)..."
                        });
                    }, function (err2) {
                        if (err2) {
                            try { fs.unlinkSync(zipPath); } catch (eU) {}
                            cb(err2);
                        } else {
                            proceedWithExtraction();
                        }
                    });
                    return;
                }
                try { fs.unlinkSync(zipPath); } catch (eU) {}
                cb(err);
                return;
            }

            proceedWithExtraction();
        });

        function proceedWithExtraction() {
            prog({ stage: "extracting", percent: 100, message: "Распаковка обновления..." });

            try {
                if (!fs.existsSync(extractDir)) {
                    fs.mkdirSync(extractDir, { recursive: true });
                }
            } catch (eMk) {
                try { fs.unlinkSync(zipPath); } catch (e) {}
                cb(new Error("Не удалось создать каталог распаковки: " + eMk.message));
                return;
            }

            var cmd = "Expand-Archive -Path '" + zipPath.replace(/'/g, "''") + "' -DestinationPath '" + extractDir.replace(/'/g, "''") + "' -Force";
            child_process.execFile("powershell.exe", ["-NoProfile", "-Command", cmd], { windowsHide: true }, function (pErr) {
                if (pErr) {
                    try { fs.unlinkSync(zipPath); } catch (e) {}
                    cb(new Error("Ошибка распаковки архива: " + pErr.message));
                    return;
                }

                prog({ stage: "installing", percent: 100, message: "Установка новых файлов..." });

                var extSrc = findExtensionSourceDir(extractDir);
                if (!extSrc) {
                    try { fs.unlinkSync(zipPath); } catch (e) {}
                    cb(new Error("В архиве обновления не найдена структура расширения After Effects."));
                    return;
                }

                var extRoot = getExtensionRoot();
                if (!extRoot) {
                    try { fs.unlinkSync(zipPath); } catch (e) {}
                    cb(new Error("Не удалось определить рабочий каталог расширения After Effects."));
                    return;
                }

                try {
                    copyDirRecursive(extSrc, extRoot);

                    if (process.env.APPDATA) {
                        var stdCep = path.join(process.env.APPDATA, "Adobe", "CEP", "extensions", "com.pard.defender");
                        if (path.resolve(stdCep) !== path.resolve(extRoot) && fs.existsSync(stdCep)) {
                            copyDirRecursive(extSrc, stdCep);
                        }
                    }

                    var uxpSrc = findUxpSourceDir(extractDir);
                    if (uxpSrc && process.env.APPDATA) {
                        var uxpTargets = [
                            path.join(process.env.APPDATA, "Adobe", "UXP", "Plugins", "External", "com.pard.defender.uxp"),
                            path.join(process.env.APPDATA, "Adobe", "UXP", "extensions", "com.pard.defender.uxp"),
                            path.join(process.env.APPDATA, "Adobe", "Premiere Pro", "26.0", "UXP", "DebugPlugins", "com.pard.defender.uxp")
                        ];
                        for (var u = 0; u < uxpTargets.length; u++) {
                            if (fs.existsSync(uxpTargets[u])) {
                                copyDirRecursive(uxpSrc, uxpTargets[u]);
                            }
                        }
                    }

                    try { fs.unlinkSync(zipPath); } catch (eZ) {}
                    try {
                        if (fs.rmSync) fs.rmSync(extractDir, { recursive: true, force: true });
                    } catch (eRm) {}

                    cb(null, {
                        ok: true,
                        version: targetVer,
                        targetDir: extRoot,
                        message: "Обновление до версии v" + targetVer + " успешно установлено. После перезагрузки After Effects приложение будет обновлено до новой версии."
                    });
                } catch (eCopy) {
                    try { fs.unlinkSync(zipPath); } catch (eZ2) {}
                    cb(new Error("Ошибка копирования обновлённых файлов: " + eCopy.message));
                }
            });
        }
    };

    return api;
})();
