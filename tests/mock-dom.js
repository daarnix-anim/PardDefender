/*
 * Minimal DOM for the panel.
 *
 * @map role: Крошечный DOM, чтобы панель можно было запустить без браузера:
 *           разметка читается из настоящего index.html.
 * @map status: ready
 *
 * main.js is 2500 lines that had never been executed anywhere - not by a
 * browser during development, not by any test set. Everything known about it
 * came from reading the source, and a panel assembled that way is a panel
 * nobody has switched on.
 *
 * The DOM surface it actually touches is small and closed, so a stub is enough:
 * createElement / createTextNode / getElementById / activeElement /
 * readyState / addEventListener, and on an element textContent, className,
 * hidden, innerHTML, title, disabled, checked, value, style, onclick,
 * onchange, appendChild, focus. Nothing else appears in the file.
 *
 * The markup is PARSED FROM client/index.html rather than hand-built here. A
 * fixture would agree with itself forever; the real file is the only thing that
 * can disagree with the code, and a disagreement between markup and code is
 * exactly the class of fault this exists to catch.
 */
"use strict";

var fs = require("fs");
var path = require("path");

/*
 * Writes to innerHTML are counted, and WHO wrote is remembered. A repaint of an
 * unchanged list resets scrollTop, which is what once made the panel impossible
 * to scroll - so when that regression comes back the test has to name the list
 * rather than just report a number.
 */
var htmlWrites = 0;
var htmlWriters = [];

function MockElement(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.listeners = {};

    this._text = "";
    this._html = "";
    this.className = "";
    this.hidden = false;
    this.title = "";
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.id = "";
    this.onclick = null;
    this.onchange = null;
    this.focused = false;
}

Object.defineProperty(MockElement.prototype, "textContent", {
    get: function () {
        if (this._text) return this._text;
        var out = "", i;
        for (i = 0; i < this.children.length; i++) {
            out += this.children[i].textContent;
        }
        return out;
    },
    set: function (value) {
        this._text = String(value === undefined || value === null ? "" : value);
        this.children = [];
    }
});

Object.defineProperty(MockElement.prototype, "innerHTML", {
    get: function () { return this._html; },
    set: function (value) {
        htmlWrites++;
        htmlWriters.push(this.id || this.className || this.tagName);
        this._html = String(value);
        /* Only ever used to empty a container in this codebase. */
        this.children = [];
        this._text = "";
    }
});

MockElement.prototype.appendChild = function (child) {
    child.parentNode = this;
    this.children.push(child);
    /* A container that was emptied and refilled no longer holds raw html. */
    this._html = "";
    return child;
};

MockElement.prototype.setAttribute = function (name, value) {
    this.attributes[name] = String(value);
    if (name === "id") this.id = String(value);
};

MockElement.prototype.getAttribute = function (name) {
    return this.attributes.hasOwnProperty(name) ? this.attributes[name] : null;
};

MockElement.prototype.addEventListener = function (name, fn) {
    if (!this.listeners[name]) this.listeners[name] = [];
    this.listeners[name].push(fn);
};

MockElement.prototype.focus = function () { this.focused = true; };

/* --------------------------------------------------------------- helpers */

MockElement.prototype.hasClass = function (name) {
    return (" " + this.className + " ").indexOf(" " + name + " ") >= 0;
};

/* Visible means: not hidden itself, and no hidden ancestor. A pane is hidden
 * by the tab logic, so a section inside it is invisible however its own flag
 * reads - which is the whole question a tab test is asking. */
MockElement.prototype.isVisible = function () {
    var node = this;
    while (node) {
        if (node.hidden) return false;
        node = node.parentNode;
    }
    return true;
};

MockElement.prototype.descends = function (ancestor) {
    var node = this.parentNode;
    while (node) {
        if (node === ancestor) return true;
        node = node.parentNode;
    }
    return false;
};

/* Every element under this one, in document order. */
MockElement.prototype.all = function () {
    var out = [], i;
    for (i = 0; i < this.children.length; i++) {
        out.push(this.children[i]);
        out = out.concat(this.children[i].all());
    }
    return out;
};

/* -------------------------------------------------------------- the parser */

