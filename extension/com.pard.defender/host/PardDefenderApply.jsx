/*
 * PardDefender - the two mutating passes: relink and Project-panel organisation.
 *
 * @map role: Две мутирующие операции: перелинковка на проверенную копию с
 *           сохранением интерпретации и раскладка панели проекта.
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
            for (i = 0; i < plan.items.length; i++) {
                entry = plan.items[i];
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
