/*
 * PardDefender - Mock Premiere Pro UXP Environment for Node tests.
 *
 * @map role: Мок официального UXP DOM Premiere Pro 25.6+ для автономных тестов без Premiere.
 * @map status: ready
 *
 * Simulates Project, FolderItem, ClipProjectItem, Sequence, proxies, offline,
 * generated media and bins without any reliance on Adobe binaries.
 */
"use strict";

var EventEmitter = require("events").EventEmitter;

function MockProjectItem(name, type) {
    this.name = name || "Item";
    this.type = typeof type !== "undefined" ? type : 1; // 1 = bin, 2 = sequence, 3 = clip, 4 = synthetic
    this.nodeId = "node_" + Math.random().toString(36).substring(2, 9);
    this.guid = "guid_" + Math.random().toString(36).substring(2, 9);
    this.treePath = "\\" + this.name;
    this.parent = null;
}

MockProjectItem.prototype.select = function () {
    this.selected = true;
};

function MockFolderItem(name) {
    MockProjectItem.call(this, name, 1);
    this.isBin = true;
    this.isFolder = true;
    this.children = [];
    this.items = this.children;
}
MockFolderItem.prototype = Object.create(MockProjectItem.prototype);
MockFolderItem.prototype.constructor = MockFolderItem;

MockFolderItem.prototype.getItems = function () {
    return this.children.slice();
};

MockFolderItem.prototype.addItem = function (item) {
    item.parent = this;
    item.treePath = (this.treePath ? this.treePath + "\\" : "\\") + item.name;
    this.children.push(item);
    return item;
};

function MockClipProjectItem(name, mediaPath, options) {
    MockProjectItem.call(this, name, 3);
    var opt = options || {};
    this.mediaFilePath = mediaPath || "";
    this.offline = !!opt.offline;
    this.hasProxyFlag = !!opt.hasProxy;
    this.proxyPath = opt.proxyPath || "";
    this.isMulticam = !!opt.isMulticam;
    this.isMerged = !!opt.isMerged;
    this.isSynthetic = !!opt.isSynthetic;
    this.mediaType = opt.mediaType || (opt.isSynthetic ? "synthetic" : "video");
    this.masterClip = {
        mediaFilePath: this.mediaFilePath,
        isOffline: this.offline,
        isSynthetic: this.isSynthetic,
        name: this.name
    };
}
MockClipProjectItem.prototype = Object.create(MockProjectItem.prototype);
MockClipProjectItem.prototype.constructor = MockClipProjectItem;

MockClipProjectItem.prototype.getMediaFilePath = function () {
    return this.mediaFilePath;
};

MockClipProjectItem.prototype.hasProxy = function () {
    return this.hasProxyFlag;
};

MockClipProjectItem.prototype.getProxyPath = function () {
    return this.proxyPath;
};

MockClipProjectItem.prototype.isOffline = function () {
    return this.offline || !this.mediaFilePath;
};

MockClipProjectItem.prototype.canChangeMediaPath = function () {
    return true;
};

MockClipProjectItem.prototype.changeMediaFilePath = function (newPath) {
    this.mediaFilePath = newPath;
    this.offline = false;
    if (this.masterClip) {
        this.masterClip.mediaFilePath = newPath;
        this.masterClip.isOffline = false;
    }
    return true;
};

function MockSequence(name) {
    MockProjectItem.call(this, name, 2);
    this.isSequence = true;
}
MockSequence.prototype = Object.create(MockProjectItem.prototype);
MockSequence.prototype.constructor = MockSequence;

function MockProject(guid, filePath, name) {
    this.guid = guid || "proj-guid-" + Math.random().toString(36).substring(2, 8);
    this.path = filePath || "";
    this.name = name || (filePath ? filePath.substring(filePath.lastIndexOf("/") + 1) : "Untitled");
    this.rootItem = new MockFolderItem("Root");
}

MockProject.prototype.getRootItem = function () {
    return this.rootItem;
};

function MockPremierePro(version) {
    this.version = version || "25.6.0";
    this.activeProject = null;
    var self = this;

    this.Project = {
        activeProject: null,
        projects: [],
        getActiveProject: function () {
            return self.activeProject;
        }
    };
    this.Sequence = MockSequence;
}

MockPremierePro.prototype.setActiveProject = function (project) {
    this.activeProject = project;
    if (this.Project) {
        this.Project.activeProject = project;
        this.Project.projects = project ? [project] : [];
    }
};

module.exports = {
    MockProjectItem: MockProjectItem,
    MockFolderItem: MockFolderItem,
    MockClipProjectItem: MockClipProjectItem,
    MockSequence: MockSequence,
    MockProject: MockProject,
    MockPremierePro: MockPremierePro
};
