/*
 * PardDefender - update check against GitHub releases.
 *
 * Uses the Node https module rather than fetch/XHR from the page: the panel
 * already has Node enabled, and going through Node sidesteps cross-origin
 * handling entirely.
 *
 * Failure here is always silent. A panel that cannot reach GitHub is a panel
 * that protects files exactly as well as one that can, and an update banner is
 * never worth interrupting the owner with an error.
 *
 * Release-notes convention: the FIRST non-empty line of the release body is the
 * one-sentence summary shown in the panel. Everything after it is detail for the
 * GitHub page and is not displayed here.
 */
var PardUpdater = (function () {
    var api = {};

    var OWNER = "daarnix-anim";
    var REPO = "PardDefender";
    var CHECK_INTERVAL_MS = 86400000;   /* once a day is plenty */
    var REQUEST_TIMEOUT_MS = 8000;

    var https = null, os = null, path = null;
    try { https = require("https"); } catch (e) {}
    try { os = require("os"); } catch (e2) {}
    try { path = require("path"); } catch (e3) {}

    var currentVersion = "0.0.0";
    var cache = null;

    api.releasesUrl = function () {
        return "https://github.com/" + OWNER + "/" + REPO + "/releases/latest";
    };

    /*
     * Update state is application-level, not project-level: checking once a day
     * should mean once a day, not once per project opened, and dismissing a
     * version in one project should dismiss it everywhere.
     */
    function statePath() {
        var base = "";
        if (process && process.env && process.env.APPDATA) base = process.env.APPDATA;
        else if (os && os.homedir) base = os.homedir();
        if (!base) return "";
        return String(base).replace(/\\/g, "/") + "/PardDefender/update.json";
    }

    function loadState() {
        if (cache) return cache;
        cache = { lastCheckAt: 0, dismissedVersion: "", latest: null };
        var target = statePath();
        if (!target) return cache;
        var raw = PardCopyQueue.readText(target);
        if (!raw) return cache;
        try {
            var parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                cache.lastCheckAt = Number(parsed.lastCheckAt) || 0;
                cache.dismissedVersion = String(parsed.dismissedVersion || "");
                cache.latest = parsed.latest || null;
            }
        } catch (e) {}
        return cache;
    }

    function saveState() {
        var target = statePath();
        if (target && cache) PardCopyQueue.writeText(target, JSON.stringify(cache));
    }

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

    /* The convention that makes the banner readable: one line, one sentence. */
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

    api.configure = function (version) {
        currentVersion = String(version || "0.0.0");
    };

    function request(callback) {
        if (!https) { callback(null); return; }
        var settled = false;

        function done(value) {
            if (settled) return;
            settled = true;
            callback(value);
        }

        var options = {
            hostname: "api.github.com",
            path: "/repos/" + OWNER + "/" + REPO + "/releases/latest",
            method: "GET",
            headers: {
                /* GitHub rejects requests without a User-Agent outright. */
                "User-Agent": "PardDefender/" + currentVersion,
                "Accept": "application/vnd.github+json"
            }
        };

        var req;
        try {
            req = https.request(options, function (res) {
                var body = "";
                res.setEncoding("utf8");
                res.on("data", function (chunk) {
                    body += chunk;
                    /* A malformed or hostile response must not grow without bound. */
                    if (body.length > 262144) { try { res.destroy(); } catch (e) {} done(null); }
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

        request(function (release) {
            if (!release || !release.tag_name) {
                /* Fall back to whatever the last successful check found. */
                callback(state.latest ? evaluate(state.latest, state) : null);
                return;
            }
            state.lastCheckAt = Date.now();
            state.latest = {
                version: String(release.tag_name).replace(/^v/i, ""),
                summary: summaryFrom(release.body),
                url: release.html_url || api.releasesUrl(),
                publishedAt: release.published_at || ""
            };
            saveState();
            callback(evaluate(state.latest, state));
        });
    };

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

    api.dismiss = function (version) {
        var state = loadState();
        state.dismissedVersion = String(version || "");
        saveState();
    };

    api.openReleasePage = function (url) {
        var target = url || api.releasesUrl();
        /*
         * The URL arrives from a network response, and it is about to be handed
         * to a shell. Only an https github.com address is ever opened, so a
         * compromised or spoofed response cannot turn this into command
         * execution.
         */
        if (!/^https:\/\/github\.com\/[A-Za-z0-9._\-\/]*$/.test(target)) {
            target = api.releasesUrl();
        }
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
