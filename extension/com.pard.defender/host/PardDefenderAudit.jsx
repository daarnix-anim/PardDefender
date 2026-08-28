/*
 * PardDefender - the audit pass.
 *
 * Produces one JSON report describing what the project looks like right now:
 * where the workspace is, which compositions are render roots, which branch each
 * item belongs to, where every unprotected file should be copied, and where every
 * item should sit in the Project panel.
 *
 * The audit decides nothing about timing. It reports state; the client owns the
 * settle delay, the inbox timeout and the auto/manual switch.
 *
 * Loaded after PardDefenderPlan.jsx. ES3 only.
 */

(function () {
    var host = $.global.PardDefenderHost;
    if (!host) return;

    function str(v) {
        try { return (v === null || v === undefined) ? "" : String(v); }
        catch (e) { return ""; }
    }
    function lower(v) { return str(v).toLowerCase(); }

    function baseName(path) {
        var p = host.slashes(path), i = p.lastIndexOf("/");
        return i < 0 ? p : p.substring(i + 1);
    }

    function extensionOf(name) {
        var n = baseName(name), i = n.lastIndexOf(".");
        return i <= 0 ? "" : n.substring(i + 1).toLowerCase();
    }

    /* ------------------------------------------------------------ sequences */

    /*
     * An image footage item whose source is not a still is an image sequence.
     * The host reports the numbering pattern rather than the member list: Node
     * enumerates the folder far more cheaply, and it is the layer that will have
     * to copy every frame anyway.
     */
    function sequenceDescriptor(item, file) {
        var name = baseName(file.fsName);
        var match = /^(.*?)(\d+)(\.[^.]+)$/.exec(name);
        if (!match) return null;
        return {
            folder: host.slashes(file.parent ? file.parent.fsName : ""),
            prefix: match[1],
            padding: match[2].length,
            suffix: match[3],
            firstFrame: name
        };
    }

    function isSequenceItem(item, category) {
        if (category !== "image") return false;
        try {
            var source = item.mainSource;
            if (!source) return false;
            if (source.isStill === true) return false;
            return true;
        } catch (e) { return false; }
    }

    /* -------------------------------------------------------- audio routing */

    /*
     * Music and sound effects share one destination folder in the owner's tree,
     * split only by length: a short file is an effect, a long one is a track.
     * The threshold is a setting because it is a heuristic, not a fact.
     */
    function audioRouteKey(item, settings) {
        var duration = 0;
        try { duration = Number(item.duration) || 0; } catch (e) { duration = 0; }

        var name = lower(item.name);
        if (/(^|[^a-z])(vo|voice|voiceover|narration|dictor|speech)([^a-z]|$)/.test(name)) {
            return "voice";
        }
        if (/(^|[^a-z])(sfx|whoosh|impact|riser|swoosh|transition|foley|click|hit)/.test(name)) {
            return "sfx";
        }
        if (settings.audioSplitSeconds > 0 && duration > 0 &&
            duration < settings.audioSplitSeconds) {
            return "sfx";
        }
        return "music";
    }

    /* ---------------------------------------------------------- destination */

    function applyRoute(route, branch, name) {
        var out = host.slashes(route);
        out = out.replace(/\{branch\}/g, branch);
        out = out.replace(/\{name\}/g, name);
        /*
         * A branch that resolved to nothing leaves an empty segment behind.
         * Collapsing here keeps "01_assets//VIDEO" from ever reaching mkdir.
         */
        out = out.replace(/\/+/g, "/").replace(/^\//, "").replace(/\/$/, "");
        return out;
    }

    function routeKeyForItem(category, isSequence, item, settings) {
        if (category === "audio") return audioRouteKey(item, settings);
        if (isSequence) return "sequence";
        if (settings.routes.hasOwnProperty(category)) return category;
        return "other";
    }

    /* ------------------------------------------------------- panel topology */

    function managedNameSet(settings, branches) {
        var set = {}, k, i;
        set[host.PANEL_COMPS] = true;
        set[host.PANEL_ASSETS] = true;
        set[host.PANEL_AUDIO] = true;
        set[host.INBOX_BRANCH] = true;
        set[host.SHARED_BRANCH] = true;
        set.MUSIC = true;
        set.SFX = true;
        set.VOICE = true;
        for (k in host.CATEGORY_PANEL_NAME) {
            if (host.CATEGORY_PANEL_NAME.hasOwnProperty(k)) {
                set[host.CATEGORY_PANEL_NAME[k]] = true;
            }
        }
        for (i = 0; i < branches.length; i++) set[branches[i]] = true;
        return set;
    }

    /*
     * An item may be reorganised only from the Project root or from inside a
     * folder tree PardDefender itself created. Anything the owner filed by hand -
     * 02_ASSETS/IMAGES/Houses, or any folder of their own - is left alone
     * permanently. The pin label opts an item out from anywhere.
     */
    function panelEligible(item, settings, managed) {
        var label = 0, folder, depth = 0;
        try { label = item.label; } catch (e) { label = 0; }
        if (settings.pinLabel > 0 && label === settings.pinLabel) return false;

        try { folder = item.parentFolder; } catch (e2) { return false; }
        if (!folder) return false;
        if (folder === app.project.rootFolder) return true;

        while (folder && folder !== app.project.rootFolder && depth < 8) {
            if (!managed[str(folder.name)]) return false;
            try { folder = folder.parentFolder; } catch (e3) { return false; }
            depth++;
        }
        return folder === app.project.rootFolder;
    }

    function panelTargetForFootage(category, isSequence, routeKey, branch) {
        if (category === "audio") {
            var leaf = routeKey === "voice" ? "VOICE" : (routeKey === "sfx" ? "SFX" : "MUSIC");
            return host.PANEL_AUDIO + "/" + leaf;
        }
        var name = isSequence
            ? host.CATEGORY_PANEL_NAME.sequence
            : (host.CATEGORY_PANEL_NAME[category] || host.CATEGORY_PANEL_NAME.other);
        return host.PANEL_ASSETS + "/" + (branch || host.INBOX_BRANCH) + "/" + name;
    }

    /* ------------------------------------------------------------- the pass */

    host.audit = function () {
        var report = {
            ok: true,
            hostVersion: host.version,
            error: "",
            projectPath: "",
            projectSaved: false,
            workspace: "",
            workspaceSource: "",
            workspaceIssue: "",
            settings: null,
            renderComps: [],
            branches: [],
            items: [],
            comps: [],
            counts: {
                total: 0, protected_: 0, pending: 0, missing: 0,
                trusted: 0, unassigned: 0, panelMoves: 0
            }
        };

        try {
            if (!app.project) {
                report.ok = false;
                report.error = "No project is open.";
                return report;
            }

            var projectFile = app.project.file;
            if (!projectFile) {
                report.settings = host.defaultSettings();
                return report;
            }

            report.projectSaved = true;
            report.projectPath = host.slashes(projectFile.fsName);

            var resolved = host.resolveWorkspace(report.projectPath);
            report.workspace = resolved.workspace;
            report.workspaceSource = resolved.source;
            report.workspaceIssue = host.unsafeWorkspaceReason(resolved.workspace);

            var settings = host.loadSettings(report.workspace);
            report.settings = settings;
            if (report.workspaceIssue) return report;

            var ctx = {
                settings: settings,
                renderMarks: host.collectRenderComps(settings),
                memo: {}
            };

            var i, item, id, branchSet = {}, k;

            /* Pass one: compositions, so branch names are known before folders. */
            for (i = 1; i <= app.project.numItems; i++) {
                item = app.project.item(i);
                if (!host.isCompItem(item)) continue;
                id = str(item.id);

                if (ctx.renderMarks[item.id]) {
                    report.renderComps.push({
                        id: id,
                        name: str(item.name),
                        reason: ctx.renderMarks[item.id]
                    });
                    /*
                     * A render composition belongs at the Project root and is
                     * never filed away. It is reported so the panel pass can move
                     * it back out if a previous build had tucked it into COMPS.
                     */
                    report.comps.push({
                        id: id,
                        name: str(item.name),
                        isRender: true,
                        branch: "",
                        panelTarget: "",
                        eligible: true
                    });
                    continue;
                }

                var compBranch = host.branchForComp(item, ctx);
                var ownSet = host.branchesForComp(item, ctx, 0);
                for (k in ownSet) { if (ownSet.hasOwnProperty(k)) branchSet[k] = true; }

                report.comps.push({
                    id: id,
                    name: str(item.name),
                    isRender: false,
                    branch: compBranch,
                    panelTarget: compBranch
                        ? host.PANEL_COMPS + "/" + compBranch
                        : host.PANEL_COMPS,
                    eligible: true
                });
            }

            var branchNames = [];
            for (k in branchSet) { if (branchSet.hasOwnProperty(k)) branchNames.push(k); }
            branchNames.push(host.INBOX_BRANCH);
            branchNames.push(host.SHARED_BRANCH);
            report.branches = branchNames;

            var managed = managedNameSet(settings, branchNames);

            /* Pass two: footage. */
            for (i = 1; i <= app.project.numItems; i++) {
                item = app.project.item(i);
                if (!host.isFootageItem(item)) continue;

                var file = host.footageFile(item);
                if (!file) continue;

                report.counts.total++;

                var path = host.slashes(file.fsName);
                var ext = extensionOf(path);
                var category = host.categoryForExtension(ext);
                var isSequence = isSequenceItem(item, category);
                var branch = host.branchForItem(item, ctx);
                var routeKey = routeKeyForItem(category, isSequence, item, settings);

                var missing = false;
                try { missing = item.footageMissing === true || !file.exists; }
                catch (e4) { missing = true; }

                var state = "pending";
                if (missing) state = "missing";
                else if (report.workspace && host.isInside(path, report.workspace)) {
                    state = "protected";
                } else {
                    var t;
                    for (t = 0; t < settings.trustedPaths.length; t++) {
                        if (host.isInside(path, settings.trustedPaths[t])) {
                            state = "trusted";
                            break;
                        }
                    }
                }

                var size = 0;
                try { size = Number(file.length) || 0; } catch (e5) { size = 0; }

                var effectiveBranch = branch || host.INBOX_BRANCH;
                var sequenceInfo = isSequence ? sequenceDescriptor(item, file) : null;

                /*
                 * A sequence gets its own folder, named after the pattern rather
                 * than the first frame: "shot_a_00012.png" must produce
                 * SEQUENCES/shot_a, not SEQUENCES/shot_a_00012.
                 */
                var rawDestName = baseName(path).replace(/\.[^.]+$/, "");
                if (sequenceInfo) {
                    rawDestName = str(sequenceInfo.prefix).replace(/[._\- ]+$/, "");
                }
                var destName = host.sanitizeSegment(rawDestName) ||
                    (isSequence ? "SEQUENCE" : "FILE");
                var destRel = applyRoute(
                    settings.routes[routeKey] || settings.routes.other,
                    category === "audio" ? "" : effectiveBranch,
                    destName
                );

                var entry = {
                    id: str(item.id),
                    name: str(item.name),
                    path: path,
                    ext: ext,
                    category: category,
                    routeKey: routeKey,
                    isSequence: isSequence,
                    sequence: sequenceInfo,
                    branch: branch,
                    branchResolved: effectiveBranch,
                    unassigned: branch === "",
                    size: size,
                    state: state,
                    destRel: destRel,
                    destPath: report.workspace ? report.workspace + "/" + destRel : "",
                    panelTarget: panelTargetForFootage(
                        category, isSequence, routeKey, branch),
                    panelEligible: panelEligible(item, settings, managed),
                    hasProxy: false
                };

                try { entry.hasProxy = item.useProxy === true; } catch (e6) {}

                if (state === "pending") report.counts.pending++;
                else if (state === "protected") report.counts.protected_++;
                else if (state === "missing") report.counts.missing++;
                else if (state === "trusted") report.counts.trusted++;
                if (entry.unassigned) report.counts.unassigned++;

                report.items.push(entry);
            }

            /* Panel eligibility for compositions, now that `managed` exists. */
            for (i = 0; i < report.comps.length; i++) {
                var compItem = host.findItemById(report.comps[i].id);
                report.comps[i].eligible = compItem
                    ? panelEligible(compItem, settings, managed)
                    : false;
                if (report.comps[i].eligible) report.counts.panelMoves++;
            }
            for (i = 0; i < report.items.length; i++) {
                if (report.items[i].panelEligible) report.counts.panelMoves++;
            }
        } catch (error) {
            report.ok = false;
            report.error = str(error) + " (line " + str(error.line) + ")";
        }

        return report;
    };

    /*
     * The report can run to hundreds of kilobytes on a real project, so it goes
     * to a file and evalScript returns only the path. Passing it back as an
     * evalScript return value works until the day a project is large enough that
     * it silently truncates.
     */
    host.auditToFile = function () {
        var report = host.audit();
        var path = host.tempFolder() + "/audit.json";
        if (!host.writeTextFile(path, host.jsonEncode(report))) {
            return "ERROR|The audit report could not be written to " + path;
        }
        return "OK|" + path;
    };

    host.findItemById = function (id) {
        var wanted = str(id), i, item;
        for (i = 1; i <= app.project.numItems; i++) {
            item = app.project.item(i);
            if (item && str(item.id) === wanted) return item;
        }
        return null;
    };

    $.global.PardDefenderHost = host;
})();
