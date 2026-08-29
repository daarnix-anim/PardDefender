/*
 *
 * @map role: Мок объектной модели After Effects: настоящие .jsx
 *           загружаются через vm.
 * @map status: ready
 * A minimal After Effects object model, just large enough to run the real host
 * modules under Node. Only the surface PardDefender actually touches is
 * implemented; anything else is deliberately absent so an accidental dependency
 * fails loudly instead of passing on a stub.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var nextId = 1;

function Item(name) {
    this.id = nextId++;
    this.name = name;
    this.label = 0;
    this.comment = "";
    this.parentFolder = null;
}

Object.defineProperty(Item.prototype, "usedIn", {
    get: function () {
        var project = this._project;
        if (!project) return [];
        var out = [], i, j, comp;
        for (i = 0; i < project.items.length; i++) {
            comp = project.items[i];
            if (!(comp instanceof CompItem)) continue;
            for (j = 0; j < comp.layers.length; j++) {
                if (comp.layers[j].source === this) { out.push(comp); break; }
            }
        }
        return out;
    }
});

/*
 * Only the surface the scan touches: the switches that decide whether a
 * disabled layer is forgotten or disabled on purpose, plus a property tree
 * shallow enough to carry an effect layer-reference or an expression.
 */
function MockProperty(options) {
    var o = options || {};
    this.name = o.name || "prop";
    this.expressionEnabled = o.expression ? true : false;
    this.expression = o.expression || "";
    this.propertyValueType = o.propertyValueType;
    this.value = o.value;
    this._children = o.children || [];
}

Object.defineProperty(MockProperty.prototype, "numProperties", {
    get: function () { return this._children.length; }
});

MockProperty.prototype.property = function (i) { return this._children[i - 1]; };

function MockLayer(comp, source, options) {
    var o = options || {};
    this.containingComp = comp;
    this.source = source || null;
    this.name = o.name || (source ? source.name : "layer");
    this.enabled = o.enabled === undefined ? true : o.enabled;
    this.adjustmentLayer = o.adjustmentLayer === true;
    this.guideLayer = o.guideLayer === true;
    this.isTrackMatte = o.isTrackMatte === true;
    this.parent = o.parent || null;
    this.label = o.label || 0;
    this.selected = false;
    this._children = [];
}

Object.defineProperty(MockLayer.prototype, "index", {
    get: function () { return this.containingComp.layers.indexOf(this) + 1; }
});

Object.defineProperty(MockLayer.prototype, "numProperties", {
    get: function () { return this._children.length; }
});

MockLayer.prototype.property = function (i) { return this._children[i - 1]; };

/* An effect parameter that points at another layer by index - Set Matte,
 * Displacement Map, Element 3D and the rest. */
MockLayer.prototype.referenceLayer = function (index) {
    this._children.push(new MockProperty({
        name: "Layer",
        propertyValueType: PropertyValueType.LAYER_INDEX,
        value: index
    }));
    return this;
};

MockLayer.prototype.addExpression = function (text) {
    this._children.push(new MockProperty({ name: "Opacity", expression: text }));
    return this;
};

var PropertyValueType = { LAYER_INDEX: 6 };

function CompItem(name) {
    Item.call(this, name);
    this.layers = [];
    this.duration = 10;
}

CompItem.prototype = Object.create(Item.prototype);
CompItem.prototype.constructor = CompItem;
/* Adds a layer whose source is the given item and returns the LAYER. */
CompItem.prototype.addLayer = function (source, options) {
    var layer = new MockLayer(this, source, options);
    this.layers.push(layer);
    return layer;
};

CompItem.prototype.layer = function (i) { return this.layers[i - 1]; };

CompItem.prototype.openInViewer = function () { this._opened = true; return this; };


Object.defineProperty(CompItem.prototype, "numLayers", {
    get: function () { return this.layers.length; }
});

function FolderItem(name) {
    Item.call(this, name);
}
FolderItem.prototype = Object.create(Item.prototype);
FolderItem.prototype.constructor = FolderItem;

function FileSource(filePath, isStill) {
    this.file = new MockFile(filePath);
    this.isStill = isStill !== false;
    this.alphaMode = 1;
    this.conformFrameRate = 0;
    this.loop = 1;
}

function SolidSource() { this.file = null; }
function PlaceholderSource() { this.file = null; }

function FootageItem(name, filePath, options) {
    Item.call(this, name);
    var opts = options || {};
    this.mainSource = opts.solid
        ? new SolidSource()
        : new FileSource(filePath, opts.isStill !== false);
    this.duration = opts.duration === undefined ? 0 : opts.duration;
    this.footageMissing = opts.missing === true;
    this.useProxy = opts.useProxy === true;
    /* A proxy is its own source object with its own file, exactly as in AE. */
    this.proxySource = opts.proxy
        ? new FileSource(opts.proxy, opts.proxyIsStill !== false)
        : null;
}
FootageItem.prototype = Object.create(Item.prototype);
FootageItem.prototype.constructor = FootageItem;

FootageItem.prototype.setProxy = function (file) {
    this.proxySource = new FileSource(String(file.fsName).replace(/\\/g, "/"), true);
    this.useProxy = true;
    return this.proxySource;
};

FootageItem.prototype.setProxyWithSequence = function (file) {
    this.proxySource = new FileSource(String(file.fsName).replace(/\\/g, "/"), false);
    this.useProxy = true;
    return this.proxySource;
};

FootageItem.prototype.setProxyToNone = function () {
    this.proxySource = null;
    this.useProxy = false;
};

