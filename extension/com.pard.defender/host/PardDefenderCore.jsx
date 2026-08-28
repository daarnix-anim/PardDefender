/*
 * PardDefender - After Effects host script.
 *
 * ExtendScript is ES3 here: no JSON, no Object.keys, no Array.indexOf,
 * no let/const, no trailing commas. Everything below stays in that dialect.
 *
 * The host never copies media. It plans, and it relinks. All media I/O happens
 * in the CEP/Node layer, which can stream, verify and roll back a partial file;
 * File.copy() in ExtendScript gives none of that.
 */

(function () {
    var host = {};
    host.version = "1.0.0";

    /* ---------------------------------------------------------------- utils */

    function str(value) {
        try { return (value === null || value === undefined) ? "" : String(value); }
        catch (e) { return ""; }
    }

    function num(value, fallback) {
        var n = Number(value);
        return isFinite(n) ? n : fallback;
    }

    function inList(list, value) {
        var i;
        for (i = 0; i < list.length; i++) { if (list[i] === value) return true; }
        return false;
    }

    function keysOf(obj) {
        var out = [], k;
        for (k in obj) { if (obj.hasOwnProperty(k)) out.push(k); }
        return out;
    }

    function trim(value) {
        return str(value).replace(/^[\s\u00a0]+/, "").replace(/[\s\u00a0]+$/, "");
    }

    function lower(value) { return str(value).toLowerCase(); }

    /* --------------------------------------------------------- JSON encoding */

    function jsonString(value) {
        var s = str(value), out = "\"", i, c, code, hex;
        for (i = 0; i < s.length; i++) {
            c = s.charAt(i);
            code = s.charCodeAt(i);
            if (c === "\"") { out += "\\\""; continue; }
            if (c === "\\") { out += "\\\\"; continue; }
            if (c === "\n") { out += "\\n"; continue; }
            if (c === "\r") { out += "\\r"; continue; }
            if (c === "\t") { out += "\\t"; continue; }
            if (code < 32 || code > 126) {
                hex = code.toString(16);
                while (hex.length < 4) hex = "0" + hex;
                out += "\\u" + hex;
                continue;
            }
            out += c;
        }
        return out + "\"";
    }

    function jsonEncode(value) {
        var i, parts, k;
        if (value === null || value === undefined) return "null";
        if (typeof value === "boolean") return value ? "true" : "false";
        if (typeof value === "number") return isFinite(value) ? String(value) : "null";
        if (typeof value === "string") return jsonString(value);
        if (value instanceof Array) {
            parts = [];
            for (i = 0; i < value.length; i++) parts.push(jsonEncode(value[i]));
            return "[" + parts.join(",") + "]";
        }
        parts = [];
        for (k in value) {
            if (!value.hasOwnProperty(k)) continue;
            if (typeof value[k] === "function") continue;
            parts.push(jsonString(k) + ":" + jsonEncode(value[k]));
        }
        return "{" + parts.join(",") + "}";
    }

    /*
     * A deliberately small JSON reader. It only ever has to survive the settings
     * file and the plan files this same host wrote, so it does not aim to be a
     * conforming parser - it aims never to throw a confusing error at the user.
     */
    function jsonDecode(text) {
        var s = str(text), pos = 0;

        function ws() {
            while (pos < s.length && " \t\r\n".indexOf(s.charAt(pos)) >= 0) pos++;
        }

        function readString() {
            var out = "", c;
            if (s.charAt(pos) !== "\"") return "";
            pos++;
            while (pos < s.length) {
                c = s.charAt(pos++);
                if (c === "\"") break;
                if (c !== "\\") { out += c; continue; }
                c = s.charAt(pos++);
                if (c === "n") out += "\n";
                else if (c === "r") out += "\r";
                else if (c === "t") out += "\t";
                else if (c === "u") {
                    out += String.fromCharCode(parseInt(s.substr(pos, 4), 16));
                    pos += 4;
                } else out += c;
            }
            return out;
        }

        function readNumber() {
            var start = pos, n;
            while (pos < s.length && "-+.eE0123456789".indexOf(s.charAt(pos)) >= 0) pos++;
            n = Number(s.substring(start, pos));
            return isFinite(n) ? n : 0;
        }

        function readValue() {
            ws();
            var c = s.charAt(pos);
            if (c === "{") return readObject();
            if (c === "[") return readArray();
            if (c === "\"") return readString();
            if (s.substr(pos, 4) === "true") { pos += 4; return true; }
            if (s.substr(pos, 5) === "false") { pos += 5; return false; }
            if (s.substr(pos, 4) === "null") { pos += 4; return null; }
            return readNumber();
        }

        function readObject() {
            var out = {}, key;
            pos++; ws();
            if (s.charAt(pos) === "}") { pos++; return out; }
            while (pos < s.length) {
                ws();
                key = readString();
                ws();
                if (s.charAt(pos) === ":") pos++;
                out[key] = readValue();
                ws();
                if (s.charAt(pos) === ",") { pos++; continue; }
                if (s.charAt(pos) === "}") { pos++; break; }
                break;
            }
            return out;
        }

        function readArray() {
            var out = [];
            pos++; ws();
            if (s.charAt(pos) === "]") { pos++; return out; }
            while (pos < s.length) {
                out.push(readValue());
                ws();
                if (s.charAt(pos) === ",") { pos++; continue; }
                if (s.charAt(pos) === "]") { pos++; break; }
                break;
            }
            return out;
        }

        try { return readValue(); } catch (e) { return null; }
    }

    host.jsonEncode = jsonEncode;
    host.jsonDecode = jsonDecode;
    host.trimText = trim;

    /* ----------------------------------------------------------- file access */

    function readTextFile(path) {
        var f = new File(path), content = null;
        if (!f.exists) return null;
        try {
            f.encoding = "UTF-8";
            if (!f.open("r")) return null;
            content = f.read();
        } catch (e) { content = null; }
        try { f.close(); } catch (e2) {}
        return content;
    }

    function writeTextFile(path, content) {
        var f = new File(path), parent;
        try {
            parent = f.parent;
            if (parent && !parent.exists) parent.create();
            f.encoding = "UTF-8";
            if (!f.open("w")) return false;
            f.write(str(content));
        } catch (e) {
            try { f.close(); } catch (e2) {}
            return false;
        }
        try { f.close(); } catch (e3) {}
        return true;
    }

    host.readTextFile = readTextFile;
    host.writeTextFile = writeTextFile;

    /* ----------------------------------------------------------------- paths */

    function slashes(path) {
        return str(path).replace(/\\/g, "/").replace(/\/+$/, "");
    }

    function parentOf(path) {
        var p = slashes(path), index = p.lastIndexOf("/");
        return index <= 0 ? "" : p.substring(0, index);
    }

    function baseName(path) {
        var p = slashes(path), index = p.lastIndexOf("/");
        return index < 0 ? p : p.substring(index + 1);
    }

    function extensionOf(name) {
        var n = baseName(name), index = n.lastIndexOf(".");
        if (index <= 0) return "";
        return n.substring(index + 1).toLowerCase();
    }

    /* Path comparison that survives Windows case and separator differences. */
    function pathKey(path) { return lower(slashes(path)); }

    function isInside(child, ancestor) {
        var c = pathKey(child), a = pathKey(ancestor);
        if (!c || !a) return false;
        return c === a || c.substring(0, a.length + 1) === a + "/";
    }

    host.slashes = slashes;
    host.isInside = isInside;

    function tempFolder() {
        var path = slashes(Folder.temp.fsName) + "/parddefender";
        var folder = new Folder(path);
        if (!folder.exists) { try { folder.create(); } catch (e) {} }
        return path;
    }

    host.tempFolder = tempFolder;

    /*
     * Windows forbids <>:"/\|?* in a name and silently trims trailing dots and
     * spaces on create - which then makes the folder unreachable by full path.
     * Composition names are user text, so both cases have to be handled before
     * a branch name ever reaches mkdir.
     */
    function sanitizeSegment(value) {
        var cleaned = trim(str(value)).replace(/[<>:"\/\\|?*\x00-\x1f]/g, "_");
        while (cleaned.length && (cleaned.charAt(cleaned.length - 1) === "." ||
            cleaned.charAt(cleaned.length - 1) === " ")) {
            cleaned = cleaned.substring(0, cleaned.length - 1);
        }
        cleaned = trim(cleaned);
        if (cleaned.length > 64) cleaned = trim(cleaned.substring(0, 64));
        if (!cleaned) return "";
        /* Reserved Windows device names cannot be a path segment at all. */
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) {
            cleaned = "_" + cleaned;
        }
        return cleaned;
    }

    host.sanitizeSegment = sanitizeSegment;

    /* -------------------------------------------------------- classification */

    var CATEGORY_EXTENSIONS = {
        video: ("mp4 mov avi mxf mpg mpeg m4v mkv webm r3d braw ari arri mts m2ts " +
                "wmv flv ogv dv 3gp vob m2v mpe qt f4v").split(" "),
        image: ("jpg jpeg jpe png tif tiff bmp tga targa gif exr hdr dpx cin sgi " +
                "pict pct pcx iff webp heic heif avif dds psq raw cr2 cr3 nef arw " +
                "dng orf rw2 raf srw pbm ppm pgm jp2 j2k").split(" "),
        vector: "ai eps svg svgz pdf".split(" "),
        design: "psd psb".split(" "),
        model: ("obj c4d fbx abc glb gltf dae 3ds stl ply blend usd usda usdc usdz " +
                "e3d max ma mb").split(" "),
        data: "json csv mgjson txt xml lottie tsv".split(" "),
        project: "aep aepx aet prproj plproj".split(" "),
        audio: "wav mp3 aif aiff aifc m4a aac flac ogg oga wma opus caf mp2 au".split(" ")
    };

    var CATEGORY_ORDER = ["design", "vector", "model", "project", "audio",
        "video", "image", "data"];

    /* Project-panel folder name per category. */
    var CATEGORY_PANEL_NAME = {
        video: "VIDEO",
        image: "IMAGES",
        vector: "VECTOR",
        design: "DESIGN",
        model: "3D",
        data: "DATA",
        project: "PROJECTS",
        sequence: "SEQUENCES",
        audio: "AUDIO",
        other: "OTHER"
    };

    host.CATEGORY_PANEL_NAME = CATEGORY_PANEL_NAME;

    function categoryForExtension(ext) {
        var i, key;
        var e = lower(ext);
        if (!e) return "other";
        for (i = 0; i < CATEGORY_ORDER.length; i++) {
            key = CATEGORY_ORDER[i];
            if (inList(CATEGORY_EXTENSIONS[key], e)) return key;
        }
        return "other";
    }

    host.categoryForExtension = categoryForExtension;

    /* ------------------------------------------------------------- item kind */

    function isCompItem(item) {
        try { return typeof CompItem !== "undefined" && item instanceof CompItem; }
        catch (e) { return false; }
    }

    function isFolderItem(item) {
        try { return typeof FolderItem !== "undefined" && item instanceof FolderItem; }
        catch (e) { return false; }
    }

    function isFootageItem(item) {
        try { return typeof FootageItem !== "undefined" && item instanceof FootageItem; }
        catch (e) { return false; }
    }

    /* Solids, placeholders and the like have no file behind them. */
    function footageFile(item) {
        try {
            if (!isFootageItem(item)) return null;
            var source = item.mainSource;
            if (!source) return null;
            if (typeof SolidSource !== "undefined" && source instanceof SolidSource) return null;
            if (typeof PlaceholderSource !== "undefined" &&
                source instanceof PlaceholderSource) return null;
            if (!source.file) return null;
            return source.file;
        } catch (e) { return null; }
    }

    host.isCompItem = isCompItem;
    host.isFolderItem = isFolderItem;
    host.isFootageItem = isFootageItem;
    host.footageFile = footageFile;

    $.global.PardDefenderHost = host;
})();
