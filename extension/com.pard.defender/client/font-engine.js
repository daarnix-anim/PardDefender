/*
 * PardDefender - font discovery, parsing, and project synchronization engine.
 *
 * @map role: Обнаружение системных шрифтов, парсинг TTF/OTF заголовков и синхронизация шрифтов проекта в папку Fonts.
 * @map status: ready
 * @map layer: client
 */
"use strict";

var PardFontEngine = (function () {
    var fs = null;
    var path = null;
    var os = null;
    var childProcess = null;
    var crypto = null;
    var Buffer = null;

    try { fs = require("fs"); } catch (e) {}
    try { path = require("path"); } catch (e) {}
    try { os = require("os"); } catch (e) {}
    try { childProcess = require("child_process"); } catch (e) {}
    try { crypto = require("crypto"); } catch (e) {}
    try { Buffer = require("buffer").Buffer; } catch (e) {}

    var api = {};
    var _cachedIndex = null;

    function norm(str) {
        return String(str || "").trim().toLowerCase();
    }

    function slashes(p) {
        return String(p || "").replace(/\\/g, "/");
    }

    /* -------------------------------------------------------- binary parser */

    /*
     * Parses TTF / OTF / TTC header and locates 'name' table offset and length.
     * OpenType spec:
     * - TTF / OTF starts with sfntVersion (0x00010000, 'OTTO', 'true') + numTables (uint16 at 4).
     * - TTC (TrueType Collection) starts with 'ttcf' + numFonts (uint32 at 8) + array of offsets.
     */
    function parseHeader(buf, offset) {
        var base = offset || 0;
        if (base + 12 > buf.length) return [];
        var tag = buf.toString("latin1", base, base + 4);

        if (tag === "ttcf") {
            var numFonts = buf.readUInt32BE(base + 8);
            var results = [];
            for (var f = 0; f < numFonts; f++) {
                var fOffset = buf.readUInt32BE(base + 12 + f * 4);
                var sub = parseHeader(buf, fOffset);
                for (var s = 0; s < sub.length; s++) results.push(sub[s]);
            }
            return results;
        }

        var numTables = buf.readUInt16BE(base + 4);
        var nameOffset = 0, nameLength = 0;
        for (var i = 0; i < numTables; i++) {
            var rec = base + 12 + i * 16;
            if (rec + 16 > buf.length) break;
            var tTag = buf.toString("latin1", rec, rec + 4);
            if (tTag === "name") {
                nameOffset = buf.readUInt32BE(rec + 8);
                nameLength = buf.readUInt32BE(rec + 12);
                break;
            }
        }

        if (nameOffset > 0 && nameLength > 0) {
            return [{ nameOffset: nameOffset, nameLength: nameLength }];
        }
        return [];
    }

    /*
     * Decodes OpenType 'name' table strings:
     * Name ID 1: Family
     * Name ID 2: Subfamily / Style (e.g. Regular, Bold, Italic)
     * Name ID 4: Full Name
     * Name ID 6: PostScript Name (exact match for AE TextDocument.font)
     */
    function parseNameTable(buf, offset, length) {
        if (!buf || offset + 6 > buf.length) return null;
        var count = buf.readUInt16BE(offset + 2);
        var stringOffset = offset + buf.readUInt16BE(offset + 4);
        var res = { postScriptName: "", family: "", subFamily: "", fullName: "" };

        for (var i = 0; i < count; i++) {
            var rec = offset + 6 + i * 12;
            if (rec + 12 > buf.length) break;
            var pId = buf.readUInt16BE(rec);
            var nId = buf.readUInt16BE(rec + 6);
            var len = buf.readUInt16BE(rec + 8);
            var sOff = buf.readUInt16BE(rec + 10);
            var start = stringOffset + sOff;
            if (start + len > buf.length) continue;

            var val = "";
            var slice = Buffer.from(buf.subarray(start, start + len));
            if (pId === 0 || pId === 3) {
                // Unicode / Windows UTF-16BE -> swap bytes for Node utf16le
                val = slice.length % 2 === 0 ? slice.swap16().toString("utf16le") : slice.toString("utf8");
            } else {
                val = slice.toString("latin1");
            }
            val = val.replace(/\0/g, "").trim();
            if (!val) continue;

            if (nId === 1 && !res.family) res.family = val;
            else if (nId === 2 && !res.subFamily) res.subFamily = val;
            else if (nId === 4 && !res.fullName) res.fullName = val;
            else if (nId === 6 && !res.postScriptName) res.postScriptName = val;
        }

        return res;
    }

    function readFontNamesFromFile(filePath) {
        if (!fs || !fs.existsSync(filePath)) return [];
        var fd = null;
        try {
            var stat = fs.statSync(filePath);
            var readLen = Math.min(stat.size, 2097152); // read up to 2MB header
            var buf = Buffer.alloc(readLen);
            fd = fs.openSync(filePath, "r");
            fs.readSync(fd, buf, 0, readLen, 0);
            fs.closeSync(fd);
            fd = null;

            var tables = parseHeader(buf, 0);
            var out = [];
            for (var i = 0; i < tables.length; i++) {
                var t = tables[i];
                var names = null;
                if (t.nameOffset + t.nameLength <= buf.length) {
                    names = parseNameTable(buf, t.nameOffset, t.nameLength);
                } else {
                    // Name table beyond 2MB buffer, read on demand
                    var nameBuf = Buffer.alloc(t.nameLength);
                    var fdN = fs.openSync(filePath, "r");
                    fs.readSync(fdN, nameBuf, 0, t.nameLength, t.nameOffset);
                    fs.closeSync(fdN);
                    names = parseNameTable(nameBuf, 0, t.nameLength);
                }
                if (names && (names.postScriptName || names.family || names.fullName)) {
                    names.filePath = filePath;
                    out.push(names);
                }
            }
            return out;
        } catch (err) {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch (eC) {}
            }
            return [];
        }
    }

    /* ---------------------------------------------------- system font index */

    function getSystemFontDirectories() {
        var dirs = [];
        var isWin = process.platform === "win32" || (os && os.platform && os.platform() === "win32");

        if (isWin) {
            var winDir = process.env.WINDIR || "C:\\Windows";
            dirs.push(path.join(winDir, "Fonts"));

            var localAppData = process.env.LOCALAPPDATA;
            if (localAppData) {
                dirs.push(path.join(localAppData, "Microsoft", "Windows", "Fonts"));
            }

            var appData = process.env.APPDATA;
            if (appData) {
                dirs.push(path.join(appData, "Adobe", "Fonts"));
            }
        } else {
            dirs.push("/Library/Fonts");
            dirs.push("/System/Library/Fonts");
            var home = process.env.HOME;
            if (home) dirs.push(path.join(home, "Library", "Fonts"));
        }

        return dirs.filter(function (d) {
            try { return fs && fs.existsSync(d); } catch (e) { return false; }
        });
    }

    function queryWindowsRegistryFonts() {
        var map = {};
        if (!childProcess || process.platform !== "win32") return map;

        var keys = [
            "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
            "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"
        ];

        var winFonts = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");

        for (var k = 0; k < keys.length; k++) {
            try {
                var out = childProcess.execSync('reg query "' + keys[k] + '"', {
                    encoding: "utf8",
                    timeout: 4000,
                    windowsHide: true,
                    stdio: ["ignore", "pipe", "ignore"]
                });
                var lines = out.split(/\r?\n/);
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (!line) continue;
                    var parts = line.split(/\s{2,}REG_[A-Z]+\s{2,}/);
                    if (parts.length === 2) {
                        var fontName = parts[0].trim();
                        var fontFile = parts[1].trim();
                        var fullPath = fontFile;
                        if (!path.isAbsolute(fullPath)) {
                            fullPath = path.join(winFonts, fontFile);
                        }
                        if (fs.existsSync(fullPath)) {
                            map[norm(fontName)] = fullPath;
                            // Also map clean name without (TrueType)/(OpenType) suffix
                            var cleanName = fontName.replace(/\s*\((TrueType|OpenType|PostScript)\)\s*$/i, "").trim();
                            map[norm(cleanName)] = fullPath;
                        }
                    }
                }
            } catch (eReg) {}
        }
        return map;
    }

    function indexSystemFonts(options) {
        var opt = options || {};
        if (_cachedIndex && !opt.force) return _cachedIndex;

        var index = {
            byPostScript: {},
            byFullName: {},
            byFamilyStyle: {},
            byFamily: {},
            byFileName: {},
            registryMap: {},
            allFonts: []
        };

        if (!fs || !path) return index;

        // 1. Query Registry
        index.registryMap = queryWindowsRegistryFonts();
        for (var regKey in index.registryMap) {
            var fPath = index.registryMap[regKey];
            var fBase = norm(path.basename(fPath));
            index.byFileName[fBase] = fPath;
        }

        // 2. Discover Font Directories
        var dirs = getSystemFontDirectories();
        for (var d = 0; d < dirs.length; d++) {
            var dirPath = dirs[d];
            try {
                var entries = fs.readdirSync(dirPath);
                for (var e = 0; e < entries.length; e++) {
                    var entry = entries[e];
                    if (!/\.(ttf|otf|ttc)$/i.test(entry)) continue;
                    var fullP = path.join(dirPath, entry);
                    var baseName = norm(entry);
                    if (!index.byFileName[baseName]) {
                        index.byFileName[baseName] = fullP;
                    }

                    // Parse header and names for indexing
                    var namesList = readFontNamesFromFile(fullP);
                    for (var n = 0; n < namesList.length; n++) {
                        var fn = namesList[n];
                        index.allFonts.push(fn);

                        if (fn.postScriptName) {
                            index.byPostScript[norm(fn.postScriptName)] = fullP;
                        }
                        if (fn.fullName) {
                            index.byFullName[norm(fn.fullName)] = fullP;
                        }
                        if (fn.family) {
                            var famKey = norm(fn.family);
                            if (!index.byFamily[famKey]) index.byFamily[famKey] = [];
                            index.byFamily[famKey].push(fullP);

                            var styleKey = norm(fn.subFamily || "regular");
                            index.byFamilyStyle[famKey + "___" + styleKey] = fullP;
                            index.byFamilyStyle[famKey + " " + styleKey] = fullP;
                        }
                    }
                }
            } catch (eDir) {}
        }

        _cachedIndex = index;
        return index;
    }

    /* --------------------------------------------------- font file resolver */

    function resolveFontFile(fontInfo, customIndex) {
        if (!fontInfo) return null;
        var idx = customIndex || indexSystemFonts();

        // 1. Direct location if already known
        if (fontInfo.fontLocation && fs && fs.existsSync(fontInfo.fontLocation)) {
            return { filePath: fontInfo.fontLocation, matchedBy: "location" };
        }

        var ps = norm(fontInfo.postScriptName);
        var fam = norm(fontInfo.fontFamily);
        var style = norm(fontInfo.fontStyle || "regular");

        // 2. Exact PostScript name match (Name ID 6)
        if (ps && idx.byPostScript[ps]) {
            return { filePath: idx.byPostScript[ps], matchedBy: "postscript" };
        }

        // 3. PostScript name as full name / file name
        if (ps) {
            if (idx.byFullName[ps]) return { filePath: idx.byFullName[ps], matchedBy: "fullname" };
            if (idx.byFileName[ps + ".ttf"]) return { filePath: idx.byFileName[ps + ".ttf"], matchedBy: "filename" };
            if (idx.byFileName[ps + ".otf"]) return { filePath: idx.byFileName[ps + ".otf"], matchedBy: "filename" };
        }

        // 4. Family + Style match
        if (fam) {
            var fsKey = fam + "___" + style;
            if (idx.byFamilyStyle[fsKey]) {
                return { filePath: idx.byFamilyStyle[fsKey], matchedBy: "family-style" };
            }
            var fullNameKey = fam + " " + style;
            if (idx.byFullName[fullNameKey]) {
                return { filePath: idx.byFullName[fullNameKey], matchedBy: "family-style-full" };
            }

            // Registry name match (e.g. "Montserrat Bold")
            if (idx.registryMap[fullNameKey]) {
                return { filePath: idx.registryMap[fullNameKey], matchedBy: "registry-full" };
            }
            // A family alone does not identify a face. Never substitute an
            // arbitrary Regular/Italic file for an unavailable requested face.
        }

        return null;
    }

    /* ---------------------------------------------------- verified storage */

    function digest(file) {
        var hash = crypto.createHash("sha256");
        var fd = fs.openSync(file, "r");
        try {
            var buf = Buffer.alloc(65536), count;
            while ((count = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
                hash.update(buf.slice(0, count));
            }
            return hash.digest("hex");
        } finally { fs.closeSync(fd); }
    }

    function token() { return crypto.randomBytes(12).toString("hex"); }

    function writeManifest(file, data) {
        var part = file + "." + token() + ".pdpart";
        var bytes = Buffer.from(JSON.stringify(data, null, 2), "utf8");
        try {
            fs.writeFileSync(part, bytes, { flag: "wx" });
            if (!fs.readFileSync(part).equals(bytes)) throw new Error("Ошибка проверки реестра шрифтов.");
            fs.renameSync(part, file);
        } finally {
            if (fs.existsSync(part)) fs.unlinkSync(part);
        }
    }

    function projectKey(projectPath) {
        var value = slashes(path.resolve(projectPath));
        if (process.platform === "win32") value = value.toLowerCase();
        return crypto.createHash("sha256").update(value).digest("hex");
    }

    function safeName(name) {
        var value = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
        if (!value || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) value = "font-" + value;
        return value.slice(0, 160);
    }

    function localFile(dir, name) {
        if (!name || name !== path.basename(name) || name === "." || name === "..") return null;
        var file = path.join(dir, name);
        if (fs.existsSync(file)) {
            var stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink()) return null;
        }
        return file;
    }

    function syncProjectFonts(workspace, projectFonts, options) {
        var opt = options || {};
        if (!fs || !path || !crypto || !Buffer) return { ok: false, error: "Node.js fs/path/crypto/buffer unavailable" };
        var lock = null, lockPath = null;
        try {
            if (!workspace || !fs.statSync(workspace).isDirectory()) throw new Error("Рабочая папка проекта не найдена.");
            var fontsDir = path.join(workspace, "Fonts");
            var metaDir = path.join(workspace, ".parddefender");
            [fontsDir, metaDir].forEach(function (dir) {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                var stat = fs.lstatSync(dir);
                if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Недопустимая папка шрифтов или метаданных.");
            });
            lockPath = path.join(metaDir, "fonts.lock");
            lock = fs.openSync(lockPath, "wx");
            fs.writeSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
            var metaFile = path.join(metaDir, "fonts.json");
            var previous = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : null;
            if (previous && previous.schemaVersion !== 1 && previous.schemaVersion !== 2) {
                throw new Error("Неизвестная версия реестра шрифтов.");
            }
            // Legacy files have no reliable ownership evidence; never adopt
            // them for deletion. Other projects retain their own snapshots.
            var manifest = previous && previous.schemaVersion === 2 ? previous : {
                schemaVersion: 2, projects: {}, ownedFiles: {}
            };
            if (!manifest.projects || !manifest.ownedFiles) throw new Error("Повреждён реестр шрифтов.");
            var key = opt.projectPath ? projectKey(opt.projectPath) : "unscoped";
            var oldProject = manifest.projects[key];
            var idx = indexSystemFonts({ force: opt.forceIndex === true });
            var fontsList = projectFonts || [];
            var copied = [], existing = [], missing = [], processed = [], removed = [];
            for (var i = 0; i < fontsList.length; i++) {
                var font = fontsList[i];
                var entry = {
                    postScriptName: font.postScriptName || "", fontFamily: font.fontFamily || "",
                    fontStyle: font.fontStyle || "", layers: font.layers || [],
                    status: "missing", fileName: null, destPath: null, size: 0
                };
                var part = null;
                try {
                    var resolved = resolveFontFile(font, idx);
                    if (!resolved || !fs.statSync(resolved.filePath).isFile()) throw new Error("Точное начертание шрифта не найдено.");
                    entry.resolvedFile = resolved.filePath;
                    var sha = digest(resolved.filePath);
                    var base = path.basename(resolved.filePath);
                    var ext = path.extname(base) || ".ttf";
                    if (/^\d+\.[a-z0-9]+$/i.test(base) && font.postScriptName) base = safeName(font.postScriptName) + ext;
                    base = safeName(base);
                    var name = base, dest = localFile(fontsDir, name), suffix = 1;
                    while (!dest || (fs.existsSync(dest) && digest(dest) !== sha)) {
                        name = path.basename(base, ext) + " (" + sha.slice(0, 12) + (suffix > 1 ? "-" + suffix : "") + ")" + ext;
                        dest = localFile(fontsDir, name);
                        suffix++;
                    }
                    if (fs.existsSync(dest)) {
                        entry.status = "existing";
                    } else {
                        part = dest + "." + token() + ".pdpart";
                        // Persist the plan before writing any font bytes.
                        manifest.pending = { source: slashes(resolved.filePath), destination: slashes(dest), part: slashes(part) };
                        writeManifest(metaFile, manifest);
                        fs.copyFileSync(resolved.filePath, part, fs.constants.COPYFILE_EXCL);
                        if (digest(part) !== sha || digest(resolved.filePath) !== sha) throw new Error("Шрифт изменился во время копирования.");
                        // All plugin writers hold fonts.lock. Recheck the
                        // destination after copying before publishing the part.
                        if (fs.existsSync(dest)) throw new Error("Назначение появилось во время копирования. Повторите сбор.");
                        fs.renameSync(part, dest);
                        part = null;
                        manifest.ownedFiles[name] = { sha256: sha };
                        entry.status = "copied";
                    }
                    entry.fileName = name;
                    entry.destPath = slashes(dest);
                    entry.sha256 = sha;
                    entry.size = fs.statSync(dest).size;
                    if (entry.status === "copied") copied.push(entry);
                    else existing.push(entry);
                } catch (err) {
                    entry.status = "missing";
                    entry.error = err.message;
                    missing.push(entry);
                } finally {
                    if (part && fs.existsSync(part)) fs.unlinkSync(part);
                }
                processed.push(entry);
            }
            var snapshot = {
                projectPath: opt.projectPath || "", lastSync: new Date().toISOString(),
                workspace: slashes(workspace), fontsFolder: slashes(fontsDir), fonts: processed,
                counts: { total: fontsList.length, copied: copied.length, existing: existing.length, missing: missing.length, removed: 0 },
                removed: removed
            };
            // Incomplete copies and disabled cleanup retain earlier references.
            snapshot.retainedFiles = (missing.length || opt.cleanUnused !== true) && oldProject ? (oldProject.retainedFiles || []).concat(
                (oldProject.fonts || []).map(function (f) { return f.fileName; }).filter(Boolean)) : [];
            manifest.projects[key] = snapshot;
            manifest.lastProject = key;
            delete manifest.pending;
            writeManifest(metaFile, manifest);
            if (opt.cleanUnused === true && opt.projectPath && !missing.length && oldProject) {
                var referenced = {};
                Object.keys(manifest.projects).forEach(function (id) {
                    var project = manifest.projects[id];
                    (project.fonts || []).forEach(function (f) { if (f.fileName) referenced[norm(f.fileName)] = true; });
                    (project.retainedFiles || []).forEach(function (name) { referenced[norm(name)] = true; });
                });
                var candidates = (oldProject.fonts || []).map(function (f) { return f.fileName; }).concat(oldProject.retainedFiles || []);
                candidates.forEach(function (name) {
                    var owned = manifest.ownedFiles[name];
                    if (!name || !owned || referenced[norm(name)]) return;
                    var file = localFile(fontsDir, name);
                    if (!file || !fs.existsSync(file) || digest(file) !== owned.sha256) return;
                    fs.unlinkSync(file);
                    delete manifest.ownedFiles[name];
                    removed.push(name);
                });
                snapshot.counts.removed = removed.length;
                writeManifest(metaFile, manifest);
            }
            return {
                ok: true, workspace: slashes(workspace), fontsDir: slashes(fontsDir),
                counts: snapshot.counts, copied: copied, existing: existing,
                missing: missing, removed: removed, fonts: processed
            };
        } catch (err) {
            return { ok: false, error: err.code === "EEXIST" && lock === null ?
                "Сбор шрифтов уже выполняется или осталась блокировка после сбоя. Повторите после завершения операции; при повторной ошибке проверьте .parddefender/fonts.lock." : err.message };
        } finally {
            if (lock !== null) { fs.closeSync(lock); fs.unlinkSync(lockPath); }
        }
    }

    function getStoredFontsManifest(workspace, projectPath) {
        if (!fs || !path || !workspace) return null;
        try {
            var data = JSON.parse(fs.readFileSync(path.join(workspace, ".parddefender", "fonts.json"), "utf8"));
            if (data.schemaVersion === 1) return data;
            if (data.schemaVersion !== 2 || !data.projects) return null;
            var snapshot = data.projects[projectPath ? projectKey(projectPath) : data.lastProject];
            if (snapshot) snapshot.schemaVersion = 2;
            return snapshot || null;
        } catch (err) { return null; }
    }

    function clearCache() {
        _cachedIndex = null;
    }

    api.parseHeader = parseHeader;
    api.parseNameTable = parseNameTable;
    api.readFontNamesFromFile = readFontNamesFromFile;
    api.indexSystemFonts = indexSystemFonts;
    api.resolveFontFile = resolveFontFile;
    api.syncProjectFonts = syncProjectFonts;
    api.getStoredFontsManifest = getStoredFontsManifest;
    api.clearCache = clearCache;

    return api;
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = PardFontEngine;
}
if (typeof window !== "undefined") {
    window.PardFontEngine = PardFontEngine;
}
