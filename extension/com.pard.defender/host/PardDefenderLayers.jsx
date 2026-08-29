/*
 * PardDefender - forgotten disabled layers.
 *
 * @map role: Ищет выключенные и забытые слои в композициях и композиции,
 *           которые никуда не входят и не помечены. Отсекает всё, что
 *           выключено по делу.
 * @map status: ready
 *
 * A layer switched off and left behind is the quietest kind of mess: it costs
 * nothing, so nobody remembers it, and it may equally be junk or the backup
 * take somebody will ask for next week. The panel therefore never guesses - it
 * finds the layer and lets the owner say which it is.
 *
 * The hard part is NOT finding disabled layers. It is not reporting the ones
 * that are disabled on purpose. A list full of false alarms gets ignored faster
 * than it gets useful, so everything below is about exclusion:
 *
 *   adjustment layer   a switched-off adjustment layer is an ordinary spare
 *   track matte        AFTER EFFECTS DISABLES IT ITSELF - the single most
 *                      common false positive there is
 *   guide layer        guides do not render by definition
 *   a parent           it still drives another layer's transform while invisible
 *   effect target      Set Matte, Displacement Map, Element 3D and friends read
 *                      a layer without showing it
 *   named in an expression   removing it breaks the expression
 *   PIN label          the manual opt-out used everywhere else in this panel
 *
 * Keyframed opacity is deliberately NOT an exclusion. Owner's decision,
 * 2026-08-29: such a layer may be a forgotten fade-in just as easily as a spare
 * take, so it is shown and the choice is offered.
 *
 * Loaded after PardDefenderApply.jsx. ES3 only.
 */

