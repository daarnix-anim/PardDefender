/*
 * PardDefender - the two mutating passes: relink and Project-panel organisation.
 *
 * @map role: \u0414\u0432\u0435 \u043c\u0443\u0442\u0438\u0440\u0443\u044e\u0449\u0438\u0435 \u043e\u043f\u0435\u0440\u0430\u0446\u0438\u0438: \u043f\u0435\u0440\u0435\u043b\u0438\u043d\u043a\u043e\u0432\u043a\u0430 \u043d\u0430 \u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d\u043d\u0443\u044e \u043a\u043e\u043f\u0438\u044e \u0441 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u0435\u043c \u0438\u043d\u0442\u0435\u0440\u043f\u0440\u0435\u0442\u0430\u0446\u0438\u0438 \u0438 \u0440\u0430\u0441\u043a\u043b\u0430\u0434\u043a\u0430 \u043f\u0430\u043d\u0435\u043b\u0438 \u043f\u0440\u043e\u0435\u043a\u0442\u0430.
 * @map status: ready
 *
 * Both run inside a single short undo group and both re-verify their inputs
 * immediately before touching anything. The client may have spent minutes
 * copying files since the audit that produced the plan, and the owner may have
 * edited the project in the meantime.
 *
 * Loaded after PardDefenderAudit.jsx. ES3 only.
 */

