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
                if (comp.layers[j] === this) { out.push(comp); break; }
            }
        }
        return out;
    }
});

function CompItem(name) {
    Item.call(this, name);
    this.layers = [];
    this.duration = 10;
}
CompItem.prototype = Object.create(Item.prototype);
CompItem.prototype.constructor = CompItem;

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
}
FootageItem.prototype = Object.create(Item.prototype);
FootageItem.prototype.constructor = FootageItem;

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

function MockFolder(p) {
    this.fsName = String(p || "").replace(/\//g, path.sep);
    this._slash = String(p || "").replace(/\\/g, "/");
}
Object.defineProperty(MockFolder.prototype, "exists", { get: function () { return true; } });
MockFolder.prototype.create = function () { return true; };

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
        File: MockFile,
        Folder: MockFolder,
        console: console
    };
    sandbox.$ = { global: sandbox, evalFile: function () {} };
    sandbox.global = sandbox;
    vm.createContext(sandbox);

    var dir = path.join(__dirname, "..", "extension", "com.pard.defender", "host");
    ["PardDefenderCore.jsx", "PardDefenderPlan.jsx",
        "PardDefenderAudit.jsx", "PardDefenderApply.jsx"].forEach(function (name) {
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
    virtualFiles: virtualFiles,
    registerFile: function (p, size) {
        virtualFiles[String(p).replace(/\\/g, "/").toLowerCase()] = size || 1024;
    }
};
