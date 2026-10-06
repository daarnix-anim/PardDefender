/*
 * @map role: Регрессии файлового API UXP, маршрутов и безопасного копирования Premiere.
 * @map status: ready
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const engine = require("../premiere/com.pard.defender.uxp/copy-engine");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pard-uxp-io-"));
const ws = path.join(root, "Проект");
const source = path.join(root, "Внешние");
fs.mkdirSync(source);
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function file(name, bytes) { const p = path.join(source, name); fs.writeFileSync(p, bytes); return p; }
function queue(tasks) { return new Promise(resolve => engine.runQueue(ws, tasks, {}, { onDone: resolve })); }
function task(src, dst) { return { id: path.basename(src), sourcePath: src, destPath: dst, category: "audio" }; }

// Deliberately not Object.create(nodeFs): no sync copy, fs.promises, Buffer,
// or Node callbacks. UXP resolves on fs directly and requires ArrayBuffer.
function uxpFs(errorStyle) {
    const mock = {};
    function nativeError(e) {
        if (!e || !errorStyle) return e;
        const messages = { ENOENT: "no such file or directory", EEXIST: "file already exists", EACCES: "permission denied" };
        const wrapped = new Error(messages[e.code] || e.message);
        if (errorStyle === "number") wrapped.number = { ENOENT: -4058, EEXIST: -4075, EACCES: -4092 }[e.code];
        return wrapped;
    }
    ["lstat", "mkdir", "rename", "unlink", "readdir", "close"].forEach(name => {
        mock[name] = (...args) => new Promise((resolve, reject) => {
            args.pop(); // callback supplied by bridge, ignored by this Promise-only host
            // This UXP host rejects existing mkdir even with recursive:true.
            if (errorStyle && name === "mkdir" && fs.existsSync(args[0])) {
                reject(nativeError(Object.assign(new Error("exists"), { code: "EEXIST" })));
                return;
            }
            fs[name](...args, (e, result) => e ? reject(nativeError(e)) : resolve(result));
        });
    });
    mock.open = (p, flags, mode) => new Promise((resolve, reject) =>
        fs.open(p, flags, mode, (e, fd) => e ? reject(nativeError(e)) : resolve(fd)));
    mock.read = (fd, buffer, offset, length, position) => {
        assert.ok(buffer instanceof ArrayBuffer);
        assert.ok(buffer.byteLength <= 256 * 1024);
        return new Promise((resolve, reject) => fs.read(fd, new Uint8Array(buffer), offset, length, position,
            (e, n) => e ? reject(e) : resolve({ bytesRead: n, buffer })));
    };
    mock.write = (fd, buffer, offset, length, position) => {
        assert.ok(buffer instanceof ArrayBuffer);
        // Exercise short writes (a successful write need not consume the whole chunk).
        return new Promise((resolve, reject) => fs.write(fd, new Uint8Array(buffer), offset, Math.min(length, 65536), position,
            (e, n) => e ? reject(e) : resolve({ bytesWritten: n, buffer })));
    };
    ["readFile", "writeFile"].forEach(name => {
        mock[name] = (...args) => {
            args.pop();
            const options = args[args.length - 1];
            assert.equal(options.encoding, "utf-8", "UXP requires an encoding options object");
            return new Promise((resolve, reject) => fs[name](...args, (e, result) => e ? reject(e) : resolve(result)));
        };
    });
    ["lstatSync", "readFileSync", "writeFileSync", "readdirSync"].forEach(name => {
        mock[name] = fs[name].bind(fs);
    });
    return mock;
}

(async function () {
    const mock = uxpFs("message");
    engine.setFs(mock); engine.setUxp({}); engine.setCrypto(null);
    const src = file("Диктор.wav", Buffer.alloc(700000, 139));
    const dst = path.join(ws, "03_audio", "voice", "Диктор.wav");
    let res = await queue([task(src, dst)]);
    check(res.ok, JSON.stringify(res));
    check(fs.readFileSync(src).equals(fs.readFileSync(dst)), "All bytes survive chunk boundaries and partial writes");
    check(fs.readFileSync(path.join(ws, ".parddefender/assets.tsv"), "utf8").includes("\tpremiere"), "Durable producer attribution");
    check(!fs.existsSync(path.join(ws, ".parddefender/pending.tsv")), "Journal cleared only after completion");
    res = await queue([task(src, dst)]);
    check(res.results[0].reused, "Exact copy reused");
    fs.writeFileSync(dst, Buffer.alloc(700000, 138));
    res = await queue([task(src, dst)]);
    check(res.ok && res.results[0].destPath !== dst, "Same name/size different bytes gets collision-safe path");
    check(fs.readFileSync(dst)[0] === 138, "Existing destination never deleted or overwritten");
    check(fs.existsSync(src), "Original survives");
    check(engine.fileExists(src), "Sync metadata probes use documented lstatSync");
    const sync = require("../premiere/com.pard.defender.uxp/sync-coordinator");
    sync.setFs(mock);
    check(await sync.publishSnapshot(ws, { projectId: "uxp-test", host: "premiere", items: [{ path: dst, oldPath: src }] }), "Snapshot publishes without mkdirSync or renameSync");
    check(sync.loadSnapshot(ws, "uxp-test").items[0].oldPath === src, "AE can read old-to-new path snapshot");
    check(await sync.publishSnapshot(ws, { projectId: "uxp-test", host: "premiere", items: [] }), "Snapshot can replace previous snapshot");
    const adapter = require("../premiere/com.pard.defender.uxp/adapter");
    adapter.setFs(mock);
    check(await adapter.syncProjectRegistry(ws, "uxp-test", ws + "/04_edit/test.prproj"), "Registry publishes through async UXP API");
    let opened = null;
    adapter.setPpro({ SourceMonitor: { openProjectItem: async item => { opened = item; return true; } } });
    const nativeItem = {};
    check((await adapter.revealItem(nativeItem)).ok && opened === nativeItem, "Official SourceMonitor receives the exact project item");
    check(!(await adapter.revealItem(null)).ok, "Missing native item is not opened");
    adapter.setPpro({ SourceMonitor: { openProjectItem: async () => false } });
    check(!(await adapter.revealItem(nativeItem)).ok, "Host refusal is shown as failure");
    adapter.setPpro({ SourceMonitor: { openProjectItem: async () => { throw Error("closed project"); } } });
    check((await adapter.revealItem(nativeItem)).reason === "closed project", "Host exception is returned to UI");
    adapter.setPpro({});
    check(!(await adapter.revealItem(nativeItem)).ok, "Unsupported API is not claimed as success");

    // Match native error shapes rather than inheriting Node's error.code.
    const numberedFs = uxpFs("number");
    engine.setFs(numberedFs);
    const numberedDest = path.join(ws, "03_audio", "voice", "Новая папка", "Числовая ошибка.wav");
    res = await queue([task(src, numberedDest)]);
    check(res.ok && fs.readFileSync(numberedDest).equals(fs.readFileSync(src)), "Numeric -4058 is normal absence of a new destination");
    engine.setFs(mock);
    const absentSource = path.join(source, "deleted.mp4");
    res = await queue([task(absentSource, path.join(ws, "01_assets", "deleted.mp4"))]);
    check(!res.ok && res.results[0].code === "ENOENT", "Absent original is still a failure");
    check(res.results[0].message.includes(absentSource) && res.results[0].operation === "lstat", "Failure retains exact operation and path");

    const deniedFs = uxpFs("message");
    const realStat = deniedFs.lstat;
    const deniedDest = path.join(ws, "03_audio", "voice", "denied.wav");
    deniedFs.lstat = (...args) => args[0] === deniedDest ? Promise.reject(new Error("permission denied")) : realStat(...args);
    engine.setFs(deniedFs);
    res = await queue([task(src, deniedDest)]);
    check(!res.ok && res.results[0].code === "EACCES" && !fs.existsSync(deniedDest), "Permission failure is never treated as an absent destination");
    engine.setFs(mock);
    const fileAsFolder = path.join(ws, "03_audio", "file-as-folder");
    fs.writeFileSync(fileAsFolder, "keep me");
    res = await queue([task(src, path.join(fileAsFolder, "clip.wav"))]);
    check(!res.ok && fs.readFileSync(fileAsFolder, "utf8") === "keep me", "Directory/file conflict never overwrites existing data");
    const raceFs = uxpFs("message");
    raceFs.mkdir = p => {
        fs.mkdirSync(p);
        return Promise.reject(new Error("file already exists"));
    };
    engine.setFs(raceFs);
    const raceDir = path.join(ws, "03_audio", "race-dir");
    const mkdirResult = await new Promise(resolve => engine.mkdirAsync(raceDir, err => resolve(err)));
    check(!mkdirResult && fs.statSync(raceDir).isDirectory(), "Concurrent mkdir succeeds only after verifying the existing directory");
    engine.setFs(mock);

    const badFs = uxpFs();
    const realWrite = badFs.writeFile;
    badFs.writeFile = (...args) => {
        if (args[0].endsWith("pending.tsv")) return Promise.reject(Object.assign(new Error("journal denied"), { code: "EACCES" }));
        return realWrite(...args);
    };
    engine.setFs(badFs);
    const blocked = path.join(ws, "03_audio", "voice", "blocked.wav");
    res = await queue([task(src, blocked)]);
    check(!res.ok && !fs.existsSync(blocked), "Journal failure blocks copy/relink");

    const hangFs = uxpFs();
    hangFs.mkdir = () => new Promise(() => {});
    engine.setFs(hangFs); engine.setIoTimeout(30);
    res = await queue([task(src, path.join(ws, "03_audio", "timeout-new-dir", "timeout.wav"))]);
    check(!res.ok && res.results[0].code === "IO_TIMEOUT", "A stuck mkdir terminates with a visible failure");
    engine.setIoTimeout(30000); engine.setFs(mock);

    const corruptFs = uxpFs();
    const realStreamWrite = corruptFs.write;
    corruptFs.write = (fd, buffer, offset, length, position) => {
        const changed = buffer.slice(0);
        new Uint8Array(changed)[offset] ^= 1;
        return realStreamWrite(fd, changed, offset, length, position);
    };
    engine.setFs(corruptFs);
    const corruptDest = path.join(ws, "03_audio", "voice", "corrupt.wav");
    res = await queue([task(src, corruptDest)]);
    check(!res.ok && !fs.existsSync(corruptDest), "A corrupt copy never reaches its final media path");
    engine.setFs(mock);

    const outside = path.join(root, "outside.wav");
    res = await queue([task(src, outside)]);
    check(!res.ok && !fs.existsSync(outside), "Copy target cannot escape the project");

    const f1 = file("render_0001.png", "frame1");
    file("render_0002.png", "frame2");
    file("unrelated_0001.png", "do not copy");
    const frameDest = path.join(ws, "05_shot_production", "render", "render_0001.png");
    res = await queue([task(f1, frameDest)]);
    check(res.ok && fs.existsSync(path.join(path.dirname(frameDest), "render_0002.png")), "All sequence frames copied");
    check(!fs.existsSync(path.join(path.dirname(frameDest), "unrelated_0001.png")), "Other sequences untouched");
    fs.writeFileSync(path.join(path.dirname(frameDest), "render_0002.png"), "wrong2");
    const aeSequence = task(f1, frameDest); aeSequence.isAeCanonical = true;
    res = await queue([aeSequence]);
    check(!res.ok, "Matching first frame does not authorize a different AE sequence");
    const wrong = task(src, dst); wrong.isAeCanonical = true;
    res = await queue([wrong]);
    check(!res.ok, "AE priority is not permission to replace content with a similar name");
    const rendition = file("Оригинальный ролик.mp4", "original video bytes");
    const aeRendition = path.join(ws, "01_assets", "enhanced.mp4");
    fs.mkdirSync(path.dirname(aeRendition), { recursive: true });
    fs.writeFileSync(aeRendition, "enhanced video bytes");
    const fallback = path.join(ws, "01_assets", "_SHARED", "VIDEO", path.basename(rendition));
    const candidate = Object.assign(task(rendition, aeRendition), { isAeCanonical: true, fallbackDestPath: fallback });
    res = await queue([candidate]);
    check(res.ok && res.results[0].destPath === fallback, "Different AE rendition does not leave original video unprotected");
    check(fs.readFileSync(fallback).equals(fs.readFileSync(rendition)), "Fallback preserves original content");
    check(fs.readFileSync(aeRendition, "utf8") === "enhanced video bytes", "AE rendition stays untouched");
    const missingCandidate = Object.assign(task(rendition, path.join(ws, "01_assets/missing.mp4")), { isAeCanonical: true, fallbackDestPath: fallback });
    res = await queue([missingCandidate]);
    check(res.ok && res.results[0].reused, "Missing AE candidate safely falls back to verified copy");

    const norm = engine.normalizePath(ws);
    let r = engine.resolveDestination({ path: src, binPath: "Audio/Dialogue" }, ws, {});
    check(r.destPath === norm + "/03_audio/voice/Диктор.wav", "Voice uses fixed project layout");
    r = engine.resolveDestination({ path: "I:/Untitled.mp3", audioRole: "music" }, ws, {});
    check(r.destPath === norm + "/03_audio/music/Untitled.mp3", "Explicit audio role handles anonymous imports");
    r = engine.resolveDestination({ path: "I:/Untitled.mp3" }, ws, {});
    check(r.needsAudioRole && r.destPath === norm + "/03_audio/Untitled.mp3", "Unknown audio is protected without inventing its role");
    r = engine.resolveDestination({ path: "I:/x.mov" }, ws, { existingFolders: { shotProd05: true } });
    check(r.destPath.indexOf("/01_assets/") > 0, "Video never falls back to shot production");
    console.log("Итоги: пройдено " + checks + ", провалено 0");
})().catch(e => { console.error(e); process.exitCode = 1; });
