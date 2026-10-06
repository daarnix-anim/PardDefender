/*
 * PardDefender - Premiere Pro UXP Chunk Copy Engine & Relink Orchestrator
 *
 * @map role: Асинхронное поблочное копирование через UXP fs с инкрементальным SHA-256,
 *           временными файлами .pdpart, journal-before-copy в pending.tsv,
 *           фиксацией provenance в assets.tsv и безопасной перелинковкой клипов Premiere.
 * @map status: ready
 *
 * Enforces atomic writes, safe recovery, exact byte reuse, collision-safe naming,
 * and zero deletion of original media files.
 */
var PardPremiereCopyEngine = (function () {
    "use strict";

    var api = {};

    var fs = null;
    var path = null;
    var crypto = null;
    var ppro = null;
    var uxp = null;

    try { fs = require("fs"); } catch (e) {}
    try { path = require("path"); } catch (e) {}
    try { crypto = require("crypto"); } catch (e) {}
    try { ppro = require("premierepro"); } catch (e) {}
    try { uxp = require("uxp"); } catch (e) {}

    function ensureExistsSync(targetFs) {
        if (!targetFs) return;
        // UXP exposes lstatSync, not Node's statSync.
        if (typeof targetFs.statSync !== "function" && typeof targetFs.lstatSync === "function") {
            targetFs.statSync = function (p) { return targetFs.lstatSync(p); };
        }
        if (typeof targetFs.existsSync !== "function") {
            try {
                targetFs.existsSync = function (p) {
                    try {
                        if (typeof targetFs.statSync === "function") {
                            targetFs.statSync(p);
                            return true;
                        }
                        if (typeof targetFs.accessSync === "function") {
                            targetFs.accessSync(p);
                            return true;
                        }
                    } catch (e) {
                        return false;
                    }
                    return false;
                };
            } catch (ePoly) {}
        }
    }

    ensureExistsSync(fs);

    function ensurePathFallback(targetPath) {
        if (targetPath && typeof targetPath.dirname === "function" && targetPath.sep) return targetPath;
        var isWin = (typeof process !== "undefined" && process.platform === "win32") ||
                    (typeof navigator !== "undefined" && /win/i.test(navigator.platform || navigator.userAgent)) ||
                    true; // Premiere Windows default
        var sepChar = isWin ? "\\" : "/";
        return {
            sep: sepChar,
            dirname: function (p) {
                if (!p) return ".";
                var s = String(p).replace(/\\/g, "/");
                var idx = s.lastIndexOf("/");
                if (idx === -1) return ".";
                if (idx === 0) return "/";
                var d = s.substring(0, idx);
                return sepChar === "\\" ? d.replace(/\//g, "\\") : d;
            },
            basename: function (p, ext) {
                if (!p) return "";
                var s = String(p).replace(/\\/g, "/");
                var b = s.substring(s.lastIndexOf("/") + 1);
                if (ext && b.indexOf(ext) === b.length - ext.length) b = b.substring(0, b.length - ext.length);
                return b;
            },
            join: function () {
                var parts = [];
                for (var i = 0; i < arguments.length; i++) {
                    if (arguments[i]) parts.push(String(arguments[i]));
                }
                var joined = parts.join("/").replace(/\\/g, "/").replace(/\/+/g, "/");
                return sepChar === "\\" ? joined.replace(/\//g, "\\") : joined;
            }
        };
    }

    path = ensurePathFallback(path);

    api.setFs = function (customFs) {
        fs = customFs;
        ensureExistsSync(fs);
    };
    api.setPath = function (customPath) {
        path = ensurePathFallback(customPath);
    };
    api.setCrypto = function (customCrypto) { crypto = customCrypto; };
    api.setPpro = function (customPpro) { ppro = customPpro; };
    api.setUxp = function (customUxp) { uxp = customUxp; };

    function getPathCandidates(p) {
        if (!p) return [];
        var pStr = String(p).trim();
        pStr = pStr.replace(/^file:\/\/\/?/i, "");
        var fwd = pStr.replace(/\\/g, "/");
        var back = pStr.replace(/\//g, "\\");
        var list = [pStr, fwd, back];
        if (/^[a-zA-Z]:/.test(fwd)) {
            var driveLow = fwd.charAt(0).toLowerCase() + fwd.substring(1);
            var driveUp = fwd.charAt(0).toUpperCase() + fwd.substring(1);
            list.push(driveLow, driveUp, driveLow.replace(/\//g, "\\"), driveUp.replace(/\//g, "\\"));
        }
        var res = [];
        var seen = {};
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (item && !seen[item]) {
                seen[item] = true;
                res.push(item);
            }
        }
        return res;
    }

    api.getPathCandidates = getPathCandidates;

    // UXP exposes Promise-returning methods on fs itself, not Node's fs.promises.
    // Always use documented argument positions and observe both completion styles.
    var ioTimeout = 30000;
    api.setIoTimeout = function (ms) { ioTimeout = ms; };
    function filesystemErrorCode(error) {
        var codes = { "-4058": "ENOENT", "-4075": "EEXIST", "-4092": "EACCES",
            "-4048": "EPERM", "-4052": "ENOTDIR", "-4068": "EISDIR",
            "-2": "ENOENT", "-17": "EEXIST", "-13": "EACCES", "-20": "ENOTDIR" };
        var raw = error && (error.code !== undefined ? error.code :
            (error.errno !== undefined ? error.errno : error.number));
        if (typeof raw === "string" && /^[A-Z][A-Z0-9_]+$/.test(raw)) return raw;
        if (raw !== undefined && codes[String(raw)]) return codes[String(raw)];
        // Some UXP builds strip the code and retain only libuv's exact strerror.
        // Normalize once at the boundary; never treat an arbitrary failure as absence.
        if (uxp && raw === undefined) {
            var messages = { "no such file or directory": "ENOENT",
                "file already exists": "EEXIST", "permission denied": "EACCES",
                "operation not permitted": "EPERM", "not a directory": "ENOTDIR" };
            return messages[String(error && error.message || error).toLowerCase()] || "IO_ERROR";
        }
        return "IO_ERROR";
    }
    function filesystemError(error, method, args) {
        var code = filesystemErrorCode(error);
        var original = error && error.message || String(error);
        var reason = { ENOENT: "Путь не найден", EACCES: "Нет доступа",
            EPERM: "Операция запрещена", EEXIST: "Путь уже существует",
            ENOTDIR: "Путь не является папкой", IO_TIMEOUT: "Файловая система не ответила" }[code] || original;
        var file = typeof args[0] === "string" ? args[0] : "";
        var wrapped = new Error(reason + " [" + code + "; " + method + "]" + (file ? ": " + file : ""));
        wrapped.code = code;
        wrapped.operation = method;
        wrapped.path = file;
        wrapped.nativeMessage = original;
        return wrapped;
    }
    function io(method, args) {
        if (method === "stat" && fs && typeof fs.stat !== "function") method = "lstat";
        return new Promise(function (resolve, reject) {
            var settled = false;
            var timedOut = false;
            var timer = setTimeout(function () {
                settled = true;
                timedOut = true;
                var err = new Error("Нет ответа файловой системы: " + method);
                err.code = "IO_TIMEOUT";
                reject(filesystemError(err, method, args));
            }, ioTimeout);
            function done(err, value, buffer) {
                if (settled) {
                    // An open finishing after timeout must not leak a descriptor.
                    if (timedOut && !err && method === "open" && typeof value === "number") {
                        try { fs.close(value, function () {}); } catch (ignore) {}
                    }
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (err) { reject(filesystemError(err, method, args)); return; }
                if ((method === "read" || method === "write") && typeof value === "number") {
                    var result = { buffer: buffer };
                    result[method === "read" ? "bytesRead" : "bytesWritten"] = value;
                    resolve(result);
                } else resolve(value);
            }
            try {
                if (!fs || typeof fs[method] !== "function") throw new Error("fs." + method + " недоступен");
                var ret = fs[method].apply(fs, args.concat(done));
                if (ret && typeof ret.then === "function") ret.then(function (v) {
                    if (!settled) done(null, v);
                    else if (timedOut) done(null, v);
                }, function (e) { if (!settled) done(e); });
            } catch (e) { done(e); }
        });
    }
    api.io = io;
    api.writeJsonAtomic = async function (file, value) {
        var target = nativePath(file);
        var temp = target + "." + Date.now().toString(36) + Math.random().toString(36).slice(2) + ".tmp";
        await ensureDirectoryAsync(safeDirname(file));
        await io("writeFile", [temp, JSON.stringify(value, null, 2), { encoding: "utf-8" }]);
        // Rename replaces the old metadata atomically; never unlink it first.
        await io("rename", [temp, target]);
        return true;
    };
    function statAsync(p, callback) {
        io("stat", [nativePath(p)]).then(function (st) { callback(null, st, p); }, callback);
    }
    api.statAsync = statAsync;
    function resolveExistingPath(p) {
        if (!fs || !p) return null;
        var candidates = getPathCandidates(p);
        for (var i = 0; i < candidates.length; i++) {
            try { if (fs.statSync(candidates[i])) return candidates[i]; } catch (ignore) {}
        }
        return null;
    }
    api.resolveExistingPath = resolveExistingPath;
    api.resolveExistingPathAsync = function (p, cb) {
        statAsync(p, function (err, st, found) { cb(err ? null : found); });
    };
    function fileExists(p) { return !!resolveExistingPath(p); }
    api.fileExists = fileExists;
    api.inspectFileError = function (p) { return fileExists(p) ? "exists" : "not_found"; };

    function asBytes(buffer) {
        return buffer instanceof ArrayBuffer ? new Uint8Array(buffer) :
            new Uint8Array(buffer.buffer, buffer.byteOffset || 0, buffer.byteLength);
    }
    function allocChunk() {
        // Native UXP requires ArrayBuffer. Node's fs requires an ArrayBufferView.
        return uxp ? new ArrayBuffer(256 * 1024) : new Uint8Array(256 * 1024);
    }
    async function streamFile(src, dst, progress) {
        var reader = null, writer = null, position = 0;
        var hash = api.createSha256();
        try {
            reader = await io("open", [nativePath(src), "r", 438]);
            if (dst) writer = await io("open", [nativePath(dst), "wx", 438]);
            var buffer = allocChunk();
            while (true) {
                var read = await io("read", [reader, buffer, 0, buffer.byteLength, position]);
                var n = read && read.bytesRead;
                if (typeof n !== "number" || n < 0 || n > buffer.byteLength) throw new Error("Некорректный результат чтения");
                if (!n) break;
                var readBuffer = read.buffer || buffer;
                hash.update(asBytes(readBuffer).subarray(0, n));
                if (dst) {
                    var offset = 0;
                    while (offset < n) {
                        var wrote = await io("write", [writer, readBuffer, offset, n - offset, position + offset]);
                        var count = wrote && wrote.bytesWritten;
                        if (!(count > 0 && count <= n - offset)) throw new Error("Неполная запись файла");
                        offset += count;
                    }
                }
                position += n;
                if (progress) progress(position);
                // Yield even if the host settles Promises synchronously.
                await new Promise(function (resolve) { setTimeout(resolve, 0); });
            }
            return { size: position, hash: hash.digest() };
        } finally {
            try { if (writer !== null) await io("close", [writer]); }
            finally { if (reader !== null) await io("close", [reader]); }
        }
    }
    function copyFileAsync(src, dst, callback) {
        streamFile(src, dst).then(function () { callback(null); }, callback);
    }
    api.copyFileAsync = copyFileAsync;
    function mkdirAsync(dir, cb) {
        ensureDirectoryAsync(dir).then(function () { cb(null); }, cb);
    }
    api.mkdirAsync = mkdirAsync;
    function renameAsync(src, dst, cb) {
        io("rename", [nativePath(src), nativePath(dst)]).then(function () { cb(null); }, cb);
    }
    api.renameAsync = renameAsync;
    function unlinkAsync(p, cb) {
        io("unlink", [nativePath(p)]).then(function () { if (cb) cb(null); }, function (e) { if (cb) cb(e); });
    }
    api.unlinkAsync = unlinkAsync;
    function appendFileAsync(p, text, cb) {
        io("writeFile", [nativePath(p), text, { encoding: "utf-8", flag: "a" }]).then(function () { cb(null); }, cb);
    }
    api.appendFileAsync = appendFileAsync;
    function readFileAsync(p, cb) {
        io("readFile", [nativePath(p), { encoding: "utf-8" }]).then(function (s) { cb(null, s); }, cb);
    }
    api.readFileAsync = readFileAsync;
    function writeFileAsync(p, text, cb) {
        io("writeFile", [nativePath(p), text, { encoding: "utf-8" }]).then(function () { cb(null); }, cb);
    }
    api.writeFileAsync = writeFileAsync;

    function ensureDir(dir) {
        if (!fs || !dir) return false;
        var ex = resolveExistingPath(dir);
        if (ex) return true;

        var candidates = getPathCandidates(dir);
        for (var c = 0; c < candidates.length; c++) {
            try {
                if (typeof fs.mkdirSync === "function") {
                    fs.mkdirSync(candidates[c], { recursive: true });
                    if (fileExists(candidates[c])) return true;
                }
            } catch (eMk) {}
        }
        try {
            var norm = normalizePath(dir);
            var parts = norm.split("/");
            var cur = "";
            for (var i = 0; i < parts.length; i++) {
                cur = cur ? cur + "/" + parts[i] : parts[i];
                if (!cur || /^[a-zA-Z]:$/.test(cur)) continue;
                if (!fileExists(cur) && typeof fs.mkdirSync === "function") {
                    try { fs.mkdirSync(cur); } catch (eSub1) {
                        try { fs.mkdirSync(cur.replace(/\//g, "\\")); } catch (eSub2) {}
                    }
                }
            }
            return fileExists(dir);
        } catch (eWalk) {
            return false;
        }
    }

    api.ensureDir = ensureDir;

    function nativePath(p) {
        if (!p) return "";
        return path ? String(p).replace(/\//g, path.sep) : String(p);
    }

    function normalizePath(p) {
        if (!p) return "";
        var s = String(p).trim().replace(/\\/g, "/");
        s = s.replace(/^\/+(\?|\.)\//, "");
        s = s.replace(/\/+/g, "/");
        if (/^[a-zA-Z]:\//.test(s)) {
            s = s.charAt(0).toLowerCase() + s.substring(1);
        }
        if (s.length > 3 && s.charAt(s.length - 1) === "/") {
            s = s.substring(0, s.length - 1);
        }
        return s;
    }

    api.normalizePath = normalizePath;

    function safeDirname(p) {
        if (!p) return "";
        if (path && typeof path.dirname === "function") {
            try { return path.dirname(p); } catch (e) {}
        }
        var s = String(p).replace(/\\/g, "/");
        var idx = s.lastIndexOf("/");
        if (idx === -1) return ".";
        if (idx === 0) return "/";
        return s.substring(0, idx);
    }

    api.safeDirname = safeDirname;

    function stripSuffixes(stem) {
        if (!stem) return "";
        var s = String(stem).trim().replace(/\u2026/g, "...");
        // 1. Cut duration suffix (e.g. ' - 15', ' - 30s', '_15s')
        s = s.replace(/[\s\-_]+(?:[0-9]{1,4}s?)$/i, "");
        // 2. Duplicate words (copy, копия, duplicate, дубликат, dup)
        s = s.replace(/[\s\-_]+(?:\(|\[)?(?:copy|копия|duplicate|дубликат|dup)(?:\s*\d+)?(?:\)|\])?$/i, "");
        // 3. Duplicate number at end (e.g. 'foo 2', 'foo (2)', 'foo [2]', 'foo_01')
        s = s.replace(/\s*(?:\(\d+\)|\[\d+\])$/, "").replace(/\s+\d+$/, "").replace(/_\d{1,2}$/, "");
        // 4. AI upscale / DLSS / Topaz / timestamp suffixes
        s = s.replace(/_(?:dlss\d*|topaz|upscale|upscaled|enhanced?|ai|super_?res)(?:[_\-][\w\d]+)*/i, "");
        // 5. Version / take / cut suffix (e.g. '_v1', ' take 2', '_cut3')
        s = s.replace(/[_\s]+(?:take\d+|cut\d+|v\d+|ver\d+|draft\d+)$/i, "");
        // 6. Clean up any trailing punctuation or whitespace
        s = s.replace(/[\s\-_]+$/, "");
        return s.trim();
    }

    function normalizeKey(str) {
        if (!str) return "";
        return String(str).toLowerCase().trim().replace(/\u2026/g, "...");
    }

    function lookupMatch(dict, name) {
        if (!dict || !name) return null;
        var low = normalizeKey(name);
        if (!low) return null;
        if (dict[low]) return dict[low];

        var dotsVariant = low.replace(/\.\.\./g, "\u2026");
        if (dict[dotsVariant]) return dict[dotsVariant];

        var spaces = low.replace(/_/g, " ");
        if (dict[spaces]) return dict[spaces];

        var underscores = low.replace(/\s+/g, "_");
        if (dict[underscores]) return dict[underscores];

        var noExt = low.replace(/\.[^.]+$/, "");
        if (dict[noExt]) return dict[noExt];

        var noExtSpaces = spaces.replace(/\.[^.]+$/, "");
        if (dict[noExtSpaces]) return dict[noExtSpaces];

        var noExtUnderscores = underscores.replace(/\.[^.]+$/, "");
        if (dict[noExtUnderscores]) return dict[noExtUnderscores];

        var stripped = stripSuffixes(noExt);
        if (stripped) {
            if (dict[stripped]) return dict[stripped];
            var sDots = stripped.replace(/\.\.\./g, "\u2026");
            if (dict[sDots]) return dict[sDots];
            var sSpaces = stripped.replace(/_/g, " ");
            if (dict[sSpaces]) return dict[sSpaces];
            var sUnderscores = stripped.replace(/\s+/g, "_");
            if (dict[sUnderscores]) return dict[sUnderscores];
            var ext = low.indexOf(".") !== -1 ? low.substring(low.lastIndexOf(".")) : "";
            if (ext) {
                if (dict[stripped + ext]) return dict[stripped + ext];
                if (dict[(stripped + ext).replace(/_/g, " ")]) return dict[(stripped + ext).replace(/_/g, " ")];
            }
        }

        return null;
    }

    api.stripSuffixes = stripSuffixes;
    api.normalizeKey = normalizeKey;
    api.lookupMatch = lookupMatch;

    var VALID_PROJECT_MEDIA_FOLDERS = [
        "01_assets",
        "03_audio",
        "sound",
        "05_shot_production",
        "shot_production",
        "shot production"
    ];

    function isInProjectMediaFolder(pNorm, normWs) {
        if (!pNorm || !normWs) return false;
        var p = normalizePath(pNorm);
        var w = normalizePath(normWs);
        var pLow = p.toLowerCase();
        var wLow = w.toLowerCase();
        if (pLow.indexOf(wLow + "/") !== 0) return false;
        var rel = p.substring(w.length + 1);
        if (rel.indexOf("/") === -1) return false;
        var topFolder = rel.substring(0, rel.indexOf("/")).toLowerCase();
        return VALID_PROJECT_MEDIA_FOLDERS.indexOf(topFolder) !== -1;
    }

    api.isInProjectMediaFolder = isInProjectMediaFolder;

    function loadWorkspaceMeta(ws) {
        var meta = {
            settings: null,
            assetsTsv: {},
            existingFolders: {
                sound: false,
                audio: false,
                shotProd05: false,
                shotProdSpace: false,
                shotProdUnderscore: false,
                assets: false
            }
        };
        if (!ws) return meta;
        var normWs = normalizePath(ws);

        if (fs) {
            function checkDir(rel) {
                try {
                    var full = normWs + "/" + rel;
                    var nativeF = path ? full.replace(/\//g, path.sep) : full;
                    return fileExists(nativeF);
                } catch (e) { return false; }
            }

            meta.existingFolders = {
                sound: checkDir("sound"),
                audio: checkDir("03_audio"),
                shotProd05: checkDir("05_shot_production"),
                shotProdSpace: checkDir("shot production"),
                shotProdUnderscore: checkDir("shot_production"),
                assets: checkDir("01_assets")
            };

            // Load settings.json
            try {
                var setPath = normWs + "/.parddefender/settings.json";
                var nativeSet = path ? setPath.replace(/\//g, path.sep) : setPath;
                if (fileExists(nativeSet)) {
                    meta.settings = JSON.parse(fs.readFileSync(nativeSet, { encoding: "utf-8" }));
                }
            } catch (eSet) {}

            function indexMetaVariation(dict, name, val) {
                if (!dict || !name || !val) return;
                var low = normalizeKey(name);
                if (!low) return;

                var variants = [
                    low,
                    low.replace(/\.\.\./g, "\u2026"),
                    low.replace(/_/g, " "),
                    low.replace(/\s+/g, "_")
                ];

                var noExt = low.replace(/\.[^.]+$/, "");
                var ext = low.indexOf(".") !== -1 ? low.substring(low.lastIndexOf(".")) : "";
                variants.push(noExt);
                variants.push(noExt.replace(/\.\.\./g, "\u2026"));
                variants.push(noExt.replace(/_/g, " "));
                variants.push(noExt.replace(/\s+/g, "_"));

                var stripped = stripSuffixes(noExt);
                if (stripped && stripped !== noExt) {
                    variants.push(stripped);
                    variants.push(stripped.replace(/\.\.\./g, "\u2026"));
                    variants.push(stripped.replace(/_/g, " "));
                    variants.push(stripped.replace(/\s+/g, "_"));
                    if (ext) {
                        variants.push(stripped + ext);
                        variants.push((stripped + ext).replace(/\.\.\./g, "\u2026"));
                        variants.push((stripped + ext).replace(/_/g, " "));
                        variants.push((stripped + ext).replace(/\s+/g, "_"));
                    }
                }

                for (var vi = 0; vi < variants.length; vi++) {
                    var v = variants[vi].trim();
                    if (v && !dict[v]) dict[v] = val;
                }
            }

            // Load assets.tsv
            meta.aeByNameAndSize = {};
            meta.aeByHash = {};

            try {
                var tsvPath = normWs + "/.parddefender/assets.tsv";
                var nativeTsv = path ? tsvPath.replace(/\//g, path.sep) : tsvPath;
                if (fileExists(nativeTsv)) {
                    var content = fs.readFileSync(nativeTsv, { encoding: "utf-8" });
                    var lines = content.split("\n");
                    for (var i = 0; i < lines.length; i++) {
                        var line = lines[i].trim();
                        if (!line) continue;
                        var cols = line.split("\t");
                        // cols: timestamp, id, oldPath, size, canonicalPath, branch, category, hash
                        if (cols.length >= 5) {
                            var oldP = cols[2] ? normalizePath(cols[2]) : "";
                            var canP = cols[4] ? normalizePath(cols[4]) : "";
                            if (canP) {
                                var ext = canP.indexOf(".") !== -1 ? canP.substring(canP.lastIndexOf(".") + 1).toLowerCase() : "";
                                var is3D = /^(c4d|obj|fbx|abc|glb|gltf|e3d)$/.test(ext) || cols[6] === "model" || cols[6] === "3d";
                                if (is3D) continue;

                                if (cols[8] === "premiere") continue;
                                var cSize = parseInt(cols[3], 10) || 0;
                                var cName = canP.substring(canP.lastIndexOf("/") + 1).toLowerCase();
                                var cHash = cols[7] ? String(cols[7]).toLowerCase() : "";

                                if (oldP) {
                                    meta.assetsTsv[oldP.toLowerCase()] = canP;
                                    var oldBase = oldP.substring(oldP.lastIndexOf("/") + 1).toLowerCase();
                                    indexMetaVariation(meta.assetsTsv, oldBase, canP);
                                }
                                indexMetaVariation(meta.assetsTsv, cName, canP);
                                meta.assetsTsv[canP.toLowerCase()] = canP;

                                if (cSize > 0) {
                                    meta.aeByNameAndSize[cName + ":" + cSize] = canP;
                                    var noExtTsv = cName.replace(/\.[^.]+$/, "");
                                    var sTsv = stripSuffixes(noExtTsv);
                                    if (sTsv) {
                                        meta.aeByNameAndSize[sTsv + (ext ? ("." + ext) : "") + ":" + cSize] = canP;
                                        meta.aeByNameAndSize[sTsv + ":" + cSize] = canP;
                                    }
                                }
                                if (cHash) {
                                    meta.aeByHash[cHash] = canP;
                                }
                            }
                        }
                    }
                }
            } catch (eTsv) {}

            // Load AE snapshots (.parddefender/projects/*.media.json)
            meta.aeAssets = {};
            meta.aeCanonicalPaths = {};
            try {
                var pDir = normWs + "/.parddefender/projects";
                var nativePDir = path ? pDir.replace(/\//g, path.sep) : pDir;
                if (fileExists(nativePDir)) {
                    var snapFiles = fs.readdirSync(nativePDir);
                    for (var fi = 0; fi < snapFiles.length; fi++) {
                        if (snapFiles[fi].slice(-11) === ".media.json") {
                            try {
                                var sContent = fs.readFileSync(nativePDir + (path ? path.sep : "/") + snapFiles[fi], { encoding: "utf-8" });
                                var snap = JSON.parse(sContent);
                                if (snap && (snap.host === "aftereffects" || snap.host === "after-effects" || snap.host === "ae")) {
                                    var sItems = snap.items || [];
                                    for (var sj = 0; sj < sItems.length; sj++) {
                                        var sIt = sItems[sj];
                                        if (sIt && sIt.path) {
                                            var sNorm = normalizePath(sIt.path);
                                            if (sNorm.indexOf("/") !== 0 && !/^[a-zA-Z]:\//.test(sNorm)) {
                                                sNorm = normWs + "/" + sNorm;
                                            }
                                            var sExt = sNorm.indexOf(".") !== -1 ? sNorm.substring(sNorm.lastIndexOf(".") + 1).toLowerCase() : "";
                                            var is3Dsnap = /^(c4d|obj|fbx|abc|glb|gltf|e3d)$/.test(sExt) || sIt.classification === "model" || sIt.classification === "3d";
                                            if (is3Dsnap) continue;

                                            var sBase = sNorm.substring(sNorm.lastIndexOf("/") + 1).toLowerCase();
                                            var sSize = sIt.size || 0;
                                            var sHash = sIt.contentId ? String(sIt.contentId).toLowerCase() : "";

                                            meta.aeAssets[sNorm.toLowerCase()] = sNorm;
                                            indexMetaVariation(meta.aeAssets, sBase, sNorm);
                                            if (sIt.name) {
                                                indexMetaVariation(meta.aeAssets, sIt.name, sNorm);
                                            }
                                            if (sIt.oldPath) {
                                                var sOldNorm = normalizePath(sIt.oldPath);
                                                meta.aeAssets[sOldNorm.toLowerCase()] = sNorm;
                                                var sOldBase = sOldNorm.substring(sOldNorm.lastIndexOf("/") + 1).toLowerCase();
                                                indexMetaVariation(meta.aeAssets, sOldBase, sNorm);
                                            }
                                            if (sSize > 0) {
                                                meta.aeByNameAndSize[sBase + ":" + sSize] = sNorm;
                                                if (sIt.name) meta.aeByNameAndSize[sIt.name.toLowerCase() + ":" + sSize] = sNorm;
                                                var noExtSnap = sBase.replace(/\.[^.]+$/, "");
                                                var sSnap = stripSuffixes(noExtSnap);
                                                if (sSnap) {
                                                    meta.aeByNameAndSize[sSnap + (sExt ? ("." + sExt) : "") + ":" + sSize] = sNorm;
                                                    meta.aeByNameAndSize[sSnap + ":" + sSize] = sNorm;
                                                }
                                            }
                                            if (sHash) {
                                                meta.aeByHash[sHash] = sNorm;
                                            }
                                            meta.aeCanonicalPaths[sNorm.toLowerCase()] = {
                                                path: sNorm,
                                                contentId: sIt.contentId,
                                                size: sIt.size,
                                                classification: sIt.classification
                                            };
                                        }
                                    }
                                }
                            } catch (eSnap) {}
                        }
                    }
                }
            } catch (eProjDir) {}
        }
        return meta;
    }

    api.loadWorkspaceMeta = loadWorkspaceMeta;

    api.isAudio = function (it) {
        return /\.(mp3|wav|aif|aiff|aifc|m4a|aac|flac|ogg|oga|wma|opus|caf|mp2|au)$/i.test(it.path || "");
    };
    api.audioRole = function (it) {
        if (/^(voice|music|sfx)$/.test(it.audioRole || "")) return it.audioRole;
        var hints = [it.binPath || "", it.name || "", it.path || ""].join("/");
        if (/(^|[^a-zа-яё0-9])(vo|voice|voiceover|narration|dialogue|dialog|dictor|speech|rec|голос|диктор|озвучка|речь|elevenlabs|eleven|tts)([^a-zа-яё0-9]|$)/i.test(hints)) return "voice";
        if (/(^|[^a-zа-яё0-9])(sfx|effect|fx|whoosh|hit|impact|foley|noise|sound|шум|эффект)([^a-zа-яё0-9]|$)/i.test(hints)) return "sfx";
        if (/(^|[^a-zа-яё0-9])(music|song|track|музыка|песня)([^a-zа-яё0-9]|$)/i.test(hints)) return "music";
        return "unknown";
    };

    function resolveDestination(it, ws, meta) {
        var normWs = normalizePath(ws);
        var pNorm = normalizePath(it && it.path ? it.path : (typeof it === "string" ? it : ""));
        var fName = pNorm.substring(pNorm.lastIndexOf("/") + 1);
        var dotIdx = fName.lastIndexOf(".");
        var ext = dotIdx !== -1 ? fName.substring(dotIdx + 1).toLowerCase() : "";
        var lowerName = fName.toLowerCase();
        meta = meta || { existingFolders: {}, assetsTsv: {}, aeAssets: {}, aeByNameAndSize: {}, aeByHash: {} };

        var clipDisplayName = (it && it.name ? String(it.name) : "").toLowerCase();

        // Audio authority is Premiere, including files previously copied by AE.
        if (api.isAudio(it)) {
            var role = api.audioRole(it);
            return {
                category: "audio", branch: role, audioRole: role,
                needsAudioRole: role === "unknown",
                destPath: normWs + "/03_audio/" + (role === "unknown" ? "" : role + "/") + fName
            };
        }

        // Visual media may reuse verified After Effects canonicals.
        var knownProtected = "";
        var matchReason = "";

        // Match by hash (contentId)
        if (it && it.contentId && meta.aeByHash && meta.aeByHash[String(it.contentId).toLowerCase()]) {
            knownProtected = meta.aeByHash[String(it.contentId).toLowerCase()];
            matchReason = "hash";
        }

        // Match by name + size
        var fSize = (it && it.size) || 0;
        if (!fSize && pNorm && fs) {
            try {
                var nativeP = path ? pNorm.replace(/\//g, path.sep) : pNorm;
                fSize = fs.statSync(nativeP).size;
            } catch (eSt) {}
        }

        if (!knownProtected && fSize > 0 && meta.aeByNameAndSize) {
            var k1 = lowerName + ":" + fSize;
            if (meta.aeByNameAndSize[k1]) {
                knownProtected = meta.aeByNameAndSize[k1];
                matchReason = "name_and_size";
            }
            if (!knownProtected && clipDisplayName) {
                var k2 = clipDisplayName + ":" + fSize;
                if (meta.aeByNameAndSize[k2]) {
                    knownProtected = meta.aeByNameAndSize[k2];
                    matchReason = "name_and_size";
                }
            }
            if (!knownProtected) {
                var noExtM = lowerName.replace(/\.[^.]+$/, "");
                var extM = lowerName.indexOf(".") !== -1 ? lowerName.substring(lowerName.lastIndexOf(".")) : "";
                var strippedM = stripSuffixes(noExtM);
                if (strippedM) {
                    var k3 = (strippedM + extM) + ":" + fSize;
                    if (meta.aeByNameAndSize[k3]) {
                        knownProtected = meta.aeByNameAndSize[k3];
                        matchReason = "stripped_name_and_size";
                    } else if (meta.aeByNameAndSize[strippedM + ":" + fSize]) {
                        knownProtected = meta.aeByNameAndSize[strippedM + ":" + fSize];
                        matchReason = "stripped_name_and_size";
                    }
                }
            }
        }

        // Fallback match by name/path lookup
        if (!knownProtected && meta.aeAssets) {
            var aeMatch = (pNorm && meta.aeAssets[pNorm.toLowerCase()]) ||
                          lookupMatch(meta.aeAssets, lowerName) ||
                          lookupMatch(meta.aeAssets, clipDisplayName);
            if (aeMatch && isInProjectMediaFolder(aeMatch, normWs)) {
                knownProtected = aeMatch;
                matchReason = "name";
            }
        }
        if (!knownProtected && meta.assetsTsv) {
            var tsvMatch = (pNorm && meta.assetsTsv[pNorm.toLowerCase()]) ||
                           lookupMatch(meta.assetsTsv, lowerName) ||
                           lookupMatch(meta.assetsTsv, clipDisplayName);
            if (tsvMatch && isInProjectMediaFolder(tsvMatch, normWs)) {
                knownProtected = tsvMatch;
                matchReason = "name";
            }
        }

        if (knownProtected) {
            var cat = "other";
            if (/^(mp3|wav|aif|aiff|aifc|m4a|aac|flac|ogg|oga|wma|opus|caf|mp2|au)$/.test(ext)) cat = "audio";
            else if (/^(mp4|mov|avi|mkv|mxf|wmv|flv|webm|m4v|prores|r3d|braw|mts|m2ts|vob|mpg|mpeg|3gp)$/.test(ext)) cat = "video";
            else if (ext === "psd" || ext === "psb") cat = "design";
            else if (ext === "ai" || ext === "eps" || ext === "svg") cat = "vector";
            else if (/^(png|jpg|jpeg|tga|tiff|tif|exr|bmp|webp|gif|dpx|cr2|cr3|nef|arw|dng)$/.test(ext)) cat = "images";
            else if (/^(c4d|obj|fbx|abc|glb|gltf|e3d)$/.test(ext)) cat = "model";
            else if (/^(json|csv|mgjson|lottie|txt|xml|pdf)$/.test(ext)) cat = "data";

            var isShared = knownProtected.indexOf("/_SHARED/") !== -1;
            return {
                category: cat,
                destPath: knownProtected,
                branch: isShared ? "_SHARED" : "",
                isAeCanonical: true,
                matchReason: matchReason
            };
        }

        // Audio routing is resolved before cross-host visual matches.

        // 2. Image sequences (3D render, sequence of numbered frames)
        var isImageSeq = !!(it && (it.isSequence || it.classification === "sequence")) ||
                         /[_\-\.]\d{3,8}\.(exr|png|jpg|jpeg|tif|tiff|dpx|tga)$/i.test(fName);
        if (isImageSeq) {
            var parentDir = "";
            if (pNorm.indexOf("/") !== -1) {
                var pParts = pNorm.split("/");
                if (pParts.length > 1) parentDir = pParts[pParts.length - 2];
            }
            var seqSub = parentDir || fName.replace(/\.[^.]+$/, "").replace(/[_\-\.]\d{3,8}$/, "");
            return {
                category: "video",
                destPath: normWs + "/05_shot_production/" + (seqSub ? (seqSub + "/") : "") + fName,
                branch: "shot_production"
            };
        }

        // 3. Single Images -> 01_assets (or 01_assets/_SHARED/IMAGES if _SHARED exists)
        if (/^(png|jpg|jpeg|tga|tiff|tif|exr|bmp|webp|gif|dpx|cr2|cr3|nef|arw|dng|psd|psb|ai|eps|svg)$/.test(ext)) {
            var imgDest = (meta.existingFolders && meta.existingFolders.assets) ? (normWs + "/01_assets/_SHARED/IMAGES/" + fName) : (normWs + "/01_assets/" + fName);
            return {
                category: "images",
                destPath: imgDest,
                branch: "_SHARED"
            };
        }

        // 4. Single Video -> 01_assets/_SHARED/VIDEO (or shot_production if assets does not exist)
        if (/^(mp4|mov|avi|mkv|mxf|wmv|flv|webm|m4v|prores|r3d|braw|mts|m2ts|vob|mpg|mpeg|3gp)$/.test(ext)) {
            var vidFolder = "01_assets";
            var vidDest = normWs + "/01_assets/_SHARED/VIDEO/" + fName;
            return {
                category: "video",
                destPath: vidDest,
                branch: (vidFolder === "01_assets") ? "_SHARED" : "shot_production"
            };
        }

        // 6. 3D
        if (/^(c4d|obj|fbx|abc|glb|gltf|e3d)$/.test(ext)) {
            return {
                category: "model",
                destPath: normWs + "/01_assets/_SHARED/3D/" + fName,
                branch: "_SHARED"
            };
        }

        // 7. Data
        if (/^(json|csv|mgjson|lottie|txt|xml|pdf)$/.test(ext)) {
            return {
                category: "data",
                destPath: normWs + "/01_assets/_SHARED/DATA/" + fName,
                branch: "_SHARED"
            };
        }

        // 8. Other
        return {
            category: "other",
            destPath: normWs + "/01_assets/_SHARED/OTHER/" + fName,
            branch: "_SHARED"
        };
    }

    function resolveUnusedDestination(it, normWs) {
        var pNorm = (it && (it.path || it.mediaPath || "")) ? String(it.path || it.mediaPath).replace(/\\/g, "/") : "";
        var fName = (it && (it.name || it.fileName)) ? String(it.name || it.fileName) : (pNorm.substring(pNorm.lastIndexOf("/") + 1) || "file");
        var ext = fName.indexOf(".") !== -1 ? fName.substring(fName.lastIndexOf(".") + 1).toLowerCase() : "";

        // 1. Audio
        if (/^(wav|mp3|aac|m4a|aif|aiff|flac|ogg)$/.test(ext)) {
            return {
                category: "audio",
                destPath: normWs + "/unused/AUDIO/" + fName,
                branch: "unused"
            };
        }

        // 2. Image sequences
        var isImageSeq = !!(it && (it.isSequence || it.classification === "sequence")) ||
                         /[_\-\.]\d{3,8}\.(exr|png|jpg|jpeg|tif|tiff|dpx|tga)$/i.test(fName);
        if (isImageSeq) {
            var parentDir = "";
            if (pNorm.indexOf("/") !== -1) {
                var pParts = pNorm.split("/");
                if (pParts.length > 1) parentDir = pParts[pParts.length - 2];
            }
            var seqSub = parentDir || fName.replace(/\.[^.]+$/, "").replace(/[_\-\.]\d{3,8}$/, "");
            return {
                category: "sequence",
                destPath: normWs + "/unused/SEQUENCES/" + (seqSub ? (seqSub + "/") : "") + fName,
                branch: "unused"
            };
        }

        // 3. Images
        if (/^(png|jpg|jpeg|tga|tiff|tif|exr|bmp|webp|gif|dpx|cr2|cr3|nef|arw|dng|psd|psb|ai|eps|svg)$/.test(ext)) {
            return {
                category: "images",
                destPath: normWs + "/unused/IMAGES/" + fName,
                branch: "unused"
            };
        }

        // 4. Video
        if (/^(mp4|mov|avi|mkv|mxf|wmv|flv|webm|m4v|prores|r3d|braw|mts|m2ts|vob|mpg|mpeg|3gp)$/.test(ext)) {
            return {
                category: "video",
                destPath: normWs + "/unused/VIDEO/" + fName,
                branch: "unused"
            };
        }

        // 5. 3D Model
        if (/^(c4d|obj|fbx|abc|glb|gltf|e3d)$/.test(ext)) {
            return {
                category: "model",
                destPath: normWs + "/unused/3D/" + fName,
                branch: "unused"
            };
        }

        // 6. Data
        if (/^(json|csv|mgjson|lottie|txt|xml|pdf)$/.test(ext)) {
            return {
                category: "data",
                destPath: normWs + "/unused/DATA/" + fName,
                branch: "unused"
            };
        }

        // 7. Other
        return {
            category: "other",
            destPath: normWs + "/unused/OTHER/" + fName,
            branch: "unused"
        };
    }

    api.resolveDestination = resolveDestination;
    api.resolveUnusedDestination = resolveUnusedDestination;

    /* ------------------------------------------------ Pure JS SHA-256 (NIST) */

    function createSha256() {
        if (crypto && typeof crypto.createHash === "function") {
            var h = crypto.createHash("sha256");
            return {
                update: function (chunk) {
                    if (typeof chunk === "string") {
                        h.update(chunk, "utf8");
                    } else {
                        h.update(chunk);
                    }
                },
                digest: function () {
                    return h.digest("hex");
                }
            };
        }

        // Fallback pure JS incremental SHA-256 for UXP environments without crypto.createHash
        var K = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];

        var H = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        ];

        var buffer = [];
        var totalBytes = 0;

        function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }

        function processBlock(block) {
            var W = new Array(64);
            for (var t = 0; t < 16; t++) {
                W[t] = ((block[t * 4] & 0xff) << 24) |
                       ((block[t * 4 + 1] & 0xff) << 16) |
                       ((block[t * 4 + 2] & 0xff) << 8) |
                       (block[t * 4 + 3] & 0xff);
            }
            for (t = 16; t < 64; t++) {
                var s0 = rotr(7, W[t - 15]) ^ rotr(18, W[t - 15]) ^ (W[t - 15] >>> 3);
                var s1 = rotr(17, W[t - 2]) ^ rotr(19, W[t - 2]) ^ (W[t - 2] >>> 10);
                W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
            }

            var a = H[0], b = H[1], c = H[2], d = H[3],
                e = H[4], f = H[5], g = H[6], h = H[7];

            for (t = 0; t < 64; t++) {
                var S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
                var ch = (e & f) ^ ((~e) & g);
                var temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
                var S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
                var maj = (a & b) ^ (a & c) ^ (b & c);
                var temp2 = (S0 + maj) | 0;

                h = g;
                g = f;
                f = e;
                e = (d + temp1) | 0;
                d = c;
                c = b;
                b = a;
                a = (temp1 + temp2) | 0;
            }

            H[0] = (H[0] + a) | 0;
            H[1] = (H[1] + b) | 0;
            H[2] = (H[2] + c) | 0;
            H[3] = (H[3] + d) | 0;
            H[4] = (H[4] + e) | 0;
            H[5] = (H[5] + f) | 0;
            H[6] = (H[6] + g) | 0;
            H[7] = (H[7] + h) | 0;
        }

        return {
            update: function (chunk) {
                var bytes;
                if (typeof chunk === "string") {
                    bytes = [];
                    for (var i = 0; i < chunk.length; i++) {
                        var code = chunk.charCodeAt(i);
                        if (code < 0x80) bytes.push(code);
                        else if (code < 0x800) {
                            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
                        } else {
                            bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
                        }
                    }
                    bytes = new Uint8Array(bytes);
                } else if (chunk instanceof ArrayBuffer) {
                    bytes = new Uint8Array(chunk);
                } else if (chunk && chunk.buffer instanceof ArrayBuffer) {
                    bytes = new Uint8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength || chunk.length);
                } else if (chunk && chunk.length !== undefined) {
                    bytes = chunk;
                } else {
                    bytes = new Uint8Array(0);
                }

                var bLen = bytes.length;
                totalBytes += bLen;
                var offset = 0;

                if (buffer.length > 0) {
                    while (offset < bLen && buffer.length < 64) {
                        buffer.push(bytes[offset++]);
                    }
                    if (buffer.length === 64) {
                        processBlock(buffer);
                        buffer = [];
                    }
                }

                while (offset + 64 <= bLen) {
                    processBlock(bytes.subarray ? bytes.subarray(offset, offset + 64) : bytes.slice(offset, offset + 64));
                    offset += 64;
                }

                while (offset < bLen) {
                    buffer.push(bytes[offset++]);
                }
            },
            digest: function () {
                // Padding
                buffer.push(0x80);
                while ((buffer.length % 64) !== 56) {
                    buffer.push(0x00);
                }
                var highBits = Math.floor(totalBytes / 0x20000000);
                var lowBits = (totalBytes * 8) >>> 0;
                buffer.push((highBits >>> 24) & 0xff);
                buffer.push((highBits >>> 16) & 0xff);
                buffer.push((highBits >>> 8) & 0xff);
                buffer.push(highBits & 0xff);
                buffer.push((lowBits >>> 24) & 0xff);
                buffer.push((lowBits >>> 16) & 0xff);
                buffer.push((lowBits >>> 8) & 0xff);
                buffer.push(lowBits & 0xff);

                for (var k = 0; k < buffer.length; k += 64) {
                    processBlock(buffer.slice(k, k + 64));
                }

                var hex = "";
                for (var h = 0; h < 8; h++) {
                    var val = H[h] >>> 0;
                    var s = val.toString(16);
                    while (s.length < 8) s = "0" + s;
                    hex += s;
                }
                return hex;
            }
        };
    }

    api.createSha256 = createSha256;

    api.hashFile = function (filePath, callback) {
        streamFile(filePath).then(function (result) { callback(null, result.hash); }, callback);
    };

    function pendingFile(workspace) {
        return normalizePath(workspace) + "/.parddefender/pending.tsv";
    }

    function assetsFile(workspace) {
        return normalizePath(workspace) + "/.parddefender/assets.tsv";
    }

    api.assetsFile = assetsFile;
    api.nativePath = nativePath;

    api.recoverPending = function (workspace) {
        if (!fs || !workspace) return { recovered: 0, removedParts: [] };
        var pFile = pendingFile(workspace);
        if (!fileExists(nativePath(pFile))) return { recovered: 0, removedParts: [] };

        var recovered = 0;
        var removed = [];
        try {
            var raw = fs.readFileSync(nativePath(pFile), { encoding: "utf-8" });
            var lines = raw.split("\n");
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line) continue;
                var cols = line.split("\t");
                // cols: timestamp, taskId, sourcePath, destPath, partPath
                if (cols.length >= 5) {
                    var nPart = nativePath(cols[4]);
                    if (fileExists(nPart)) {
                        try {
                            fs.unlinkSync(nPart);
                            removed.push(cols[4]);
                            recovered++;
                        } catch (eDel) {}
                    }
                }
            }
            fs.unlinkSync(nativePath(pFile));
        } catch (eRec) {}

        return { recovered: recovered, removedParts: removed };
    };

    function journalTask(workspace, task, partPath, callback) {
        var cb = callback || function () {};
        if (!fs || !workspace || !task || !partPath) { cb(); return; }
        var pFile = pendingFile(workspace);
        var dir = safeDirname(nativePath(pFile));
        mkdirAsync(dir, function () {
            var row = [
                new Date().toISOString(),
                task.id || "1",
                normalizePath(task.sourcePath),
                normalizePath(task.destPath),
                normalizePath(partPath)
            ].join("\t") + "\n";
            appendFileAsync(nativePath(pFile), row, cb);
        });
    }

    function removeJournalEntry(workspace, partPath, callback) {
        var cb = callback || function () {};
        if (!fs || !workspace) { cb(); return; }
        var pFile = pendingFile(workspace);
        statAsync(pFile, function (errSt, st, actualPFile) {
            if (errSt || !actualPFile) { cb(); return; }
            readFileAsync(actualPFile, function (errR, raw) {
                if (errR || typeof raw !== "string") { cb(); return; }
                var lines = raw.split("\n");
                var kept = [];
                var normPart = normalizePath(partPath);
                for (var i = 0; i < lines.length; i++) {
                    var l = lines[i].trim();
                    if (!l) continue;
                    var cols = l.split("\t");
                    if (cols[4] && normalizePath(cols[4]) === normPart) continue;
                    kept.push(l);
                }
                if (kept.length > 0) {
                    writeFileAsync(actualPFile, kept.join("\n") + "\n", cb);
                } else {
                    unlinkAsync(actualPFile, cb);
                }
            });
        });
    }

    /* ----------------------------------------------------- chunk copy core */

    function errorResult(e) {
        return { ok: false, code: e.code || "COPY_FAILED", message: e.message || String(e),
            operation: e.operation || "", path: e.path || "", nativeMessage: e.nativeMessage || "" };
    }
    async function statOrMissing(p) {
        try { return await io("stat", [nativePath(p)]); }
        catch (e) { if (e.code === "ENOENT") return null; throw e; }
    }
    async function ensureDirectoryAsync(dir) {
        var st = await statOrMissing(dir);
        if (st) {
            if (!st.isDirectory()) throw Object.assign(new Error("Назначение не является папкой: " + dir), { code: "ENOTDIR" });
            return;
        }
        var parent = safeDirname(dir);
        // A fallback dirname can return "D:" for "D:/folder"; retain the drive root.
        if (/^[a-z]:$/i.test(parent)) parent += "/";
        if (!parent || normalizePath(parent) === normalizePath(dir)) {
            throw Object.assign(new Error("Корень папки недоступен: " + dir), { code: "ENOENT" });
        }
        await ensureDirectoryAsync(parent);
        try { await io("mkdir", [nativePath(dir), { recursive: false }]); }
        catch (error) {
            if (error.code !== "EEXIST") throw error;
            var created = await io("stat", [nativePath(dir)]);
            if (!created.isDirectory()) throw error;
        }
    }
    async function hashAsync(p, progress) { return (await streamFile(p, null, progress)).hash; }
    async function appendText(p, text) {
        await io("writeFile", [nativePath(p), text, { encoding: "utf-8", flag: "a" }]);
    }
    async function copyVerified(sourcePath, destPath, opt, progress) {
        var normalizedDest = normalizePath(destPath).toLowerCase();
        if (normalizedDest.split("/").some(function (part) { return part === ".." || part === "."; }) ||
            (opt.workspace && normalizedDest.indexOf(normalizePath(opt.workspace).toLowerCase() + "/") !== 0)) {
            throw new Error("Назначение вне рабочей папки проекта");
        }
        var sourceStat = await io("stat", [nativePath(sourcePath)]);
        if (!sourceStat.isFile()) throw new Error("Источник не является файлом");
        function phaseProgress(phase) {
            return function (bytes) {
                if (progress) progress({ phase: phase, bytesWritten: bytes, totalBytes: sourceStat.size,
                    percent: sourceStat.size ? Math.floor(bytes * 100 / sourceStat.size) : 100 });
            };
        }
        var sourceHash = await hashAsync(sourcePath, phaseProgress("Проверка исходника"));
        var finalPath = destPath;
        var existing = await statOrMissing(finalPath);
        if (existing && existing.isFile() && existing.size === sourceStat.size &&
            await hashAsync(finalPath) === sourceHash) {
            return { ok: true, reused: true, destPath: finalPath, size: sourceStat.size, hash: sourceHash };
        }
        if (existing) {
            var dot = destPath.lastIndexOf(".");
            var stem = dot > destPath.lastIndexOf("/") ? destPath.slice(0, dot) : destPath;
            var ext = dot > destPath.lastIndexOf("/") ? destPath.slice(dot) : "";
            finalPath = stem + " (" + sourceHash.slice(0, 12) + ")" + ext;
            existing = await statOrMissing(finalPath);
            if (existing) {
                if (existing.isFile() && existing.size === sourceStat.size && await hashAsync(finalPath) === sourceHash) {
                    return { ok: true, reused: true, destPath: finalPath, size: sourceStat.size, hash: sourceHash };
                }
                throw new Error("Конфликт назначения: " + finalPath);
            }
        }
        await ensureDirectoryAsync(safeDirname(finalPath));
        var part = finalPath + "." + Date.now().toString(36) + Math.random().toString(36).slice(2) + ".pdpart";
        var ws = opt.workspace;
        if (ws) {
            await ensureDirectoryAsync(ws + "/.parddefender");
            await appendText(pendingFile(ws), [new Date().toISOString(), opt.id || "1",
                normalizePath(sourcePath), normalizePath(finalPath), normalizePath(part)].join("\t") + "\n");
        }
        // Timed-out native operations might still finish. Leave their unique part
        // journalled; never promote it or start a fallback writer after a timeout.
        var copied = await streamFile(sourcePath, part, function (bytes) {
            if (progress) progress({ bytesWritten: bytes, totalBytes: sourceStat.size,
                percent: sourceStat.size ? Math.floor(bytes * 100 / sourceStat.size) : 100 });
        });
        var after = await io("stat", [nativePath(sourcePath)]);
        var partStat = await io("stat", [nativePath(part)]);
        if (copied.size !== sourceStat.size || after.size !== sourceStat.size ||
            (sourceStat.mtimeMs && after.mtimeMs !== sourceStat.mtimeMs) ||
            partStat.size !== sourceStat.size || copied.hash !== sourceHash ||
            await hashAsync(part, phaseProgress("Проверка копии")) !== sourceHash) throw new Error("Проверка копии не пройдена: " + sourcePath);
        if (await statOrMissing(finalPath)) throw new Error("Назначение появилось во время копирования: " + finalPath);
        await io("rename", [nativePath(part), nativePath(finalPath)]);
        if (ws) {
            // Created-only provenance, durable before any project relink.
            await appendText(assetsFile(ws), [new Date().toISOString(), opt.id || "1",
                normalizePath(sourcePath), sourceStat.size, normalizePath(finalPath),
                opt.branch || "_SHARED", opt.category || "video", sourceHash, "premiere"].join("\t") + "\n");
            await new Promise(function (resolve, reject) {
                removeJournalEntry(ws, part, function (err) { if (err) reject(err); else resolve(); });
            });
        }
        return { ok: true, reused: false, destPath: finalPath, size: sourceStat.size, hash: sourceHash };
    }
    api.copyChunked = function (sourcePath, destPath, options, callbacks) {
        var cb = callbacks || {};
        copyVerified(sourcePath, destPath, options || {}, cb.onProgress).then(function (res) {
            if (cb.onDone) cb.onDone(res);
        }, function (e) { if (cb.onDone) cb.onDone(errorResult(e)); });
    };

    api.sequenceFiles = async function (source) {
        var name = source.replace(/\\/g, "/").split("/").pop();
        var m = /^(.*?)(\d{3,8})(\.(?:png|jpe?g|exr|tiff?|dpx|tga))$/i.exec(name);
        if (!m) return [];
        var dir = safeDirname(source);
        var files = await io("readdir", [nativePath(dir)]);
        return files.filter(function (f) {
            var x = /^(.*?)(\d{3,8})(\.(?:png|jpe?g|exr|tiff?|dpx|tga))$/i.exec(f);
            return x && x[1] === m[1] && x[2].length === m[2].length && x[3].toLowerCase() === m[3].toLowerCase();
        }).sort().map(function (f) { return dir + "/" + f; });
    };

    api.runQueue = function (workspace, tasks, options, callbacks) {
        var cb = callbacks || {}, opt = options || {};
        (async function () {
            var results = [];
            for (var i = 0; i < (tasks || []).length; i++) {
                var t = tasks[i], res = null;
                if (cb.onTask) cb.onTask(t, i + 1, tasks.length);
                try {
                    if (!isInProjectMediaFolder(t.destPath, workspace) &&
                        normalizePath(t.destPath).toLowerCase().indexOf(normalizePath(workspace).toLowerCase() + "/unused/") !== 0) {
                        throw new Error("Назначение вне папок проекта");
                    }
                    if (t.isAeCanonical) {
                        var srcHash = await hashAsync(t.sourcePath);
                        var dstHash = null;
                        try { dstHash = await hashAsync(t.destPath); }
                        catch (eCandidate) { if (eCandidate.code !== "ENOENT") throw eCandidate; }
                        if (srcHash !== dstHash && t.fallbackDestPath) {
                            if (!isInProjectMediaFolder(t.fallbackDestPath, workspace)) throw new Error("Резервное назначение вне папок проекта");
                            // A name match is only a candidate. Preserve a different rendition separately.
                            t.destPath = t.fallbackDestPath;
                            t.isAeCanonical = false;
                        } else if (srcHash !== dstHash) throw new Error("Файл AE отличается от исходника; автоматическая подмена запрещена");
                    }
                    if (t.isAeCanonical) {
                        var sourceFrames = await api.sequenceFiles(t.sourcePath);
                        var canonicalFrames = await api.sequenceFiles(t.destPath);
                        if (sourceFrames.length > 1 || canonicalFrames.length > 1) {
                            if (sourceFrames.length !== canonicalFrames.length) throw new Error("Состав секвенции AE отличается");
                            for (var k = 0; k < sourceFrames.length; k++) {
                                if (sourceFrames[k].replace(/\\/g, "/").split("/").pop() !== canonicalFrames[k].replace(/\\/g, "/").split("/").pop() ||
                                    await hashAsync(sourceFrames[k]) !== await hashAsync(canonicalFrames[k])) {
                                    throw new Error("Кадры секвенции AE отличаются");
                                }
                            }
                        }
                        res = { ok: true, reused: true, destPath: t.destPath, hash: dstHash, isAeCanonical: true };
                    } else {
                        var frames = await api.sequenceFiles(t.sourcePath);
                        if (frames.length > 1) {
                            var destDir = safeDirname(t.destPath);
                            var frameResults = [];
                            for (var f = 0; f < frames.length; f++) {
                                var frameDest = destDir + "/" + frames[f].replace(/\\/g, "/").split("/").pop();
                                var frameExisting = await statOrMissing(frameDest);
                                if (frameExisting && await hashAsync(frameDest) !== await hashAsync(frames[f])) {
                                    throw new Error("Конфликт кадров секвенции: " + frameDest);
                                }
                            }
                            for (var j = 0; j < frames.length; j++) {
                                var fr = await copyVerified(frames[j], destDir + "/" + frames[j].replace(/\\/g, "/").split("/").pop(),
                                    { workspace: workspace, id: t.id, branch: t.branch, category: "sequence" }, opt.onProgress);
                                frameResults.push(fr);
                                if (normalizePath(frames[j]) === normalizePath(t.sourcePath)) res = fr;
                            }
                            if (!res) throw new Error("Первый кадр секвенции не найден");
                            res.frames = frameResults;
                        } else {
                            res = await copyVerified(t.sourcePath, t.destPath,
                                { workspace: workspace, id: t.id, branch: t.branch, category: t.category }, opt.onProgress);
                        }
                    }
                } catch (e) { res = errorResult(e); res.error = res.message; }
                res.id = t.id; res.item = t.item; res.sourcePath = t.sourcePath;
                results.push(res);
            }
            return { ok: results.every(function (r) { return r.ok; }), results: results };
        })().then(function (res) { if (cb.onDone) cb.onDone(res); }, function (e) {
            if (cb.onDone) cb.onDone({ ok: false, results: [], error: e.message });
        });
    };

    function maybeAwait(val, fn) {
        if (val && typeof val.then === "function") {
            return val.then(fn);
        }
        return fn(val);
    }

    api.maybeAwait = maybeAwait;

    api.relinkVerifiedClip = async function (clipItem, newPath, expectedOldPath) {
        var oldPath = expectedOldPath || await clipItem.getMediaFilePath();
        if (normalizePath(oldPath).toLowerCase() !== normalizePath(newPath).toLowerCase()) {
            if (await hashAsync(oldPath) !== await hashAsync(newPath)) {
                return { ok: false, code: "CONTENT_MISMATCH", reason: "Файлы различаются; автоматическая подмена запрещена" };
            }
            var sourceFrames = await api.sequenceFiles(oldPath);
            var targetFrames = await api.sequenceFiles(newPath);
            if (sourceFrames.length > 1 || targetFrames.length > 1) {
                if (sourceFrames.length !== targetFrames.length) {
                    return { ok: false, code: "SEQUENCE_MISMATCH", reason: "Состав секвенций отличается" };
                }
                for (var i = 0; i < sourceFrames.length; i++) {
                    if (sourceFrames[i].replace(/\\/g, "/").split("/").pop() !== targetFrames[i].replace(/\\/g, "/").split("/").pop() ||
                        await hashAsync(sourceFrames[i]) !== await hashAsync(targetFrames[i])) {
                        return { ok: false, code: "SEQUENCE_MISMATCH", reason: "Кадры секвенций отличаются" };
                    }
                }
            }
        }
        return api.relinkClip(clipItem, newPath, oldPath);
    };

    /* ----------------------------------------------------- Premiere Relink */

    api.relinkClip = function (clipItem, newMediaPath, expectedOldPath) {
        if (!clipItem) return { ok: false, code: "ITEM_NOT_FOUND", reason: "Элемент не существует" };

        var targetClip = clipItem;
        if (ppro && ppro.ClipProjectItem) {
            if (typeof ppro.ClipProjectItem.queryCast === "function") {
                try { var qc = ppro.ClipProjectItem.queryCast(clipItem); if (qc) targetClip = qc; } catch (eQ) {}
            } else if (typeof ppro.ClipProjectItem.cast === "function") {
                try { var cc = ppro.ClipProjectItem.cast(clipItem); if (cc) targetClip = cc; } catch (eC) {}
            }
        }

        var currentPath = "";
        if (typeof targetClip.getMediaFilePath === "function") {
            try { currentPath = targetClip.getMediaFilePath(); } catch (eCp1) {}
        } else if (typeof clipItem.getMediaFilePath === "function") {
            try { currentPath = clipItem.getMediaFilePath(); } catch (eCp2) {}
        } else if (targetClip.mediaFilePath) {
            currentPath = targetClip.mediaFilePath;
        } else if (clipItem.mediaFilePath) {
            currentPath = clipItem.mediaFilePath;
        }

        return maybeAwait(currentPath, function (resCurrentPath) {
            currentPath = resCurrentPath || "";

            if (expectedOldPath && normalizePath(currentPath) !== normalizePath(expectedOldPath)) {
                return {
                    ok: false,
                    code: "STALE_SOURCE",
                    reason: "Источник элемента изменился: " + currentPath + ", ожидался: " + expectedOldPath
                };
            }

            if (targetClip.isMulticam || targetClip.isMerged || targetClip.isSynthetic ||
                clipItem.isMulticam || clipItem.isMerged || clipItem.isSynthetic) {
                return {
                    ok: false,
                    code: "UNSUPPORTED_TYPE",
                    reason: "Сложные или синтетические элементы не могут быть перелинкованы"
                };
            }

            var canChange = true;
            if (typeof targetClip.canChangeMediaPath === "function") {
                try { canChange = targetClip.canChangeMediaPath(); } catch (eCc1) {}
            } else if (typeof clipItem.canChangeMediaPath === "function") {
                try { canChange = clipItem.canChangeMediaPath(); } catch (eCc2) {}
            }

            return maybeAwait(canChange, function (resCanChange) {
                if (resCanChange === false) {
                    return {
                        ok: false,
                        code: "CANNOT_CHANGE_PATH",
                        reason: "Premiere запрещает смену пути для этого элемента"
                    };
                }

                function tryChangePath() {
                    var chRes = null;
                    var pathNat = nativePath(newMediaPath);
                    var pathFwd = String(newMediaPath).replace(/\\/g, "/");
                    var candidates = (pathNat !== pathFwd) ? [pathNat, pathFwd] : [pathNat];

                    var targets = [targetClip];
                    if (clipItem && clipItem !== targetClip) targets.push(clipItem);

                    for (var tIdx = 0; tIdx < targets.length; tIdx++) {
                        var tgt = targets[tIdx];
                        if (!tgt) continue;
                        for (var cIdx = 0; cIdx < candidates.length; cIdx++) {
                            var pCand = candidates[cIdx];
                            if (typeof tgt.changeMediaPath === "function") {
                                try { chRes = tgt.changeMediaPath(pCand, true); } catch (eCm1) {}
                                if (chRes !== false && chRes !== null && chRes !== undefined) return chRes;
                                try { chRes = tgt.changeMediaPath(pCand, 1); } catch (eCm2) {}
                                if (chRes !== false && chRes !== null && chRes !== undefined) return chRes;
                                try { chRes = tgt.changeMediaPath(pCand); } catch (eCm3) {}
                                if (chRes !== false && chRes !== null && chRes !== undefined) return chRes;
                            }
                            if (typeof tgt.changeMediaFilePath === "function") {
                                try { chRes = tgt.changeMediaFilePath(pCand, false); } catch (eCmf1) {}
                                if (chRes !== false && chRes !== null && chRes !== undefined) return chRes;
                                try { chRes = tgt.changeMediaFilePath(pCand, false); } catch (eCmf2) {}
                                if (chRes !== false && chRes !== null && chRes !== undefined) return chRes;
                                try { chRes = tgt.changeMediaFilePath(pCand); } catch (eCmf3) {}
                                if (chRes !== false && chRes !== null && chRes !== undefined) return chRes;
                            }
                        }
                    }
                    return chRes;
                }

                var changeRes = tryChangePath();

                return maybeAwait(changeRes, function (success) {
                    if (success === false) {
                        return {
                            ok: false,
                            code: "RELINK_REJECTED",
                            reason: "Premiere отклонил перелинковку (несовместимый медиафайл)"
                        };
                    }

                    // Post-relink verification
                    var verifyPath = "";
                    if (typeof targetClip.getMediaFilePath === "function") {
                        try { verifyPath = targetClip.getMediaFilePath(); } catch (eVer1) {}
                    }
                    if (!verifyPath && typeof clipItem.getMediaFilePath === "function") {
                        try { verifyPath = clipItem.getMediaFilePath(); } catch (eVer2) {}
                    }
                    if (!verifyPath && (targetClip.mediaFilePath || clipItem.mediaFilePath)) {
                        verifyPath = targetClip.mediaFilePath || clipItem.mediaFilePath;
                    }
                    if (!verifyPath && (targetClip.filePath || clipItem.filePath)) {
                        verifyPath = targetClip.filePath || clipItem.filePath;
                    }
                    if (!verifyPath && (targetClip.path || clipItem.path)) {
                        verifyPath = targetClip.path || clipItem.path;
                    }

                    return maybeAwait(verifyPath, function (resVerifyPath) {
                        verifyPath = resVerifyPath || "";

                        if (verifyPath && normalizePath(verifyPath) !== normalizePath(newMediaPath)) {
                            return {
                                ok: false,
                                code: "VERIFY_FAILED",
                                reason: "После перелинковки путь не изменился на целевой"
                            };
                        }

                        return {
                            ok: true,
                            newPath: normalizePath(verifyPath || newMediaPath)
                        };
                    });
                });
            });
        });
    };

    return api;
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = PardPremiereCopyEngine;
}