(function () {
    var host = $.global.PardDefenderHost;
    if (!host) return;

    function str(v) {
        try { return (v === null || v === undefined) ? "" : String(v); }
        catch (e) { return ""; }
    }

    /* A whole-comp expression sweep is the expensive part, so it is bounded. */
    var PROPERTY_BUDGET = 4000;
    var MAX_FINDINGS = 200;

    /* ----------------------------------------------------------- references */

    /*
     * Which layers this composition reads without displaying: effect parameters
     * of type LAYER_INDEX (Set Matte, Displacement Map, Caustics, Element 3D...)
     * and any layer named inside an expression.
     *
     * Both sweeps run once per composition and only when that composition has at
     * least one candidate, because they are the only costly checks here.
     */
    function collectReferences(comp) {
        var referenced = {}, expressions = [], budget = PROPERTY_BUDGET;

        function walk(group) {
            var i, prop;
            if (budget <= 0) return;
            var count = 0;
            try { count = group.numProperties; } catch (e) { return; }

            for (i = 1; i <= count && budget > 0; i++) {
                budget--;
                try { prop = group.property(i); } catch (e2) { continue; }
                if (!prop) continue;

                try {
                    if (prop.expressionEnabled && prop.expression) {
                        expressions.push(str(prop.expression));
                    }
                } catch (e3) {}

                try {
                    if (typeof PropertyValueType !== "undefined" &&
                        prop.propertyValueType === PropertyValueType.LAYER_INDEX) {
                        var index = prop.value;
                        if (index > 0) referenced[index] = true;
                    }
                } catch (e4) {}

                try {
                    if (prop.numProperties > 0) walk(prop);
                } catch (e5) {}
            }
        }

        var i;
        for (i = 1; i <= comp.numLayers && budget > 0; i++) {
            try { walk(comp.layer(i)); } catch (e) {}
        }

        return { referenced: referenced, expressions: expressions.join("\n") };
    }

    /* ------------------------------------------------------------ candidates */

    function fileSourceOf(layer) {
        var source = null;
        try { source = layer.source; } catch (e) { return null; }
        if (!source || !host.isFootageItem(source)) return null;
        return host.footageFile(source) ? source : null;
    }

    function isCandidate(layer, settings) {
        var enabled = true;
        try { enabled = layer.enabled; } catch (e) { return false; }
        if (enabled !== false) return false;

        try { if (layer.adjustmentLayer === true) return false; } catch (e1) {}
        try { if (layer.guideLayer === true) return false; } catch (e2) {}
        /*
         * The big one. A matte layer is switched off BY AFTER EFFECTS as soon as
         * the layer above uses it as a track matte - it is doing its job while
         * invisible, and reporting it would bury every real finding.
         */
        try { if (layer.isTrackMatte === true) return false; } catch (e3) {}
        try {
            if (settings.pinLabel > 0 && layer.label === settings.pinLabel) return false;
        } catch (e4) {}

        return fileSourceOf(layer) !== null;
    }

    function hasChildren(comp, layer) {
        var i, other, parent;
        for (i = 1; i <= comp.numLayers; i++) {
            other = comp.layer(i);
            if (other === layer) continue;
            try { parent = other.parent; } catch (e) { parent = null; }
            if (parent === layer) return true;
        }
        return false;
    }

    /* Layer names are user text; a name that is a bare word would match half an
     * expression by accident, so the search demands the quoted form AE itself
     * writes: thisComp.layer("Name"). */
    function namedInExpressions(expressions, name) {
        if (!expressions || !name) return false;
        return expressions.indexOf("\"" + name + "\"") >= 0 ||
            expressions.indexOf("'" + name + "'") >= 0;
    }

    /* ---------------------------------------------------------------- keys */

    /*
     * Identity has to survive layer reordering, so it is never the index:
     * composition id, source item id and layer name together.
     */
    function layerKey(comp, layer, source) {
        return "L" + str(comp.id) + "|" + str(source.id) + "|" + str(layer.name);
    }

    function compKey(comp) { return "C" + str(comp.id); }

    host.layerKey = layerKey;
    host.compKey = compKey;

    function listHas(list, value) {
        var i;
        if (!list) return false;
        for (i = 0; i < list.length; i++) {
            if (str(list[i]) === value) return true;
        }
        return false;
    }

    function exceptionFor(settings, key) {
        var list = settings.disabledLayerExceptions || [], i;
        for (i = 0; i < list.length; i++) {
            if (list[i] && str(list[i].key) === key) return list[i];
        }
        return null;
    }

    /* ---------------------------------------------------------------- scan */

    host.scanLayers = function () {
        var report = {
            ok: true,
            error: "",
            scannedComps: 0,
            scannedLayers: 0,
            findings: [],
            truncated: false
        };

        try {
            if (!app.project || !app.project.file) return report;

            var projectPath = host.slashes(app.project.file.fsName);
            var workspace = host.resolveWorkspace(projectPath).workspace;
            if (host.unsafeWorkspaceReason(workspace)) return report;

            var settings = host.loadSettings(workspace);
            var renderMarks = host.collectRenderComps(settings);
            var i, j, item, comp, layer, source, key, exception;

            for (i = 1; i <= app.project.numItems; i++) {
                item = app.project.item(i);
                if (!host.isCompItem(item)) continue;
                comp = item;
                report.scannedComps++;

                /*
                 * A composition nothing uses is reported as its own finding.
                 * Owner's decision: it is most likely a future render comp that
                 * simply has not been marked yet, and a nudge is more useful
                 * than silence.
                 */
                if (renderMarks[comp.id] === "orphan") {
                    key = compKey(comp);
                    exception = exceptionFor(settings, key);
                    if (!exception) {
                        report.findings.push({
                            kind: "comp",
                            key: key,
                            compId: str(comp.id),
                            compName: str(comp.name),
                            layerIndex: 0,
                            layerName: "",
                            itemId: "",
                            path: "",
                            size: 0,
                            status: listHas(settings.disabledLayerForgotten, key)
                                ? "forgotten" : "open"
                        });
                    }
                }

                /*
                 * A composition the owner has already marked forgotten answers
                 * for everything inside it. Listing its disabled layers as well
                 * would turn one decision into a dozen rows about a composition
                 * that is on its way out anyway. Owner's decision, 2026-08-29.
                 *
                 * Only "forgotten" does this. An EXCEPTION means the opposite -
                 * the composition is fine and should stop being mentioned - and
                 * that says nothing about the layers inside it.
                 */
                if (listHas(settings.disabledLayerForgotten, compKey(comp))) continue;

                /* Cheap pass first: is there anything in this comp worth the
                 * expensive reference sweep? */
                var candidates = [];
                for (j = 1; j <= comp.numLayers; j++) {
                    layer = comp.layer(j);
                    report.scannedLayers++;
                    if (isCandidate(layer, settings)) candidates.push(layer);
                }
                if (!candidates.length) continue;

                var refs = collectReferences(comp);

                for (j = 0; j < candidates.length; j++) {
                    if (report.findings.length >= MAX_FINDINGS) {
                        report.truncated = true;
                        break;
                    }
                    layer = candidates[j];
                    source = fileSourceOf(layer);
                    if (!source) continue;

                    if (refs.referenced[layer.index]) continue;
                    if (namedInExpressions(refs.expressions, str(layer.name))) continue;
                    if (hasChildren(comp, layer)) continue;

                    key = layerKey(comp, layer, source);
                    if (exceptionFor(settings, key)) continue;

                    var file = host.footageFile(source);
                    var size = 0;
                    try { size = Number(file.length) || 0; } catch (eSize) { size = 0; }

                    report.findings.push({
                        kind: "layer",
                        key: key,
                        compId: str(comp.id),
                        compName: str(comp.name),
                        layerIndex: layer.index,
                        layerName: str(layer.name),
                        itemId: str(source.id),
                        itemName: str(source.name),
                        path: host.slashes(file.fsName),
                        size: size,
                        status: listHas(settings.disabledLayerForgotten, key)
                            ? "forgotten" : "open"
                    });
                }
                if (report.truncated) break;
            }
        } catch (error) {
            report.ok = false;
            report.error = str(error) + " (line " + str(error.line) + ")";
        }

        return report;
    };

    host.scanLayersToFile = function () {
        var report = host.scanLayers();
        var path = host.tempFolder() + "/layers.json";
        if (!host.writeTextFile(path, host.jsonEncode(report))) {
            return "ERROR|The layer report could not be written to " + path;
        }
        return "OK|" + path;
    };

    /* -------------------------------------------------------------- reveal */

    /*
     * Opens the composition and selects the layer. Unlike a Project-panel item,
     * a layer CAN be revealed properly: opening the comp brings its timeline
     * forward, and the selection is visible there without any folder to expand.
     */
    host.revealLayer = function (compId, layerIndex, layerName) {
        var comp = host.findItemById(compId);
        if (!comp || !host.isCompItem(comp)) {
            return "ERROR|COMP_GONE";
        }

        var target = null, i, layer;
        var wanted = str(layerName);
        var index = Number(layerIndex) || 0;

        /* Index first, then name: reordering changes the index, renaming
         * changes the name, and it is rare for both to change at once. */
        if (index > 0 && index <= comp.numLayers) {
            layer = comp.layer(index);
            if (!wanted || str(layer.name) === wanted) target = layer;
        }
        if (!target && wanted) {
            for (i = 1; i <= comp.numLayers; i++) {
                if (str(comp.layer(i).name) === wanted) { target = comp.layer(i); break; }
            }
        }
        if (!target) return "ERROR|LAYER_GONE";

        try {
            comp.openInViewer();
            for (i = 1; i <= comp.numLayers; i++) {
                try { comp.layer(i).selected = false; } catch (eSel) {}
            }
            target.selected = true;
        } catch (error) { return "ERROR|" + str(error); }

        return "OK|" + str(comp.name) + "|" + str(target.name);
    };

    host.revealComp = function (compId) {
        var comp = host.findItemById(compId);
        if (!comp || !host.isCompItem(comp)) {
            return "ERROR|COMP_GONE";
        }
        try {
            comp.openInViewer();
            comp.selected = true;
        } catch (error) { return "ERROR|" + str(error); }
        return "OK|" + str(comp.name) + "|";
    };

    $.global.PardDefenderHost = host;
})();