(function () {
    var host = $.global.PardDefenderHost;
    if (!host) return;

    function str(v) {
        try { return (v === null || v === undefined) ? "" : String(v); }
        catch (e) { return ""; }
    }

    /* --------------------------------------------------------- interpretation */

    /*
     * item.replace() resets footage interpretation to whatever After Effects
     * guesses for the new file. For a copy of the same bytes that guess is
     * usually right, but "usually" loses hand-set alpha and conformed frame
     * rates - the kind of damage nobody notices until the render. Each property
     * is read and restored in its own try block because several of them throw
     * outright on a still image.
     */
    function captureInterpretation(item) {
        var saved = {}, source;
        try { source = item.mainSource; } catch (e) { return saved; }
        if (!source) return saved;

        try { saved.alphaMode = source.alphaMode; } catch (e1) {}
        try { saved.premulColor = source.premulColor; } catch (e2) {}
        try { saved.invertAlpha = source.invertAlpha; } catch (e3) {}
        try { saved.conformFrameRate = source.conformFrameRate; } catch (e4) {}
        try { saved.loop = source.loop; } catch (e5) {}
        try { saved.fieldSeparationType = source.fieldSeparationType; } catch (e6) {}
        try {
            saved.highQualityFieldSeparation = source.highQualityFieldSeparation;
        } catch (e7) {}
        try { saved.removePulldown = source.removePulldown; } catch (e8) {}
        try { saved.name = item.name; } catch (e9) {}
        try { saved.label = item.label; } catch (e10) {}
        try { saved.comment = item.comment; } catch (e11) {}
        return saved;
    }

    function restoreInterpretation(item, saved) {
        var source;
        try { source = item.mainSource; } catch (e) { return; }
        if (!source) return;

        /* alphaMode first: premulColor is only meaningful once it is set. */
        if (saved.alphaMode !== undefined) {
            try { source.alphaMode = saved.alphaMode; } catch (e1) {}
        }
        if (saved.premulColor !== undefined) {
            try { source.premulColor = saved.premulColor; } catch (e2) {}
        }
        if (saved.invertAlpha !== undefined) {
            try { source.invertAlpha = saved.invertAlpha; } catch (e3) {}
        }
        if (saved.conformFrameRate !== undefined && saved.conformFrameRate > 0) {
            try { source.conformFrameRate = saved.conformFrameRate; } catch (e4) {}
        }
        if (saved.loop !== undefined && saved.loop > 0) {
            try { source.loop = saved.loop; } catch (e5) {}
        }
        if (saved.fieldSeparationType !== undefined) {
            try { source.fieldSeparationType = saved.fieldSeparationType; } catch (e6) {}
        }
        if (saved.highQualityFieldSeparation !== undefined) {
            try {
                source.highQualityFieldSeparation = saved.highQualityFieldSeparation;
            } catch (e7) {}
        }
        if (saved.removePulldown !== undefined) {
            try { source.removePulldown = saved.removePulldown; } catch (e8) {}
        }

        /* replace() renames the item after the new file. The owner may have
         * renamed it on purpose, so the project-panel name wins. */
        if (saved.name !== undefined && saved.name !== "") {
            try { item.name = saved.name; } catch (e9) {}
        }
        if (saved.label !== undefined) {
            try { item.label = saved.label; } catch (e10) {}
        }
        if (saved.comment !== undefined) {
            try { item.comment = saved.comment; } catch (e11) {}
        }
    }

    /* -------------------------------------------------------------- proxies */

    /*
     * A proxy survives item.replace() in most builds and is quietly dropped in
     * others, and there is no way to find out which without a live After
     * Effects. So it is captured before every main-source relink and put back
     * afterwards if it went missing. Restoring a proxy that never moved is a
     * no-op; not restoring one that was dropped costs the owner their proxy.
     */
    function proxyFileOf(item) {
        try {
            if (!item.proxySource) return null;
            return item.proxySource.file || null;
        } catch (e) { return null; }
    }

    function captureProxy(item) {
        var saved = { file: null, useProxy: false };
        try { saved.useProxy = item.useProxy === true; } catch (e) {}
        saved.file = proxyFileOf(item);
        return saved;
    }

    function restoreProxy(item, saved) {
        if (!saved || !saved.file) return;
        if (proxyFileOf(item) === null) {
            try { item.setProxy(saved.file); } catch (e) { return; }
        }
        try { item.useProxy = saved.useProxy; } catch (e2) {}
    }

    /* ------------------------------------------------------------- relinking */

    function isLayeredCandidate(path) {
        return /\.(psd|psb|ai)$/i.test(path || "");
    }

    function canImportCroppedLayers(destinationFile) {
        try {
            if (typeof ImportOptions === "undefined") {
                return false;
            }
            var io = new ImportOptions();
            io.file = destinationFile;
            if (typeof io.canImportAs === "function" && typeof ImportAsType !== "undefined") {
                if (io.canImportAs(ImportAsType.COMP_CROPPED_LAYERS) === true) return true;
                if (io.canImportAs(ImportAsType.COMP) === true) return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function extractCoreLayerName(fullName, fileName) {
        var s = host.trimText(str(fullName)).toLowerCase();
        if (!s) return "";
        var fName = host.trimText(str(fileName || "")).toLowerCase();
        var fBase = fName.replace(/\.[^.]+$/, "");

        /*
         * After Effects names PSD/AI layer items as "LayerName/filename.psd".
         * Extract the layer part before the slash when this pattern is present.
         * Note that fileName may have duplicate suffix e.g. "01 (11).psd", while
         * the original item is named "LayerName/01.psd".
         */
        var slashIdx = s.indexOf("/");
        if (slashIdx === -1) slashIdx = s.indexOf("\\");
        if (slashIdx > 0) {
            var afterSlash = s.substring(slashIdx + 1);
            var cleanAfter = afterSlash.replace(/\s*\(\d+\)/g, "");
            var cleanBase = fBase.replace(/\s*\(\d+\)/g, "");
            if (/\.(psd|psb|ai|eps|pdf)$/i.test(afterSlash) ||
                afterSlash === fName || afterSlash === fBase ||
                cleanAfter === cleanBase || (fBase && afterSlash.indexOf(fBase) !== -1)) {
                s = host.trimText(s.substring(0, slashIdx));
            }
        }

        if (fName && s.indexOf(fName) !== -1) {
            s = s.split(fName).join(" ");
        }
        if (fBase && fBase.length > 1 && s.indexOf(fBase) !== -1) {
            s = s.split(fBase).join(" ");
        }
        s = s.replace(/[\/\\\[\]\(\)\-_]/g, " ");
        return host.trimText(s.replace(/\s+/g, " "));
    }

    function matchLayerCandidate(item, candidates, fileName) {
        var cleanOld = host.trimText(str(item.name)).toLowerCase();
        var coreOld = extractCoreLayerName(item.name, fileName);
        var itemW = item.width || 0;
        var itemH = item.height || 0;
        var i, c, cleanCand, candSource, coreCand, coreSource;

        var sourceNameOld = "";
        try { sourceNameOld = host.trimText(str(item.mainSource.name || "")).toLowerCase(); }
        catch (eSrc) { sourceNameOld = ""; }

        function checkNameMatch(cand) {
            cleanCand = host.trimText(str(cand.name)).toLowerCase();
            candSource = host.trimText(str(cand.sourceName || "")).toLowerCase();
            coreCand = extractCoreLayerName(cand.name, fileName);
            coreSource = extractCoreLayerName(cand.sourceName, fileName);

            return (cleanOld === cleanCand || cleanOld === candSource ||
                (sourceNameOld && (sourceNameOld === cleanCand || sourceNameOld === candSource ||
                    sourceNameOld === coreCand || sourceNameOld === coreSource)) ||
                (coreOld && (coreOld === coreCand || coreOld === coreSource || coreOld === cleanCand)) ||
                cleanOld.indexOf(cleanCand + "/") === 0 || cleanOld.indexOf(cleanCand + "\\") === 0 ||
                candSource.indexOf(coreOld + "/") === 0 || candSource.indexOf(coreOld + "\\") === 0 ||
                cleanOld.indexOf("/" + cleanCand) !== -1 || cleanOld.indexOf("\\" + cleanCand) !== -1);
        }

        /* Pass 1: UNUSED candidate with exact name (or core name) AND dimensions match */
        for (i = 0; i < candidates.length; i++) {
            c = candidates[i];
            if (c.used) continue;
            if (checkNameMatch(c) && itemW > 0 && itemH > 0 && c.width === itemW && c.height === itemH) {
                return c;
            }
        }

        /* Pass 1B: ALREADY-USED candidate with exact name AND dimensions match.
         * When a project contains duplicate footage items referencing the same layer of the PSD
         * (e.g. from multiple imports or across different comps), all candidates of that layer
         * may already be marked used. Reusing the matching source is 100% safe because the
         * name and pixel dimensions are identical. */
        for (i = 0; i < candidates.length; i++) {
            c = candidates[i];
            if (!c.used) continue;
            if (checkNameMatch(c) && itemW > 0 && itemH > 0 && c.width === itemW && c.height === itemH) {
                return c;
            }
        }

        /* Pass 2: UNUSED candidate with exact core name, full name, or source name match */
        for (i = 0; i < candidates.length; i++) {
            c = candidates[i];
            if (c.used) continue;
            if (checkNameMatch(c)) {
                return c;
            }
        }

        /* Pass 2B: ALREADY-USED candidate where name uniquely identifies the layer in the PSD.
         * If there is only ONE candidate in the entire PSD with this name (e.g. "Hands"),
         * any additional project items referencing this layer can safely reuse it. */
        var uniqueNameCand = null, uniqueNameCount = 0;
        for (i = 0; i < candidates.length; i++) {
            if (checkNameMatch(candidates[i])) {
                uniqueNameCount++;
                uniqueNameCand = candidates[i];
            }
        }
        if (uniqueNameCount === 1 && uniqueNameCand) {
            return uniqueNameCand;
        }

        /* Pass 3: UNUSED candidate with unique exact dimensions match */
        if (itemW > 0 && itemH > 0) {
            var dimCand = null, dimCount = 0;
            for (i = 0; i < candidates.length; i++) {
                c = candidates[i];
                if (c.used) continue;
                if (c.width === itemW && c.height === itemH) {
                    dimCount++;
                    dimCand = c;
                }
            }
            if (dimCount === 1 && dimCand) {
                return dimCand;
            }
        }

        /* Pass 4: substring name match (unused candidates only) */
        for (i = 0; i < candidates.length; i++) {
            c = candidates[i];
            if (c.used) continue;
            cleanCand = host.trimText(str(c.name)).toLowerCase();
            coreCand = extractCoreLayerName(c.name, fileName);
            if ((cleanCand.length > 2 && (cleanOld.indexOf(cleanCand) !== -1 || cleanCand.indexOf(cleanOld) !== -1)) ||
                (coreOld && coreCand && coreCand.length > 2 && (coreOld.indexOf(coreCand) !== -1 || coreCand.indexOf(coreOld) !== -1))) {
                return c;
            }
        }

        /* Pass 5: ALREADY-USED candidate matching name when multiple same-named layers exist.
         * If all candidates of this name are already marked used and dimensions did not
         * disambiguate, reuse the first matching candidate rather than failing with LAYER_MATCH_FAILED. */
        for (i = 0; i < candidates.length; i++) {
            c = candidates[i];
            if (checkNameMatch(c)) {
                return c;
            }
        }

        /*
         * No fallback pass. If no match was found by name or dimensions,
         * return null rather than grabbing an arbitrary unused candidate.
         * A wrong match is far worse than no match: it replaces the layer
         * source with the wrong PSD layer, causing merged/swapped visuals.
         */

        return null;
    }

    function relinkLayeredGroup(destination, groupEntries, result) {
        var io, tempComp = null, tempFolder = null;
        try {
            io = new ImportOptions(destination);
            io.file = destination;
            io.sequence = false;
            if (typeof ImportAsType !== "undefined" && typeof io.canImportAs === "function") {
                if (io.canImportAs(ImportAsType.COMP_CROPPED_LAYERS)) {
                    io.importAs = ImportAsType.COMP_CROPPED_LAYERS;
                } else if (io.canImportAs(ImportAsType.COMP)) {
                    io.importAs = ImportAsType.COMP;
                }
            } else if (typeof ImportAsType !== "undefined") {
                io.importAs = ImportAsType.COMP_CROPPED_LAYERS;
            }
            tempComp = app.project.importFile(io);
        } catch (eImport) {
            tempComp = null;
        }

        if (!tempComp || typeof tempComp.numLayers !== "number" || tempComp.numLayers < 1) {
            try { if (tempComp) tempComp.remove(); } catch (eRem) {}
            return false;
        }

        var newLayers = [], k, l;
        try {
            for (k = 1; k <= tempComp.numLayers; k++) {
                l = tempComp.layer(k);
                if (l && l.source) {
                    newLayers.push({
                        name: str(l.name),
                        sourceName: str(l.source.name),
                        source: l.source,
                        width: l.source.width || 0,
                        height: l.source.height || 0,
                        used: false
                    });
                    if (!tempFolder && l.source.parentFolder && l.source.parentFolder !== app.project.rootFolder) {
                        tempFolder = l.source.parentFolder;
                    }
                }
            }
        } catch (eLayers) {
            try { tempComp.remove(); } catch (eRemComp) {}
            return false;
        }

        var g, entry, item, file, currentPath;
        var fileName = destination ? destination.name : "";
        for (g = 0; g < groupEntries.length; g++) {
            entry = groupEntries[g];
            item = host.findItemById(entry.id);

            if (!item || !host.isFootageItem(item)) {
                result.skipped++;
                result.failures.push({
                    key: str(entry.key),
                    id: str(entry.id),
                    code: "RELINK_ITEM_GONE",
                    reason: "The item is no longer in the project."
                });
                continue;
            }

            file = host.footageFile(item);
            currentPath = file ? host.slashes(file.fsName) : "";
            if (entry.expectPath &&
                currentPath.toLowerCase() !== host.slashes(entry.expectPath).toLowerCase()) {
                result.skipped++;
                result.failures.push({
                    key: str(entry.key),
                    id: str(entry.id),
                    code: "RELINK_SOURCE_CHANGED",
                    reason: "The source changed after the audit; left untouched."
                });
                continue;
            }

            var cand = matchLayerCandidate(item, newLayers, fileName);
            if (!cand || !cand.source) {
                var hasLayerSlash = item.name.indexOf("/") !== -1 || item.name.indexOf("\\") !== -1;
                var coreName = extractCoreLayerName(item.name, fileName);
                /* If the item is a flat (merged) footage item of the PSD itself
                 * (e.g. "01.psd" rather than "Layer/01.psd"), it does not correspond
                 * to an individual cropped layer in tempComp. For flat footage items,
                 * item.replace() is the correct, safe relinking path that preserves
                 * the item's footage source without flattening any layer hierarchy. */
                if (!hasLayerSlash || !coreName) {
                    try {
                        var savedInterp = captureInterpretation(item);
                        var savedPrx = captureProxy(item);
                        item.replace(destination);
                        restoreInterpretation(item, savedInterp);
                        restoreProxy(item, savedPrx);
                        result.relinked++;
                        continue;
                    } catch (eFlatReplace) {}
                }

                result.skipped++;
                result.failures.push({
                    key: str(entry.key),
                    id: str(entry.id),
                    code: "LAYER_MATCH_FAILED",
                    reason: "Could not find matching layer in imported file for " + str(item.name) + "; left untouched."
                });
                continue;
            }

            cand.used = true;
            var newSource = cand.source;
            var saved = captureInterpretation(item);
            var savedProxy = captureProxy(item);
            var oldParent = item.parentFolder;
            var oldName = item.name;
            var oldLabel = item.label;
            var oldComment = item.comment;

            /* Repoint layers across ALL comps in the project, handling locked layers safely.
             * Capture and restore transform properties (position, anchorPoint, scale)
             * because replaceSource on a cropped-layer item can reset the layer's
             * internal position offset, causing layers to jump from their correct
             * placement in the composition. */
            for (var p = 1; p <= app.project.numItems; p++) {
                var pItem = app.project.item(p);
                if (host.isCompItem(pItem) && pItem !== tempComp) {
                    for (var cl = 1; cl <= pItem.numLayers; cl++) {
                        try {
                            var cLayer = pItem.layer(cl);
                            if (cLayer && cLayer.source === item) {
                                var wasLocked = false;
                                try { wasLocked = cLayer.locked; if (wasLocked) cLayer.locked = false; } catch (eLock) {}

                                /* Capture transform before replaceSource */
                                var savedPos = null, savedAnchor = null, savedScale = null;
                                try {
                                    var xform = cLayer.property("ADBE Transform Group");
                                    if (xform) {
                                        try { savedPos = xform.property("ADBE Position").value; } catch (ePos) {}
                                        try { savedAnchor = xform.property("ADBE Anchor Point").value; } catch (eAnc) {}
                                        try { savedScale = xform.property("ADBE Scale").value; } catch (eSc) {}
                                    }
                                } catch (eXform) {}

                                cLayer.replaceSource(newSource, false);

                                /* Restore transform after replaceSource */
                                try {
                                    var xform2 = cLayer.property("ADBE Transform Group");
                                    if (xform2) {
                                        if (savedPos) try { xform2.property("ADBE Position").setValue(savedPos); } catch (eRP) {}
                                        if (savedAnchor) try { xform2.property("ADBE Anchor Point").setValue(savedAnchor); } catch (eRA) {}
                                        if (savedScale) try { xform2.property("ADBE Scale").setValue(savedScale); } catch (eRS) {}
                                    }
                                } catch (eXform2) {}

                                try { if (wasLocked) cLayer.locked = true; } catch (eRelock) {}
                            }
                        } catch (eRep) {}
                    }
                }
            }

            try { newSource.parentFolder = oldParent; } catch (eP) {}
            try { newSource.name = oldName; } catch (eN) {}
            try { newSource.label = oldLabel; } catch (eL) {}
            try { newSource.comment = oldComment; } catch (eC) {}
            restoreInterpretation(newSource, saved);
            restoreProxy(newSource, savedProxy);

            try { item.remove(); } catch (eR) {}
            result.relinked++;
        }

        try { tempComp.remove(); } catch (eTC) {}

        for (var u = 0; u < newLayers.length; u++) {
            if (!newLayers[u].used && newLayers[u].source) {
                try { newLayers[u].source.remove(); } catch (eRem) {}
            }
        }

        if (tempFolder) {
            var isEmpty = true;
            for (var f = 1; f <= app.project.numItems; f++) {
                if (app.project.item(f).parentFolder === tempFolder) {
                    isEmpty = false;
                    break;
                }
            }
            if (isEmpty) {
                try { tempFolder.remove(); } catch (eTF) {}
            }
        }

        return true;
    }


    /*
     * Plan shape (written by the client after every copy has been verified):
     *   { "items": [ { "key": "i12", "id": "12", "isProxy": false,
     *                  "expectPath": "...", "destPath": "...",
     *                  "isSequence": false } ] }
     *
     * expectPath is the source path the audit saw. If the item no longer points
     * there, something changed between audit and commit and this entry is
     * skipped rather than relinked on an assumption.
     *
     * An entry with isProxy addresses the item's PROXY rather than its main
     * source: same protocol, same verification, setProxy instead of replace.
     * One item can therefore appear twice in a plan, which is why every entry
     * carries its own key.
     */
    host.commitFromFile = function (planPath) {
        var result = { ok: true, relinked: 0, skipped: 0, failures: [], error: "" };
        var raw = host.readTextFile(planPath);
        if (!raw) {
            result.ok = false;
            result.error = "The relink plan could not be read: " + str(planPath);
            return result;
        }

        var plan = host.jsonDecode(raw);
        if (!plan || !host.isArrayLike(plan.items)) {
            result.ok = false;
            result.error = "The relink plan is malformed.";
            return result;
        }

        var undoStarted = false;
        try {
            app.beginUndoGroup("PardDefender: Relink protected sources");
            undoStarted = true;

            var i, entry, item, file, currentPath, saved;
            var handledKeys = {};

            for (i = 0; i < plan.items.length; i++) {
                entry = plan.items[i];
                var entryKey = entry.key || ("i" + entry.id);
                if (handledKeys[entryKey]) continue;

                var isSeq = entry.isSequence === true;
                var isPrx = entry.isProxy === true;
                var destPathNorm = host.slashes(entry.destPath || "");

                /*
                 * Layered files (.psd, .psb, .ai): item.replace() resets the footage
                 * to "Merged Layers" (flattened composite), destroying individual layer
                 * selections and alpha transparency. When ImportOptions supports
                 * COMP_CROPPED_LAYERS, import once and repoint comp layers to the
                 * corresponding cropped layer sources.
                 */
                if (!isSeq && !isPrx && (isLayeredCandidate(destPathNorm) || isLayeredCandidate(entry.expectPath))) {
                    var destFileCandidate = new File(destPathNorm);
                    if (!destFileCandidate.exists) {
                        result.skipped++;
                        result.failures.push({
                            key: str(entry.key),
                            id: str(entry.id),
                            code: "RELINK_MISSING_COPY",
                            reason: "The verified copy is missing: " + str(entry.destPath)
                        });
                        handledKeys[entryKey] = true;
                        continue;
                    }

                    var groupEntries = [];
                    var gIdx;
                    for (gIdx = i; gIdx < plan.items.length; gIdx++) {
                        var other = plan.items[gIdx];
                        if (other.isProxy !== true && other.isSequence !== true &&
                            host.slashes(other.destPath || "").toLowerCase() === destPathNorm.toLowerCase()) {
                            groupEntries.push(other);
                            handledKeys[other.key || ("i" + other.id)] = true;
                        }
                    }

                    if (relinkLayeredGroup(destFileCandidate, groupEntries, result)) {
                        continue;
                    }

                    /* If layered import failed, DO NOT fall back to item.replace()!
                     * item.replace flattens all layers into a single merged composite, ruining alpha and positions. */
                    for (gIdx = 0; gIdx < groupEntries.length; gIdx++) {
                        result.skipped++;
                        result.failures.push({
                            key: str(groupEntries[gIdx].key),
                            id: str(groupEntries[gIdx].id),
                            code: "LAYERED_RELINK_FAILED",
                            reason: "Layered import failed for " + str(destPathNorm) + "; layers left untouched to prevent merging."
                        });
                    }
                    continue;
                }

                item = host.findItemById(entry.id);

                if (!item || !host.isFootageItem(item)) {
                    result.skipped++;
                    result.failures.push({
                        key: str(entry.key),
                        id: str(entry.id),
                        code: "RELINK_ITEM_GONE",
                        reason: "The item is no longer in the project."
                    });
                    continue;
                }

                file = entry.isProxy === true
                    ? proxyFileOf(item)
                    : host.footageFile(item);
                currentPath = file ? host.slashes(file.fsName) : "";
                if (entry.isProxy === true && !file) {
                    result.skipped++;
                    result.failures.push({
                        key: str(entry.key),
                        id: str(entry.id),
                        code: "PROXY_GONE",
                        reason: "The item no longer has a proxy."
                    });
                    continue;
                }
                if (entry.expectPath &&
                    currentPath.toLowerCase() !== host.slashes(entry.expectPath).toLowerCase()) {
                    result.skipped++;
                    result.failures.push({
                        key: str(entry.key),
                        id: str(entry.id),
                        code: "RELINK_SOURCE_CHANGED",
                        reason: "The source changed after the audit; left untouched."
                    });
                    continue;
                }

                var destination = new File(host.slashes(entry.destPath));
                if (!destination.exists) {
                    result.skipped++;
                    result.failures.push({
                        key: str(entry.key),
                        id: str(entry.id),
                        code: "RELINK_MISSING_COPY",
                        reason: "The verified copy is missing: " + str(entry.destPath)
                    });
                    continue;
                }

                /*
                 * Until 1.1.0 a proxied item was refused here and reported as a
                 * permanent problem the owner could do nothing about. Owner's
                 * decision, 2026-08-29: a proxy is an automatic exception, not a
                 * fault - it is repointed at its own verified copy exactly like
                 * any other file, using setProxy instead of replace.
                 */
                if (entry.isProxy === true) {
                    var wasUsing = false;
                    try { wasUsing = item.useProxy === true; } catch (eUse) {}
                    try {
                        if (entry.isSequence === true) {
                            item.setProxyWithSequence(destination, false);
                        } else {
                            item.setProxy(destination);
                        }
                        try { item.useProxy = wasUsing; } catch (eUse2) {}
                        result.relinked++;
                    } catch (proxyError) {
                        result.failures.push({
                            key: str(entry.key),
                            id: str(entry.id),
                            code: "PROXY_REJECTED",
                            reason: str(proxyError)
                        });
                    }
                    continue;
                }

                saved = captureInterpretation(item);
                var savedProxy = captureProxy(item);
                try {
                    if (entry.isSequence === true) {
                        item.replaceWithSequence(destination, false);
                    } else {
                        item.replace(destination);
                    }
                    restoreInterpretation(item, saved);
                    restoreProxy(item, savedProxy);
                    result.relinked++;
                } catch (relinkError) {
                    result.failures.push({
                        key: str(entry.key),
                        id: str(entry.id),
                        code: "RELINK_REJECTED",
                        reason: str(relinkError)
                    });
                }
            }
        } catch (error) {
            result.ok = false;
            result.error = str(error) + " (line " + str(error.line) + ")";
        }

        if (undoStarted) { try { app.endUndoGroup(); } catch (e2) {} }
        return result;
    };

    host.commitFromFileJson = function (planPath) {
        return host.jsonEncode(host.commitFromFile(planPath));
    };

    /* ------------------------------------------------ Project-panel folders */

    function childFolderNamed(parent, name) {
        var i, item;
        for (i = 1; i <= app.project.numItems; i++) {
            item = app.project.item(i);
            if (!host.isFolderItem(item)) continue;
            if (item.parentFolder !== parent) continue;
            if (str(item.name) === str(name)) return item;
        }
        return null;
    }

    function ensureFolderPath(pathText) {
        var segments = host.slashes(pathText).split("/");
        var parent = app.project.rootFolder, i, name, folder;
        for (i = 0; i < segments.length; i++) {
            name = host.trimText(segments[i]);
            if (!name) continue;
            folder = childFolderNamed(parent, name);
            if (!folder) {
                folder = app.project.items.addFolder(name);
                folder.parentFolder = parent;
            }
            parent = folder;
        }
        return parent;
    }

    host.ensureFolderPath = ensureFolderPath;

    /*
     * Plan shape:
     *   { "moves": [ { "id": "12", "target": "02_ASSETS/Intro/VIDEO" } ],
     *     "prune": true }
     *
     * An empty target means the Project root, which is how a render composition
     * is pulled back out of COMPS if an earlier pass had filed it away.
     */
    host.organizeFromFile = function (planPath) {
        var result = { ok: true, moved: 0, pruned: 0, skipped: 0, error: "" };
        var raw = host.readTextFile(planPath);
        if (!raw) {
            result.ok = false;
            result.error = "The organisation plan could not be read: " + str(planPath);
            return result;
        }

        var plan = host.jsonDecode(raw);
        if (!plan || !host.isArrayLike(plan.moves)) {
            result.ok = false;
            result.error = "The organisation plan is malformed.";
            return result;
        }

        var undoStarted = false;
        try {
            app.beginUndoGroup("PardDefender: Organise project panel");
            undoStarted = true;

            var i, move, item, target;
            for (i = 0; i < plan.moves.length; i++) {
                move = plan.moves[i];
                item = host.findItemById(move.id);
                if (!item || host.isFolderItem(item)) { result.skipped++; continue; }

                target = host.trimText(move.target)
                    ? ensureFolderPath(move.target)
                    : app.project.rootFolder;

                if (item.parentFolder === target) { result.skipped++; continue; }
                try {
                    item.parentFolder = target;
                    result.moved++;
                } catch (moveError) {
                    result.skipped++;
                }
            }

            if (plan.prune === true) result.pruned = pruneEmptyManagedFolders();
        } catch (error) {
            result.ok = false;
            result.error = str(error) + " (line " + str(error.line) + ")";
        }

        if (undoStarted) { try { app.endUndoGroup(); } catch (e2) {} }
        return result;
    };

    host.organizeFromFileJson = function (planPath) {
        return host.jsonEncode(host.organizeFromFile(planPath));
    };

    /*
     * Only folders PardDefender could have created, only when they hold nothing
     * at all, and only inside our three managed roots. A folder the owner made
     * is never a candidate even if it happens to be empty right now.
     */
    function pruneEmptyManagedFolders() {
        var roots = [host.PANEL_COMPS, host.PANEL_ASSETS, host.PANEL_AUDIO];
        var removed = 0, pass, i, item, changed = true;

        function insideManagedRoot(folder) {
            var current = folder, depth = 0, name;
            while (current && current !== app.project.rootFolder && depth < 8) {
                name = str(current.name);
                if (current.parentFolder === app.project.rootFolder) {
                    return (name === roots[0] || name === roots[1] || name === roots[2]);
                }
                current = current.parentFolder;
                depth++;
            }
            return false;
        }

        function isEmptyFolder(folder) {
            var j;
            for (j = 1; j <= app.project.numItems; j++) {
                if (app.project.item(j).parentFolder === folder) return false;
            }
            return true;
        }

        /* Removing a leaf can empty its parent, so repeat until stable. */
        for (pass = 0; pass < 6 && changed; pass++) {
            changed = false;
            for (i = app.project.numItems; i >= 1; i--) {
                item = app.project.item(i);
                if (!host.isFolderItem(item)) continue;
                if (item.parentFolder === app.project.rootFolder) continue;
                if (!insideManagedRoot(item)) continue;
                if (!isEmptyFolder(item)) continue;
                try { item.remove(); removed++; changed = true; } catch (e) {}
            }
        }
        return removed;
    }

    /* ------------------------------------------------------------- settings */

    host.readSettingsJson = function () {
        var projectFile = app.project ? app.project.file : null;
        if (!projectFile) {
            return host.jsonEncode({
                ok: false,
                error: "The project has not been saved yet.",
                settings: host.defaultSettings()
            });
        }
        var workspace = host.resolveWorkspace(host.slashes(projectFile.fsName)).workspace;
        return host.jsonEncode({
            ok: true,
            workspace: workspace,
            settings: host.loadSettings(workspace)
        });
    };

    host.writeSettingsFromFile = function (planPath) {
        var raw = host.readTextFile(planPath);
        var projectFile = app.project ? app.project.file : null;
        if (!projectFile) {
            return host.jsonEncode({ ok: false, error: "The project has not been saved yet." });
        }
        if (!raw) {
            return host.jsonEncode({ ok: false, error: "The settings payload could not be read." });
        }
        var workspace = host.resolveWorkspace(host.slashes(projectFile.fsName)).workspace;
        var settings = host.normalizeSettings(host.jsonDecode(raw));
        var written = host.saveSettings(workspace, settings);
        return host.jsonEncode({
            ok: written,
            error: written ? "" : "The settings file could not be written.",
            workspace: workspace,
            settings: settings
        });
    };

    /* ---------------------------------------------------------------- misc */

    host.revealWorkspace = function () {
        var projectFile = app.project ? app.project.file : null;
        if (!projectFile) return "ERROR|The project has not been saved yet.";
        var workspace = host.resolveWorkspace(host.slashes(projectFile.fsName)).workspace;
        var folder = new Folder(workspace);
        if (!folder.exists) return "ERROR|The workspace folder does not exist: " + workspace;
        try { folder.execute(); } catch (e) { return "ERROR|" + str(e); }
        return "OK|" + workspace;
    };

    /*
     * Selecting an item is what makes the Project panel scroll to it and
     * highlight it. Everything already selected is cleared first, otherwise the
     * panel keeps the old highlight and the owner cannot tell which row is the
     * answer.
     *
     * There is no ExtendScript call that expands a collapsed folder, so the
     * folder path is returned too: when After Effects does not scroll to a row
     * buried inside a collapsed folder, the panel can at least say where to look.
     */
    host.selectItemById = function (id) {
        var item = host.findItemById(id), i, current;
        if (!item) return "ERROR|The item is no longer in the project.";
        try {
            current = app.project.selection || [];
            for (i = 0; i < current.length; i++) {
                try { current[i].selected = false; } catch (eDeselect) {}
            }
            item.selected = true;
        } catch (e) { return "ERROR|" + str(e); }

        var parts = [], folder = null, depth = 0;
        try { folder = item.parentFolder; } catch (eFolder) { folder = null; }
        while (folder && folder !== app.project.rootFolder && depth < 12) {
            parts.unshift(str(folder.name));
            try { folder = folder.parentFolder; } catch (eUp) { break; }
            depth++;
        }
        return "OK|" + str(item.name) + "|" + parts.join("/");
    };

    /*
     * Removes items from the Project panel after their files have been dealt
     * with on disk. Only ids the client explicitly listed are touched, and each
     * one is re-checked: an item that acquired a use since the audit is left
     * alone rather than removed on a stale assumption.
     */
    host.removeItemsFromFile = function (planPath) {
        var result = { ok: true, removed: 0, skipped: 0, error: "" };
        var raw = host.readTextFile(planPath);
        if (!raw) {
            result.ok = false;
            result.error = "The removal plan could not be read.";
            return result;
        }

        var plan = host.jsonDecode(raw);
        if (!plan || !host.isArrayLike(plan.ids)) {
            result.ok = false;
            result.error = "The removal plan is malformed.";
            return result;
        }

        var undoStarted = false;
        try {
            app.beginUndoGroup("PardDefender: Remove unused footage");
            undoStarted = true;

            var i, item, usedIn;
            for (i = 0; i < plan.ids.length; i++) {
                item = host.findItemById(plan.ids[i]);
                if (!item || !host.isFootageItem(item)) { result.skipped++; continue; }

                try { usedIn = item.usedIn || []; } catch (eUsed) { usedIn = null; }
                if (!usedIn || usedIn.length > 0) { result.skipped++; continue; }

                try { item.remove(); result.removed++; }
                catch (eRemove) { result.skipped++; }
            }
        } catch (error) {
            result.ok = false;
            result.error = str(error) + " (line " + str(error.line) + ")";
        }

        if (undoStarted) { try { app.endUndoGroup(); } catch (e2) {} }
        return result;
    };

    host.removeItemsFromFileJson = function (planPath) {
        return host.jsonEncode(host.removeItemsFromFile(planPath));
    };

    $.global.PardDefenderHost = host;
})();
