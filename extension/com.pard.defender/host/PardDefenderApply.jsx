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

    function layerNameWithoutFile(name) {
        var text = str(name).replace(/\\/g, "/");
        var slash = text.lastIndexOf("/");
        if (slash >= 0 && /\.(psd|psb|ai)$/i.test(text.substring(slash + 1))) {
            return text.substring(0, slash);
        }
        return text;
    }

    function fileBaseName(path) {
        var text = host.slashes(str(path));
        text = text.substring(text.lastIndexOf("/") + 1);
        try { text = decodeURI(text); } catch (eDecode) {}
        return text;
    }

    function isMergedLayeredItem(item, currentPath) {
        /* Absence of a slash is NOT evidence of merged footage: the owner can
         * rename a layer. Only an unchanged file name identifies this case. */
        return str(item.name) === fileBaseName(currentPath);
    }

    function layerAliases(item, usages) {
        var aliases = [], i;
        function add(name) {
            var value = layerNameWithoutFile(name);
            if (!value) return;
            for (var a = 0; a < aliases.length; a++) {
                if (aliases[a] === value) return;
            }
            aliases.push(value);
        }
        try { add(item.mainSource.name); } catch (eName) {}
        add(item.name);
        /* A custom timeline label may happen to equal ANOTHER internal layer.
         * Only AE's file-qualified source labels provide fallback evidence. */
        for (i = 0; i < usages.length; i++) {
            if (layerNameWithoutFile(usages[i].layer.name) !== str(usages[i].layer.name).replace(/\\/g, "/")) {
                add(usages[i].layer.name);
            }
        }
        return aliases;
    }

    function matchLayerCandidate(item, candidates, usages) {
        var aliases = layerAliases(item, usages);
        var best = null, bestRank = 0, ambiguous = false;
        var i, a, c, rank, alias;
        for (i = 0; i < candidates.length; i++) {
            c = candidates[i];
            /* Keep the original import mode, including document-size layers.
             * Dimensions alone never establish the identity of a PSD/AI layer. */
            if (c.width !== item.width || c.height !== item.height) continue;
            rank = 0;
            for (a = 0; a < aliases.length; a++) {
                alias = aliases[a];
                if (alias === c.path) rank = Math.max(rank, alias.indexOf("/") >= 0 ? 3 : 1);
                else if (alias.indexOf("/") >= 0 &&
                    c.path.substring(c.path.length - alias.length - 1) === "/" + alias) {
                    rank = Math.max(rank, 2);
                } else if (alias.indexOf("/") < 0 &&
                    (alias === c.name || alias === layerNameWithoutFile(c.sourceName))) {
                    rank = Math.max(rank, 1);
                }
            }
            if (rank > bestRank) {
                best = c;
                bestRank = rank;
                ambiguous = false;
            } else if (rank > 0 && rank === bestRank && best && c.identity !== best.identity) {
                ambiguous = true;
            }
        }
        return ambiguous ? null : best;
    }

    function layeredUsages(item, importedItems) {
        var usages = [], p, cl, comp, layer;
        for (p = 1; p <= app.project.numItems; p++) {
            comp = app.project.item(p);
            if (!host.isCompItem(comp) || importedItems[comp.id]) continue;
            for (cl = 1; cl <= comp.numLayers; cl++) {
                layer = comp.layer(cl);
                if (layer && layer.source === item) usages.push({ layer: layer });
            }
        }
        return usages;
    }

    function replaceLayerSource(layer, source) {
        var locked = layer.locked === true;
        /* Equal source dimensions keep the layer coordinate system unchanged.
         * Do not set transform values: setValue can erase animation/expressions. */
        try {
            if (locked) layer.locked = false;
            layer.replaceSource(source, false);
            if (layer.source !== source) throw new Error("Layer source did not change.");
        } finally {
            if (locked) layer.locked = true;
        }
    }

    function relinkLayeredGroup(destination, groupEntries, result) {
        var itemsBefore = {}, importedItems = {}, newlyCreatedItems = [], candidates = [];
        var importErrors = [], prepared = [], i, entry, item, file, currentPath;
        for (i = 1; i <= app.project.numItems; i++) itemsBefore[app.project.item(i).id] = true;

        function rememberImportedItems() {
            for (var p = 1; p <= app.project.numItems; p++) {
                var imported = app.project.item(p);
                if (!itemsBefore[imported.id] && !importedItems[imported.id]) {
                    importedItems[imported.id] = true;
                    newlyCreatedItems.push(imported);
                }
            }
        }

        function collectFromComp(comp, parentPath, parentIndex, visited) {
            if (!comp || !host.isCompItem(comp) || visited[comp.id]) return;
            visited[comp.id] = true;
            for (var k = 1; k <= comp.numLayers; k++) {
                var layer = comp.layer(k);
                if (!layer || !layer.source) continue;
                var name = layerNameWithoutFile(layer.name);
                var path = parentPath ? parentPath + "/" + name : name;
                var indexPath = parentIndex + "/" + k;
                if (host.isCompItem(layer.source)) {
                    collectFromComp(layer.source, path, indexPath, visited);
                } else if (host.isFootageItem(layer.source)) {
                    var sourceFile = host.footageFile(layer.source);
                    if (!sourceFile || host.slashes(sourceFile.fsName).toLowerCase() !==
                        host.slashes(destination.fsName).toLowerCase()) continue;
                    candidates.push({
                        name: name, path: path, identity: indexPath,
                        sourceName: str(layer.source.name), source: layer.source,
                        width: layer.source.width, height: layer.source.height
                    });
                }
            }
        }

        function importMode(mode) {
            var suppressing = false, candidateCount = candidates.length;
            try {
                if (typeof ImportOptions === "undefined" || mode === undefined) return;
                var io = new ImportOptions(destination);
                io.file = destination;
                io.sequence = false;
                if (typeof io.canImportAs === "function" && !io.canImportAs(mode)) return;
                io.importAs = mode;
                if (typeof app.beginSuppressDialogs === "function") {
                    app.beginSuppressDialogs();
                    suppressing = true;
                }
                var comp = app.project.importFile(io);
                if (!host.isCompItem(comp)) throw new Error("Import returned no layered composition.");
                collectFromComp(comp, "", "", {});
            } catch (eImport) {
                candidates.length = candidateCount;
                importErrors.push(str(eImport));
            } finally {
                if (suppressing) {
                    try { app.endSuppressDialogs(false); } catch (eDialogs) {}
                }
                rememberImportedItems();
            }
        }

        function failure(ent, code, reason) {
            result.skipped++;
            result.failures.push({ key: str(ent.key), id: str(ent.id), code: code, reason: reason });
        }

        /* Validate BEFORE importing. Prepare the whole mapping before renaming
         * imported sources or changing any composition references. */
        for (i = 0; i < groupEntries.length; i++) {
            entry = groupEntries[i];
            item = host.findItemById(entry.id);
            if (!item || !host.isFootageItem(item)) {
                failure(entry, "RELINK_ITEM_GONE", "The item is no longer in the project.");
                continue;
            }
            file = host.footageFile(item);
            currentPath = file ? host.slashes(file.fsName) : "";
            if (entry.expectPath && currentPath.toLowerCase() !== host.slashes(entry.expectPath).toLowerCase()) {
                failure(entry, "RELINK_SOURCE_CHANGED", "The source changed after the audit; left untouched.");
                continue;
            }
            prepared.push({ entry: entry, item: item,
                merged: isMergedLayeredItem(item, currentPath) });
        }

        var needsLayers = false;
        for (i = 0; i < prepared.length; i++) {
            if (!prepared[i].merged) needsLayers = true;
        }
        if (needsLayers && typeof ImportAsType !== "undefined") {
            /* Try both modes independently. Illustrator/host builds may accept
             * COMP but reject cropped import even when canImportAs says yes. */
            importMode(ImportAsType.COMP_CROPPED_LAYERS);
            importMode(ImportAsType.COMP);
        }

        try {
            for (i = 0; i < prepared.length; i++) {
                var state = prepared[i];
                if (state.merged) continue;
                state.usages = layeredUsages(state.item, importedItems);
                state.candidate = matchLayerCandidate(state.item, candidates, state.usages);
            }
            for (i = 0; i < prepared.length; i++) {
                var pending = prepared[i];
                item = pending.item;
                entry = pending.entry;
                var saved = captureInterpretation(item), savedProxy = captureProxy(item);
                if (pending.merged) {
                    try {
                        item.replace(destination);
                        restoreInterpretation(item, saved);
                        restoreProxy(item, savedProxy);
                        result.relinked++;
                    } catch (eMerged) {
                        failure(entry, "LAYER_RELINK_REJECTED", str(eMerged));
                    }
                    continue;
                }
                var candidate = pending.candidate;
                if (!candidate) {
                    failure(entry, candidates.length ? "LAYER_MATCH_FAILED" : "LAYERED_RELINK_FAILED",
                        candidates.length ? "No unique layer with the original name/path and dimensions for " + str(item.name) + "; left untouched." :
                        "Layered import failed: " + (importErrors.join("; ") || "No supported composition import mode.") + "; left untouched.");
                    continue;
                }
                var source = candidate.source, usages = pending.usages, changed = [], replaceError = "";
                try {
                    source.parentFolder = item.parentFolder;
                    restoreInterpretation(source, saved);
                    restoreProxy(source, savedProxy);
                    for (var u = 0; u < usages.length; u++) {
                        /* Track BEFORE the call: a host error may occur after it
                         * changes the source (including when restoring lock). */
                        changed.push(usages[u].layer);
                        replaceLayerSource(usages[u].layer, source);
                    }
                } catch (eReplace) {
                    replaceError = str(eReplace);
                }
                if (replaceError) {
                    for (var r = changed.length - 1; r >= 0; r--) {
                        try {
                            if (changed[r].source === source) replaceLayerSource(changed[r], item);
                        } catch (eRollback) {
                            replaceError += "; rollback: " + str(eRollback);
                        }
                    }
                    failure(entry, "LAYER_RELINK_REJECTED", replaceError + "; original project item retained.");
                    continue;
                }
                /* Never delete an original that still has a composition use. */
                if (layeredUsages(item, importedItems).length > 0) {
                    failure(entry, "LAYER_RELINK_REJECTED", "Original layer still has references; item retained.");
                    continue;
                }
                candidate.keep = true; // also retain imported footage unused in comps
                try { item.remove(); } catch (eRemove) {}
                result.relinked++;
            }
        } finally {
            /* Only temporary items are cleaned up, never original project comps.
             * Keep any imported source still referenced after a failed rollback. */
            for (var c = newlyCreatedItems.length - 1; c >= 0; c--) {
                if (host.isCompItem(newlyCreatedItems[c])) {
                    try { newlyCreatedItems[c].remove(); } catch (eComp) {}
                }
            }
            for (var f = newlyCreatedItems.length - 1; f >= 0; f--) {
                var temp = newlyCreatedItems[f], keep = false;
                if (!host.isFootageItem(temp)) continue;
                for (var n = 0; n < candidates.length; n++) {
                    if (candidates[n].source === temp && candidates[n].keep) keep = true;
                }
                try { if (temp.usedIn.length > 0) keep = true; } catch (eUsed) { keep = true; }
                if (!keep) { try { temp.remove(); } catch (eFootage) {} }
            }
            for (var d = newlyCreatedItems.length - 1; d >= 0; d--) {
                var folder = newlyCreatedItems[d], empty = true;
                if (!host.isFolderItem(folder)) continue;
                for (var p = 1; p <= app.project.numItems; p++) {
                    if (app.project.item(p).parentFolder === folder) empty = false;
                }
                if (empty) { try { folder.remove(); } catch (eFolder) {} }
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
                 * composition imports, resolve the original name/path AND dimensions
                 * before repointing every usage to the corresponding internal layer.
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

                    relinkLayeredGroup(destFileCandidate, groupEntries, result);
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

    /*
     * Consolidates duplicate project items in After Effects: replaces usages
     * of duplicate items in all compositions with the canonical item, then
     * removes the redundant duplicate items from the Project panel.
     */
    host.consolidateProjectItems = function (plan) {
        var result = {
            ok: true,
            relinkedLayers: 0,
            removedItems: 0,
            skippedItems: 0,
            error: "",
            relinkFailures: [],
            removeFailures: []
        };

        if (!app.project) {
            result.ok = false;
            result.error = "No project is open.";
            return result;
        }

        if (!plan || !plan.canonicalId || !host.isArrayLike(plan.duplicateIds)) {
            result.ok = false;
            result.error = "Invalid project items consolidation plan.";
            return result;
        }

        var canonicalItem = host.findItemById(plan.canonicalId);
        if (!canonicalItem || !host.isFootageItem(canonicalItem)) {
            result.ok = false;
            result.error = "Canonical project item not found (ID: " + str(plan.canonicalId) + ").";
            return result;
        }

        var dupIdMap = {};
        for (var d = 0; d < plan.duplicateIds.length; d++) {
            var dId = str(plan.duplicateIds[d]);
            if (dId && dId !== str(plan.canonicalId)) {
                dupIdMap[dId] = true;
            }
        }

        var undoStarted = false;
        try {
            app.beginUndoGroup("PardDefender: Consolidate duplicate project items");
            undoStarted = true;

            /* Step 1: Replace sources across all comps */
            var compList = [];
            for (var i = 1; i <= app.project.numItems; i++) {
                var pItem = app.project.item(i);
                if (host.isCompItem(pItem)) compList.push(pItem);
            }

            for (var c = 0; c < compList.length; c++) {
                var comp = compList[c];
                var numL = 0;
                try { numL = comp.numLayers; } catch (eNum) { numL = 0; }
                for (var l = 1; l <= numL; l++) {
                    var layer = null;
                    try { layer = comp.layer(l); } catch (eLay) { layer = null; }
                    if (!layer) continue;
                    var src = null;
                    try { src = layer.source; } catch (eSrc) { src = null; }
                    if (!src) continue;
                    var srcId = str(src.id);
                    if (dupIdMap[srcId]) {
                        var wasLocked = false;
                        try { wasLocked = layer.locked; } catch (eLock) { wasLocked = false; }
                        if (wasLocked) {
                            try { layer.locked = false; } catch (eUnl) {}
                        }
                        try {
                            layer.replaceSource(canonicalItem, false);
                            result.relinkedLayers++;
                        } catch (eRep) {
                            result.relinkFailures.push("Layer " + l + " in comp '" + comp.name + "': " + eRep.toString());
                        }
                        if (wasLocked) {
                            try { layer.locked = true; } catch (eRel) {}
                        }
                    }
                }
            }

            /* Step 2: Remove unreferenced duplicate items */
            for (var dupKey in dupIdMap) {
                if (!dupIdMap.hasOwnProperty(dupKey)) continue;
                var dupItem = host.findItemById(dupKey);
                if (!dupItem) {
                    result.skippedItems++;
                    continue;
                }
                var remainingUses = 0;
                try {
                    remainingUses = (dupItem.usedIn && dupItem.usedIn.length) || 0;
                } catch (eRem) { remainingUses = 0; }

                if (remainingUses === 0) {
                    try {
                        dupItem.remove();
                        result.removedItems++;
                    } catch (eRemItem) {
                        result.skippedItems++;
                        result.removeFailures.push("Item ID " + dupKey + ": " + eRemItem.toString());
                    }
                } else {
                    result.skippedItems++;
                }
            }
        } catch (error) {
            result.ok = false;
            result.error = str(error) + " (line " + str(error.line) + ")";
        }

        if (undoStarted) { try { app.endUndoGroup(); } catch (eEnd) {} }
        return result;
    };

    host.consolidateProjectItemsFromFile = function (planPath) {
        var raw = host.readTextFile(planPath);
        if (!raw) {
            return { ok: false, error: "The consolidation plan could not be read." };
        }
        var plan = host.jsonDecode(raw);
        return host.consolidateProjectItems(plan);
    };

    host.consolidateProjectItemsJson = function (planJson) {
        var plan = typeof planJson === "string" ? host.jsonDecode(planJson) : planJson;
        return host.jsonEncode(host.consolidateProjectItems(plan));
    };

    host.consolidateProjectItemsFromFileJson = function (planPath) {
        return host.jsonEncode(host.consolidateProjectItemsFromFile(planPath));
    };

    $.global.PardDefenderHost = host;
})();