/*
 * Deliberately small: this reads one file, written by this project, whose shape
 * is known. Comments, the doctype and self-closing inputs are all it has to
 * survive. Anything it cannot parse should be reported rather than guessed at,
 * because a silently mis-parsed panel would make every assertion below
 * meaningless.
 */
var VOID_TAGS = { input: 1, br: 1, hr: 1, img: 1, meta: 1, link: 1 };

function parse(html) {
    var root = new MockElement("body");
    var byId = {};
    var stack = [root];
    var i = 0;

    function push(element) {
        stack[stack.length - 1].appendChild(element);
        if (element.id) byId[element.id] = element;
    }

    while (i < html.length) {
        var lt = html.indexOf("<", i);
        if (lt < 0) break;

        /* Text between tags becomes the parent's text when it is the only
         * content - enough for a <span>Открыть</span>. */
        var text = html.substring(i, lt).replace(/\s+/g, " ");
        if (text.trim() && stack.length > 1) {
            var parent = stack[stack.length - 1];
            if (!parent.children.length) parent._text = text.trim();
        }

        if (html.substr(lt, 4) === "<!--") {
            i = html.indexOf("-->", lt);
            i = i < 0 ? html.length : i + 3;
            continue;
        }
        if (html.substr(lt, 2) === "<!") {
            i = html.indexOf(">", lt) + 1;
            continue;
        }

        var gt = html.indexOf(">", lt);
        if (gt < 0) break;
        var raw = html.substring(lt + 1, gt);
        i = gt + 1;

        if (raw.charAt(0) === "/") {
            var closing = raw.substring(1).trim().toLowerCase();
            /* Unwind to the matching open tag; a stray close is ignored rather
             * than allowed to corrupt the tree. */
            var depth;
            for (depth = stack.length - 1; depth > 0; depth--) {
                if (stack[depth].tagName.toLowerCase() === closing) {
                    stack.length = depth;
                    break;
                }
            }
            continue;
        }

        var selfClosing = raw.charAt(raw.length - 1) === "/";
        if (selfClosing) raw = raw.substring(0, raw.length - 1);

        var nameMatch = /^([A-Za-z][A-Za-z0-9]*)/.exec(raw);
        if (!nameMatch) continue;
        var tag = nameMatch[1].toLowerCase();

        if (tag === "script" || tag === "style") {
            var close = html.indexOf("</" + tag, i);
            i = close < 0 ? html.length : html.indexOf(">", close) + 1;
            continue;
        }

        var element = new MockElement(tag);
        var attrRe = /([A-Za-z-]+)(?:="([^"]*)")?/g;
        var attr;
        attrRe.lastIndex = nameMatch[1].length;
        while ((attr = attrRe.exec(raw))) {
            var key = attr[1];
            var value = attr[2] === undefined ? "" : attr[2];
            element.setAttribute(key, value);
            if (key === "class") element.className = value;
            if (key === "hidden") element.hidden = true;
            if (key === "title") element.title = value;
            if (key === "disabled") element.disabled = true;
        }

        push(element);
        if (!selfClosing && !VOID_TAGS[tag]) stack.push(element);
    }

    return { root: root, byId: byId };
}

/* ----------------------------------------------------------------- document */

function build(indexHtmlPath) {
    var html = fs.readFileSync(indexHtmlPath, "utf8");
    var tree = parse(html);

    var document = {
        readyState: "complete",
        activeElement: null,
        body: tree.root,
        listeners: {},

        getElementById: function (id) {
            return tree.byId[id] || null;
        },
        createElement: function (tag) { return new MockElement(tag); },
        createTextNode: function (text) {
            var node = new MockElement("#text");
            node.textContent = text;
            return node;
        },
        addEventListener: function (name, fn) {
            if (!this.listeners[name]) this.listeners[name] = [];
            this.listeners[name].push(fn);
        }
    };

    return { document: document, byId: tree.byId, root: tree.root };
}

module.exports = {
    build: build,
    MockElement: MockElement,
    htmlWrites: function () { return htmlWrites; },
    htmlWriters: function () { return htmlWriters.slice(); },
    resetHtmlWrites: function () { htmlWrites = 0; htmlWriters = []; },
    /* Path to the panel the extension actually ships. */
    indexPath: path.join(__dirname, "..", "extension", "com.pard.defender",
        "client", "index.html")
};
