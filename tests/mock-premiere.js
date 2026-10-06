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
    this.type = typeof type !== "undefined" ? type : 1; // Real Premiere Pro ProjectItemType: 1 = clip, 2 = bin, 3 = root, 4 = file
    this.nodeId = "node_" + Math.random().toString(36).substring(2, 9);
    this.guid = "guid_" + Math.random().toString(36).substring(2, 9);
    this.treePath = "\\" + this.name;
    this.parent = null;
}

MockProjectItem.prototype.select = function () {
    this.selected = true;
};
MockProjectItem.prototype.getMediaFilePath = function () {
    return "";
};
MockProjectItem.prototype.canChangeMediaPath = function () {
    return false;
};
MockProjectItem.prototype.changeMediaPath = function () {
    return false;
};
MockProjectItem.prototype.changeMediaFilePath = function () {
    return false;
};
MockProjectItem.prototype.isSequence = function () {
    return false;
};
MockProjectItem.prototype.isOffline = function () {
    return false;
};
MockProjectItem.prototype.getId = function () {
    return this.nodeId;
};

function MockProjectItemCollection() {
    this._items = [];
}
Object.defineProperty(MockProjectItemCollection.prototype, "numItems", {
    get: function () { return this._items.length; },
    enumerable: true
});
MockProjectItemCollection.prototype.item = function (idx) {
    return this._items[idx];
};
MockProjectItemCollection.prototype.push = function (item) {
    var idx = this._items.length;
    this._items.push(item);
    this[idx] = item;
    return this._items.length;
};
MockProjectItemCollection.prototype.slice = function () {
    return this._items.slice();
};

function MockFolderItem(name) {
    MockProjectItem.call(this, name, 2); // 2 = bin in Premiere Pro
    this.isBin = true;
    this.isFolder = true;
    this.children = new MockProjectItemCollection();
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

MockFolderItem.cast = function (item) {
    if (!item) return null;
    if (item instanceof MockFolderItem || item.type === 2 || item.type === 3 || item.isBin || item.isFolder) return item;
    return null;
};
MockFolderItem.queryCast = function (item) {
    return MockFolderItem.cast(item);
};

function MockClipProjectItem(name, mediaPath, options) {
    MockProjectItem.call(this, name, 1); // 1 = clip in Premiere Pro
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

MockClipProjectItem.cast = function (item) {
    if (!item) return null;
    if (item instanceof MockClipProjectItem || item.type === 1 || item.type === 4 || item.mediaFilePath || item.getMediaFilePath) return item;
    return item;
};
MockClipProjectItem.queryCast = function (item) {
    return MockClipProjectItem.cast(item);
};

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
MockClipProjectItem.prototype.changeMediaPath = function (newPath) {
    return this.changeMediaFilePath(newPath);
};

function MockTrackItem(name, projectItem) {
    this.name = name || (projectItem ? projectItem.name : "Clip");
    this.projectItem = projectItem || null;
}
MockTrackItem.prototype.getProjectItem = function () {
    return this.projectItem;
};
MockTrackItem.prototype.getName = function () {
    return this.name;
};

function MockTrackCollection() {
    this._tracks = [];
}
Object.defineProperty(MockTrackCollection.prototype, "numTracks", {
    get: function () { return this._tracks.length; },
    enumerable: true
});
MockTrackCollection.prototype.item = function (idx) {
    return this._tracks[idx];
};
MockTrackCollection.prototype.push = function (track) {
    var idx = this._tracks.length;
    this._tracks.push(track);
    this[idx] = track;
    return this._tracks.length;
};

function MockTrack() {
    this.clips = new MockProjectItemCollection();
}
MockTrack.prototype.addItem = function (projectItem, name) {
    var ti = new MockTrackItem(name, projectItem);
    this.clips.push(ti);
    return ti;
};
MockTrack.prototype.getTrackItems = function (trackItemType, includeEmpty) {
    return this.clips ? this.clips.slice() : [];
};

function MockSequence(name) {
    MockProjectItem.call(this, name, 1); // 1 = clip in Premiere Pro, isSequence() === true
    this.isSequence = function () { return true; };
    this._isSequence = true;
    this._videoTracks = new MockTrackCollection();
    this._audioTracks = new MockTrackCollection();
    this.videoTracks = this._videoTracks;
    this.audioTracks = this._audioTracks;
    this.projectItem = this;
}
MockSequence.prototype = Object.create(MockProjectItem.prototype);
MockSequence.prototype.constructor = MockSequence;

MockSequence.prototype.addClipToTrack = function (projectItem, isAudio) {
    var trackColl = isAudio ? (this._audioTracks || this.audioTracks) : (this._videoTracks || this.videoTracks);
    if (trackColl.numTracks === 0) {
        var trk = new MockTrack();
        trackColl.push(trk);
    }
    return trackColl.item(0).addItem(projectItem);
};
MockSequence.prototype.getAudioTrackCount = function () {
    var coll = this._audioTracks || this.audioTracks;
    return coll ? coll.numTracks : 0;
};
MockSequence.prototype.getAudioTrack = function (idx) {
    var coll = this._audioTracks || this.audioTracks;
    return coll ? coll.item(idx) : null;
};
MockSequence.prototype.getVideoTrackCount = function () {
    var coll = this._videoTracks || this.videoTracks;
    return coll ? coll.numTracks : 0;
};
MockSequence.prototype.getVideoTrack = function (idx) {
    var coll = this._videoTracks || this.videoTracks;
    return coll ? coll.item(idx) : null;
};
MockSequence.prototype.getSequence = function () {
    return this;
};
MockSequence.prototype.getProjectItem = function () {
    return this;
};

function MockProject(guid, filePath, name) {
    this.guid = guid || "proj-guid-" + Math.random().toString(36).substring(2, 8);
    this.path = filePath || "";
    this.name = name || (filePath ? filePath.substring(filePath.lastIndexOf("/") + 1) : "Untitled");
    this.rootItem = new MockFolderItem("Root");
    this.sequences = [];
}

MockProject.prototype.getSequences = function () {
    return this.sequences ? this.sequences.slice() : [];
};
MockProject.prototype.getActiveSequence = function () {
    return this.activeSequence || (this.sequences && this.sequences[0]) || null;
};

MockProject.prototype.addSequence = function (seq) {
    if (seq) {
        this.sequences.push(seq);
        if (this.rootItem && typeof this.rootItem.addItem === "function") {
            this.rootItem.addItem(seq);
        }
    }
    return seq;
};

MockProject.prototype.getRootItem = function () {
    return this.rootItem;
};

MockProject.prototype.revealItem = function (item) {
    if (item) {
        item.selected = true;
        item.revealed = true;
        return true;
    }
    return false;
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
        },
        revealItem: function (item) {
            if (self.activeProject && typeof self.activeProject.revealItem === "function") {
                return self.activeProject.revealItem(item);
            }
            if (item) {
                item.selected = true;
                item.revealed = true;
                return true;
            }
            return false;
        }
    };
    this.Sequence = MockSequence;
    this.FolderItem = MockFolderItem;
    this.ClipProjectItem = MockClipProjectItem;
    this.ProjectItem = MockProjectItem;
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
    MockTrackItem: MockTrackItem,
    MockTrack: MockTrack,
    MockSequence: MockSequence,
    MockProject: MockProject,
    MockPremierePro: MockPremierePro
};
