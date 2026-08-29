/*
 * PardDefender - update check.
 *
 * @map role: Проверка обновлений: сначала публичный фид, потом GitHub
 *           Releases. Белый список хостов, токен внутрь не зашивается.
 * @map status: partial
 * @map note: Репозиторий приватный, а публичный фид ещё не задан —
 *           проверка молча ничего не находит. Нужен feedUrl в
 *           %APPDATA%/PardDefender/update.json.
 *
 * Two sources are tried in order, first usable answer wins:
 *
 *   1. A release feed - one small public JSON containing nothing but a version
 *      number, a one-sentence summary and a link. This is the channel that works
 *      while the code repository is PRIVATE: the panel only needs to learn that
 *      1.1.0 exists, which does not require access to the source.
 *   2. The GitHub releases API for the repository itself. This answers only for
 *      a public repository - the unauthenticated API cannot see a private one.
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
     * Set this to a public raw-JSON URL to enable update notices while the
     * repository stays private; a public Gist raw link works well. Empty means
     * the feed channel is skipped.
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

    var https = null, os = null;
    try { https = require("https"); } catch (e) {}
    try { os = require("os"); } catch (e2) {}

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

    function parseUrl(url) {
        var match = /^https:\/\/([A-Za-z0-9.\-]+)(\/[^\s]*)?$/.exec(String(url || ""));
        if (!match) return null;
        var host = match[1].toLowerCase(), i;
        for (i = 0; i < ALLOWED_HOSTS.length; i++) {
            if (host === ALLOWED_HOSTS[i]) {
                return { hostname: host, path: match[2] || "/" };
            }
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
        return {
            version: String(payload.version).replace(/^v/i, ""),
            summary: summaryFrom(payload.summary || payload.notes || ""),
            url: parseUrl(payload.url) ? String(payload.url) : api.releasesUrl(),
            publishedAt: payload.publishedAt || ""
        };
    }

    api.normalizeFeed = normalizeFeed;

    function normalizeRelease(payload) {
        if (!payload || !payload.tag_name) return null;
        return {
            version: String(payload.tag_name).replace(/^v/i, ""),
            summary: summaryFrom(payload.body),
            url: parseUrl(payload.html_url) ? String(payload.html_url) : api.releasesUrl(),
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
            url: latest.url,
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

    return api;
})();
