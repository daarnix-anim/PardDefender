/*
 * PardDefender - workspace resolution, settings, branch resolution, audit.
 * Loaded after PardDefenderCore.jsx. ES3 only.
 */

(function () {
    var host = $.global.PardDefenderHost;
    if (!host) return;

    function str(v) {
        try { return (v === null || v === undefined) ? "" : String(v); }
        catch (e) { return ""; }
    }
    function lower(v) { return str(v).toLowerCase(); }
    function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

    function inList(list, value) {
        var i;
        for (i = 0; i < list.length; i++) { if (list[i] === value) return true; }
        return false;
    }

    /*
     * Duck-typed rather than `instanceof Array`: the settings and plan payloads
     * are decoded from text, and an array that crossed a realm boundary fails
     * the instanceof check while behaving like an array in every way that
     * matters here.
     */
    function isArrayLike(value) {
        return !!value && typeof value === "object" &&
            typeof value.length === "number" && typeof value.split !== "function";
    }

    host.isArrayLike = isArrayLike;

    /* ------------------------------------------------------------- settings */

    var INBOX_BRANCH = "_INBOX";
    var SHARED_BRANCH = "_SHARED";
    var METADATA_FOLDER = ".parddefender";

    var PANEL_COMPS = "01_COMPS";
    var PANEL_ASSETS = "02_ASSETS";
    var PANEL_AUDIO = "03_AUDIO";

    host.INBOX_BRANCH = INBOX_BRANCH;
    host.SHARED_BRANCH = SHARED_BRANCH;
    host.METADATA_FOLDER = METADATA_FOLDER;
    host.PANEL_COMPS = PANEL_COMPS;
    host.PANEL_ASSETS = PANEL_ASSETS;
    host.PANEL_AUDIO = PANEL_AUDIO;

    /*
     * {branch} is substituted per item. Audio routes carry no {branch} on
     * purpose: the owner asked for every music and sound-effect file to land in
     * one place at the workspace root, independent of composition.
     */
    function defaultSettings() {
        return {
            version: 1,
            autoEnabled: true,
            copyEnabled: true,
            organizePanelEnabled: true,
            scanIntervalMs: 180000,
            settleDelayMs: 600000,
            inboxTimeoutMs: 3600000,
            audioSplitSeconds: 30,
            pinLabel: 1,
            sectionLabel: 10,
            reserveBytes: 536870912,
            maxItemsPerPass: 40,
            routes: {
                video: "01_assets/{branch}/VIDEO",
                image: "01_assets/{branch}/IMAGES",
                vector: "01_assets/{branch}/VECTOR",
                design: "01_assets/{branch}/DESIGN",
                model: "01_assets/{branch}/3D",
                data: "01_assets/{branch}/DATA",
                project: "01_assets/{branch}/PROJECTS",
                other: "01_assets/{branch}/OTHER",
                sequence: "01_assets/{branch}/SEQUENCES/{name}",
                music: "03_audio/music",
                sfx: "03_audio/sfx",
                voice: "03_audio/voice"
            },
            trustedPaths: []
        };
    }

    host.defaultSettings = defaultSettings;

    /*
     * Every route must stay a strict descendant of the workspace. A route that
     * escapes upward, names a drive, or points at our own metadata folder is
     * replaced by the default rather than refused, so a hand-edited settings
     * file can never send a copy somewhere unexpected.
     */
    function sanitizeRoute(value, fallback) {
        var v = host.slashes(str(value));
        if (!v) return fallback;
        if (/^[A-Za-z]:/.test(v) || v.charAt(0) === "/") return fallback;
        if (v.indexOf("..") >= 0) return fallback;
        if (lower(v).indexOf(METADATA_FOLDER) >= 0) return fallback;
        if (v.split("/").length > 8) return fallback;
        return v;
    }

    function normalizeSettings(raw) {
        var defaults = defaultSettings();
        var out = defaults, k, i, list;
        if (!raw || typeof raw !== "object") return out;

        out.autoEnabled = raw.autoEnabled !== false;
        out.copyEnabled = raw.copyEnabled !== false;
        out.organizePanelEnabled = raw.organizePanelEnabled !== false;

        /* 30 s .. 2 h scan, 0 .. 24 h settle - both are user-facing minutes. */
        out.scanIntervalMs = Math.max(30000, Math.min(7200000,
            num(raw.scanIntervalMs, defaults.scanIntervalMs)));
        out.settleDelayMs = Math.max(0, Math.min(86400000,
            num(raw.settleDelayMs, defaults.settleDelayMs)));
        out.inboxTimeoutMs = Math.max(out.settleDelayMs, Math.min(86400000,
            num(raw.inboxTimeoutMs, defaults.inboxTimeoutMs)));
        out.audioSplitSeconds = Math.max(0, Math.min(3600,
            num(raw.audioSplitSeconds, defaults.audioSplitSeconds)));
        out.pinLabel = Math.max(0, Math.min(16, Math.round(num(raw.pinLabel, defaults.pinLabel))));
        out.sectionLabel = Math.max(0, Math.min(16,
            Math.round(num(raw.sectionLabel, defaults.sectionLabel))));
        out.reserveBytes = Math.max(0, num(raw.reserveBytes, defaults.reserveBytes));
        out.maxItemsPerPass = Math.max(1, Math.min(500,
            Math.round(num(raw.maxItemsPerPass, defaults.maxItemsPerPass))));

        /* A pin colour that also means "section" would make both meaningless. */
        if (out.pinLabel === out.sectionLabel) out.sectionLabel = defaults.sectionLabel;
        if (out.pinLabel === out.sectionLabel) out.sectionLabel = 0;

        if (raw.routes && typeof raw.routes === "object") {
            for (k in defaults.routes) {
                if (!defaults.routes.hasOwnProperty(k)) continue;
                out.routes[k] = sanitizeRoute(raw.routes[k], defaults.routes[k]);
            }
        }

        out.trustedPaths = [];
        if (isArrayLike(raw.trustedPaths)) {
            list = raw.trustedPaths;
            for (i = 0; i < list.length && i < 32; i++) {
                var p = host.slashes(str(list[i]));
                /* A bare drive root would exempt an entire disk from protection. */
                if (p.length > 3 && p.indexOf("/") > 0) out.trustedPaths.push(p);
            }
        }
        return out;
    }

    host.normalizeSettings = normalizeSettings;

    /* ------------------------------------------------------------ workspace */

    /*
     * Folder names that mean "the project file lives one level below the
     * workspace root". Taken from the owner's own trees: the AI Assistent
     * scaffold uses 04_edit, older projects use Edit / PRJ / PROJECT.
     */
    var EDIT_FOLDER_NAMES = ("04_edit edit edits editing 04_edits prj project projects " +
        "aep ae 05_shot_production").split(" ");

    function resolveWorkspace(projectPath) {
        var p = host.slashes(projectPath);
        if (!p) return { workspace: "", source: "none" };
        var editFolder = p.substring(0, p.lastIndexOf("/"));
        var editName = lower(editFolder.substring(editFolder.lastIndexOf("/") + 1));
        var parent = editFolder.substring(0, editFolder.lastIndexOf("/"));

        if (inList(EDIT_FOLDER_NAMES, editName) && parent) {
            return { workspace: parent, source: "edit-folder" };
        }
        return { workspace: editFolder, source: "project-folder" };
    }

    host.resolveWorkspace = resolveWorkspace;

    /*
     * Locations that must never become a workspace root. A project saved to the
     * Desktop or into Downloads would otherwise turn that whole folder into an
     * asset tree - which is exactly the folder the owner clears out.
     */
    /*
     * Resolved through the Folder constants rather than by matching names, so a
     * localised Windows (a Russian Desktop or Downloads, for instance) is caught
     * just as reliably as an English one. Each lookup is guarded separately: one
     * unavailable constant must not stop the remaining checks.
     */
    function systemRoots() {
        var roots = [], i;
        var probes = ["desktop", "myDocuments", "userData", "commonFiles", "system", "temp"];
        for (i = 0; i < probes.length; i++) {
            try {
                var f = Folder[probes[i]];
                if (f && f.fsName) roots.push(host.slashes(f.fsName));
            } catch (e) {}
        }
        try {
            var home = new Folder("~");
            if (home && home.fsName) {
                roots.push(host.slashes(home.fsName));
                roots.push(host.slashes(home.fsName) + "/Downloads");
            }
        } catch (e2) {}
        return roots;
    }

    function unsafeWorkspaceReason(workspace) {
        var w = host.slashes(workspace), lw = lower(w), i, roots;
        if (!w) return "The project has not been saved yet.";
        if (/^[a-z]:$/i.test(w) || /^[a-z]:\/$/i.test(w)) {
            return "A drive root cannot be a workspace.";
        }
        if (w.split("/").length < 2) return "The workspace path is too shallow.";

        roots = systemRoots();
        for (i = 0; i < roots.length; i++) {
            /*
             * Equality only. A workspace INSIDE the user profile is normal and
             * must stay allowed; the workspace BEING the profile, Desktop or
             * Downloads is what turns a whole folder into an asset tree.
             */
            if (lower(roots[i]) === lw) {
                return "This folder is a system location and cannot be a workspace.";
            }
        }

        var badFragment = ["/windows/", "/program files", "/programdata/",
            "/appdata/local/temp/", "/adobe after effects auto-save/",
            "/adobe premiere pro auto-save/", "/$recycle.bin/",
            "/system volume information/"];
        for (i = 0; i < badFragment.length; i++) {
            if ((lw + "/").indexOf(badFragment[i]) >= 0) {
                return "The project sits inside a protected system or Auto-Save location.";
            }
        }
        return "";
    }

    host.unsafeWorkspaceReason = unsafeWorkspaceReason;

    function settingsPath(workspace) {
        return host.slashes(workspace) + "/" + METADATA_FOLDER + "/settings.json";
    }

    function manifestPath(workspace) {
        return host.slashes(workspace) + "/" + METADATA_FOLDER + "/assets.tsv";
    }

    host.settingsPath = settingsPath;
    host.manifestPath = manifestPath;

    host.loadSettings = function (workspace) {
        if (!workspace) return defaultSettings();
        var raw = host.readTextFile(settingsPath(workspace));
        if (!raw) return defaultSettings();
        return normalizeSettings(host.jsonDecode(raw));
    };

    host.saveSettings = function (workspace, settings) {
        if (!workspace) return false;
        return host.writeTextFile(settingsPath(workspace),
            host.jsonEncode(normalizeSettings(settings)));
    };

    /* ------------------------------------------------- composition topology */

    /*
     * A render composition is one nothing else uses as a layer. That is a
     * structural fact, not a convention the owner has to maintain, so it is the
     * primary signal. Render-queue membership reinforces it for a comp that is
     * temporarily nested, and the pin label is the manual override.
     */
    function collectRenderComps(settings) {
        var marks = {}, i, item, queue, queueItem, comp;

        for (i = 1; i <= app.project.numItems; i++) {
            item = app.project.item(i);
            if (!host.isCompItem(item)) continue;
            try {
                if (!item.usedIn || item.usedIn.length === 0) { marks[item.id] = "orphan"; }
            } catch (e) {}
            try {
                if (settings.pinLabel > 0 && item.label === settings.pinLabel) {
                    marks[item.id] = "pinned";
                }
            } catch (e2) {}
        }

        try {
            queue = app.project.renderQueue;
            for (i = 1; i <= queue.numItems; i++) {
                queueItem = queue.item(i);
                comp = queueItem ? queueItem.comp : null;
                if (comp && !marks[comp.id]) marks[comp.id] = "render-queue";
            }
        } catch (e3) {}

        return marks;
    }

    host.collectRenderComps = collectRenderComps;

    function compParents(comp) {
        var out = [], usedIn, i;
        try { usedIn = comp.usedIn || []; } catch (e) { usedIn = []; }
        for (i = 0; i < usedIn.length; i++) {
            if (host.isCompItem(usedIn[i])) out.push(usedIn[i]);
        }
        return out;
    }

    /*
     * The branch of a composition is the composition directly below a render
     * composition on the path back up the tree. For the owner's usual shape -
     * MAIN -> section -> detail - that resolves to the section name, at any
     * depth, without guessing. A section label short-circuits the walk so the
     * owner can name a branch at a level the rule would not have picked.
     */
    function branchesForComp(comp, ctx, depth) {
        var key = "c" + comp.id, cached = ctx.memo[key];
        if (cached) return cached;
        if (depth > 12) return {};

        ctx.memo[key] = {};
        var out = {}, parents, i, parent, inherited, k;

        if (ctx.renderMarks[comp.id]) { ctx.memo[key] = out; return out; }

        if (ctx.settings.sectionLabel > 0) {
            var label = 0;
            try { label = comp.label; } catch (e) { label = 0; }
            if (label === ctx.settings.sectionLabel) {
                out[host.sanitizeSegment(comp.name) || "COMP"] = true;
                ctx.memo[key] = out;
                return out;
            }
        }

        parents = compParents(comp);
        if (parents.length === 0) {
            /* Unreachable in practice - usedIn 0 already made it a render comp. */
            out[host.sanitizeSegment(comp.name) || "COMP"] = true;
            ctx.memo[key] = out;
            return out;
        }

        for (i = 0; i < parents.length; i++) {
            parent = parents[i];
            if (ctx.renderMarks[parent.id]) {
                out[host.sanitizeSegment(comp.name) || "COMP"] = true;
                continue;
            }
            inherited = branchesForComp(parent, ctx, depth + 1);
            for (k in inherited) { if (inherited.hasOwnProperty(k)) out[k] = true; }
        }

        ctx.memo[key] = out;
        return out;
    }

    host.branchesForComp = branchesForComp;

    /* Collapses a branch set into the single folder name an item will use. */
    function resolveBranchName(set) {
        var names = [], k;
        for (k in set) { if (set.hasOwnProperty(k)) names.push(k); }
        if (names.length === 0) return "";
        if (names.length === 1) return names[0];
        return SHARED_BRANCH;
    }

    host.resolveBranchName = resolveBranchName;

    function branchForItem(item, ctx) {
        var out = {}, usedIn, i, comp, inherited, k;
        try { usedIn = item.usedIn || []; } catch (e) { usedIn = []; }

        for (i = 0; i < usedIn.length; i++) {
            comp = usedIn[i];
            if (!host.isCompItem(comp)) continue;
            if (ctx.renderMarks[comp.id]) {
                /*
                 * Footage dropped straight onto a render composition has no
                 * section to belong to. Naming the folder after the render comp
                 * would nest the whole project one level deeper for nothing.
                 */
                out[SHARED_BRANCH] = true;
                continue;
            }
            inherited = branchesForComp(comp, ctx, 0);
            for (k in inherited) { if (inherited.hasOwnProperty(k)) out[k] = true; }
        }
        return resolveBranchName(out);
    }

    host.branchForItem = branchForItem;

    /* Compositions are grouped by branch too, one level shallower than footage. */
    function branchForComp(comp, ctx) {
        if (ctx.renderMarks[comp.id]) return "";
        var own = host.sanitizeSegment(comp.name) || "COMP";
        var set = branchesForComp(comp, ctx, 0);
        var name = resolveBranchName(set);
        /* A comp that IS the branch sits at the top of the comps tree. */
        if (name === own) return "";
        return name;
    }

    host.branchForComp = branchForComp;

    $.global.PardDefenderHost = host;
})();
