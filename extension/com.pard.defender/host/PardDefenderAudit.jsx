/*
 * PardDefender - the audit pass.
 *
 * @map role: Один проход по проекту → один JSON-отчёт: где что лежит,
 *           куда должно попасть на диске и в панели. Решений о времени
 *           не принимает.
 * @map status: ready
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

    /* " - proxy" in Russian. Host sources stay pure ASCII: $.evalFile does not
     * guarantee an encoding, and Cyrillic in a .jsx breaks silently. */
    var PROXY_SUFFIX = " \u2014 \u043f\u0440\u043e\u043a\u0441\u0438";

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

    function isSequenceSource(source, category) {
        if (category !== "image") return false;
        try {
            if (!source) return false;
            if (source.isStill === true) return false;
            return true;
        } catch (e) { return false; }
    }

    function isSequenceItem(item, category) {
        try { return isSequenceSource(item.mainSource, category); }
        catch (e) { return false; }
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
     * Where the item sits in the Project panel right now, as a "/" path from the
     * root. The client compares this against the target and drops the move when
     * they match. Without it every pass re-sends every eligible item, the host
     * dutifully skips them all as no-ops, and the pass reports "done" - which
     * schedules another audit, which builds the same moves again. That loop ran
     * 1873 times in thirteen minutes on a real project.
     */
    function panelPathOf(item) {
        var parts = [], folder, depth = 0;
        try { folder = item.parentFolder; } catch (e) { return ""; }
        while (folder && folder !== app.project.rootFolder && depth < 12) {
            parts.unshift(str(folder.name));
            try { folder = folder.parentFolder; } catch (e2) { break; }
            depth++;
        }
        return parts.join("/");
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
                trusted: 0, unassigned: 0, panelMoves: 0,
                misplaced: 0, adopted: 0, proxies: 0
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
                        panelPath: panelPathOf(item),
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
                    panelPath: panelPathOf(item),
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
                /*
                 * An element the owner sent to 00_UNUSED by hand is treated as
                 * unassigned even though a composition still uses it. That is
                 * the whole point of the action: the FILE moves out of the way
                 * while the layer stays exactly where it is.
                 */
                var forced = false, fu;
                for (fu = 0; fu < settings.forcedUnused.length; fu++) {
                    if (settings.forcedUnused[fu] === str(item.id)) { forced = true; break; }
                }
                var branch = forced ? "" : host.branchForItem(item, ctx);
                var routeKey = routeKeyForItem(category, isSequence, item, settings);

                /*
                 * A legacy project the owner told us to leave alone. The element
                 * keeps its file exactly where it is and never moves in the
                 * panel either - "do not touch" means both. New imports are
                 * unaffected: adoption is a line drawn at a moment in time, not
                 * a switch that turns protection off.
                 */
                var adopted = false, ad;
                for (ad = 0; ad < settings.adoptedItems.length; ad++) {
                    if (settings.adoptedItems[ad] === str(item.id)) { adopted = true; break; }
                }

                var missing = false;
                try { missing = item.footageMissing === true || !file.exists; }
                catch (e4) { missing = true; }

                var state = "pending";
                if (missing) state = "missing";
                else if (adopted) state = "trusted";
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
                    /*
                     * The identity the client keys everything by: tracking
                     * clocks, issue records, task results. One item can produce
                     * TWO rows - itself and its proxy - so the item id alone is
                     * no longer unique.
                     */
                    key: "i" + str(item.id),
                    id: str(item.id),
                    isProxy: false,
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
                    /*
                     * Forced elements look unassigned so they file into
                     * 00_UNUSED, but a composition still USES them - deleting
                     * one would tear a hole in the project. The cleanup button
                     * must be able to tell the two apart.
                     */
                    forcedUnused: forced,
                    size: size,
                    state: state,
                    destRel: destRel,
                    destFile: isSequence ? "" : baseName(path),
                    /*
                     * A route names a FOLDER. For an ordinary file the original
                     * file name has to be appended, or the copy lands as a file
                     * literally called "VIDEO" with no extension - which After
                     * Effects then refuses to relink, because a file with no
                     * extension is not a recognised type. A sequence is the one
                     * exception: its destination really is the folder, and the
                     * copy layer fills it frame by frame.
                     */
                    destPath: !report.workspace ? "" : (isSequence
                        ? report.workspace + "/" + destRel
                        : report.workspace + "/" + destRel + "/" + baseName(path)),
                    panelTarget: panelTargetForFootage(
                        category, isSequence, routeKey, branch),
                    panelPath: panelPathOf(item),
                    panelEligible: adopted
                        ? false
                        : panelEligible(item, settings, managed),
                    adopted: adopted,
                    hasProxy: false
                };

                try { entry.hasProxy = item.useProxy === true; } catch (e6) {}

                /*
                 * "Misplaced" compares FOLDERS, never whole paths. A copy that
                 * had to take a different name to avoid a collision is still
                 * exactly where it belongs; comparing names would report it as
                 * misplaced forever, and the legacy pass would copy it again on
                 * every run, each time under a new name.
                 */
                entry.misplaced = false;
                if (state === "protected" && entry.destPath) {
                    var destFolder = isSequence
                        ? entry.destPath
                        : entry.destPath.replace(/\/[^\/]*$/, "");
                    entry.misplaced =
                        lower(path.replace(/\/[^\/]*$/, "")) !== lower(destFolder);
                }

                if (entry.misplaced) report.counts.misplaced++;
                if (adopted) report.counts.adopted++;
                if (state === "pending") report.counts.pending++;
                else if (state === "protected") report.counts.protected_++;
                else if (state === "missing") report.counts.missing++;
                else if (state === "trusted") report.counts.trusted++;
                if (entry.unassigned) report.counts.unassigned++;

                report.items.push(entry);

                /*
                 * A proxy is a real file on a real disk and is lost exactly as
                 * easily as anything else, so it is protected too - but it is
                 * never a problem to report and never filed by format. Owner's
                 * decision, 2026-08-29: a proxy is an automatic exception that
                 * still moves inside the project, into the PROXY folder of the
                 * branch whose composition uses it.
                 */
                var proxySource = null, proxyFile = null;
                try {
                    if (item.useProxy === true && item.proxySource) {
                        proxySource = item.proxySource;
                        proxyFile = proxySource.file || null;
                    }
                } catch (eProxy) { proxySource = null; proxyFile = null; }

                if (proxyFile) {
                    var pPath = host.slashes(proxyFile.fsName);
                    var pExt = extensionOf(pPath);
                    var pCategory = host.categoryForExtension(pExt);
                    var pIsSequence = isSequenceSource(proxySource, pCategory);

                    var pMissing = false;
                    try { pMissing = !proxyFile.exists; } catch (eP1) { pMissing = true; }

                    var pState = "pending";
                    if (pMissing) pState = "missing";
                    else if (adopted) pState = "trusted";
                    else if (report.workspace && host.isInside(pPath, report.workspace)) {
                        pState = "protected";
                    } else {
                        var pt;
                        for (pt = 0; pt < settings.trustedPaths.length; pt++) {
                            if (host.isInside(pPath, settings.trustedPaths[pt])) {
                                pState = "trusted";
                                break;
                            }
                        }
                    }

                    var pSize = 0;
                    try { pSize = Number(proxyFile.length) || 0; } catch (eP2) { pSize = 0; }

                    var pSequence = pIsSequence
                        ? sequenceDescriptor(item, proxyFile)
                        : null;
                    var pRawName = baseName(pPath).replace(/\.[^.]+$/, "");
                    if (pSequence) {
                        pRawName = str(pSequence.prefix).replace(/[._\- ]+$/, "");
                    }
                    var pDestRel = applyRoute(
                        settings.routes.proxy || settings.routes.other,
                        effectiveBranch,
                        host.sanitizeSegment(pRawName) || "PROXY"
                    );
                    var pDestPath = !report.workspace ? "" : (pIsSequence
                        ? report.workspace + "/" + pDestRel
                        : report.workspace + "/" + pDestRel + "/" + baseName(pPath));

                    var pMisplaced = false;
                    if (pState === "protected" && pDestPath) {
                        var pDestFolder = pIsSequence
                            ? pDestPath
                            : pDestPath.replace(/\/[^\/]*$/, "");
                        pMisplaced =
                            lower(pPath.replace(/\/[^\/]*$/, "")) !== lower(pDestFolder);
                    }

                    report.counts.total++;
                    report.counts.proxies++;
                    if (pMisplaced) report.counts.misplaced++;
                    if (pState === "pending") report.counts.pending++;
                    else if (pState === "protected") report.counts.protected_++;
                    else if (pState === "missing") report.counts.missing++;
                    else if (pState === "trusted") report.counts.trusted++;

                    report.items.push({
                        key: "p" + str(item.id),
                        id: str(item.id),
                        isProxy: true,
                        name: str(item.name) + PROXY_SUFFIX,
                        path: pPath,
                        ext: pExt,
                        category: pCategory,
                        routeKey: "proxy",
                        isSequence: pIsSequence,
                        sequence: pSequence,
                        branch: branch,
                        branchResolved: effectiveBranch,
                        /*
                         * Never a cleanup candidate: a composition uses the
                         * element this proxy belongs to.
                         */
                        unassigned: false,
                        forcedUnused: false,
                        adopted: adopted,
                        size: pSize,
                        state: pState,
                        destRel: pDestRel,
                        destFile: pIsSequence ? "" : baseName(pPath),
                        destPath: pDestPath,
                        misplaced: pMisplaced,
                        /*
                         * A proxy is not an item in the Project panel - only the
                         * footage element it hangs off is.
                         */
                        panelTarget: "",
                        panelPath: "",
                        panelEligible: false,
                        hasProxy: false
                    });
                }
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