FootageItem.prototype.replace = function (file) {
    this.mainSource = new FileSource(String(file.fsName).replace(/\\/g, "/"), true);
};

FootageItem.prototype.replaceWithSequence = function (file) {
    this.mainSource = new FileSource(String(file.fsName).replace(/\\/g, "/"), false);
};

/* --------------------------------------------------------------- File stubs */

var virtualFiles = {};

function MockFile(p) {
    this.fsName = String(p || "").replace(/\//g, path.sep);
    this._slash = String(p || "").replace(/\\/g, "/");
}

Object.defineProperty(MockFile.prototype, "exists", {
    get: function () {
        var key = this._slash.toLowerCase();
        return virtualFiles.hasOwnProperty(key) || fs.existsSync(this.fsName);
    }
});

Object.defineProperty(MockFile.prototype, "length", {
    get: function () {
        var key = this._slash.toLowerCase();
        return virtualFiles.hasOwnProperty(key) ? virtualFiles[key] : 0;
    }
});

Object.defineProperty(MockFile.prototype, "parent", {
    get: function () {
        return new MockFolder(this._slash.replace(/\/[^\/]*$/, ""));
    }
});

/*
 * ExtendScript's File I/O, backed by real files in a real temp folder. The
 * host passes every plan and every report through a file rather than through
 * an evalScript return value, so without this the whole relink path - the
 * riskiest code in the project - could not be exercised at all.
 */
MockFile.prototype.open = function (mode) {
    this._mode = mode === "w" ? "w" : "r";
    if (this._mode === "r") {
        if (!fs.existsSync(this.fsName)) return false;
        try { this._buffer = fs.readFileSync(this.fsName, "utf8"); }
        catch (e) { return false; }
        return true;
    }
    this._buffer = "";
    return true;
};

MockFile.prototype.read = function () { return this._buffer || ""; };

MockFile.prototype.write = function (text) {
    this._buffer = (this._buffer || "") + String(text);
    return true;
};

MockFile.prototype.close = function () {
    if (this._mode === "w") {
        fs.mkdirSync(path.dirname(this.fsName), { recursive: true });
        fs.writeFileSync(this.fsName, this._buffer || "", "utf8");
    }
    this._mode = null;
    return true;
};

MockFile.prototype.remove = function () {
    try { fs.unlinkSync(this.fsName); return true; } catch (e) { return false; }
};

function MockFolder(p) {
    this.fsName = String(p || "").replace(/\//g, path.sep);
    this._slash = String(p || "").replace(/\\/g, "/");
}
Object.defineProperty(MockFolder.prototype, "exists", { get: function () { return true; } });
MockFolder.prototype.create = function () {
    try { fs.mkdirSync(this.fsName, { recursive: true }); return true; }
    catch (e) { return false; }
};

MockFolder.temp = new MockFolder(require("os").tmpdir());
MockFolder.desktop = new MockFolder("C:/Users/tester/Desktop");
MockFolder.myDocuments = new MockFolder("C:/Users/tester/Documents");
MockFolder.userData = new MockFolder("C:/Users/tester/AppData/Roaming");

/* ------------------------------------------------------------------ project */

function Project() {
    this.items = [];
    this.rootFolder = new FolderItem("Root");
    this.rootFolder._project = this;
    this.file = null;
    this.renderQueue = { numItems: 0, item: function () { return null; } };
}

Object.defineProperty(Project.prototype, "numItems", {
    get: function () { return this.items.length; }
});

Project.prototype.item = function (index) { return this.items[index - 1]; };

Project.prototype.add = function (item, parent) {
    item._project = this;
    item.parentFolder = parent || this.rootFolder;
    this.items.push(item);
    return item;
};

Project.prototype.setRenderQueue = function (comps) {
    var entries = comps.map(function (c) { return { comp: c }; });
    this.renderQueue = {
        numItems: entries.length,
        item: function (i) { return entries[i - 1]; }
    };
};

/* ------------------------------------------------------------- host loading */

function loadHost(projectPath) {
    var project = new Project();
    if (projectPath) project.file = new MockFile(projectPath);

    var sandbox = {
        app: {
            project: project,
            beginUndoGroup: function () {},
            endUndoGroup: function () {}
        },
        CompItem: CompItem,
        FootageItem: FootageItem,
        FolderItem: FolderItem,
        FileSource: FileSource,
        SolidSource: SolidSource,
        PlaceholderSource: PlaceholderSource,
        PropertyValueType: PropertyValueType,
        File: MockFile,
        Folder: MockFolder,
        console: console
    };
    sandbox.$ = { global: sandbox, evalFile: function () {} };
    sandbox.global = sandbox;
    vm.createContext(sandbox);

    var dir = path.join(__dirname, "..", "extension", "com.pard.defender", "host");
    ["PardDefenderCore.jsx", "PardDefenderPlan.jsx", "PardDefenderAudit.jsx",
        "PardDefenderApply.jsx", "PardDefenderLayers.jsx"].forEach(function (name) {
        var code = fs.readFileSync(path.join(dir, name), "utf8");
        vm.runInContext(code, sandbox, { filename: name });
    });

    return { host: sandbox.PardDefenderHost, project: project, sandbox: sandbox };
}

module.exports = {
    loadHost: loadHost,
    CompItem: CompItem,
    FootageItem: FootageItem,
    FolderItem: FolderItem,
    MockLayer: MockLayer,
    PropertyValueType: PropertyValueType,
    virtualFiles: virtualFiles,
    registerFile: function (p, size) {
        virtualFiles[String(p).replace(/\\/g, "/").toLowerCase()] = size || 1024;
    }
};
