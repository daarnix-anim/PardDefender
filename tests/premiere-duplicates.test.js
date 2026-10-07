/*
 * @map role: Проверяет поиск по всей библиотеке Premiere, приоритет AE, точные ссылки таймлайна и безопасную асинхронную консолидацию.
 * @map status: ready
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mock = require("./mock-premiere");
const duplicates = require("../premiere/com.pard.defender.uxp/duplicates");
const engine = require("../premiere/com.pard.defender.uxp/copy-engine");
const adapter = require("../premiere/com.pard.defender.uxp/adapter");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pard-duplicates-"));
const workspace = path.join(temp, "FilmAssets");
engine.setFs(fs); duplicates.setFs(fs); adapter.setFs(fs);
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function write(p, bytes) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p; }
function item(id, p, options) {
    return Object.assign({ id, name: path.basename(p), binPath: "Library/Video", path: p,
        classification: "clip", size: fs.statSync(p).size, usedOnTimeline: false }, options);
}
function scan(items, options) {
    return new Promise(resolve => duplicates.scanDuplicates(workspace, items, engine, Object.assign({ onDone: resolve }, options)));
}
function consolidate(group, canonical, map, options, copy) {
    return new Promise(resolve => duplicates.consolidateGroup(workspace, group, canonical, map,
        copy || engine, Object.assign({ onDone: resolve }, options)));
}
async function audit(project) {
    return new Promise((resolve, reject) => adapter.auditMedia(project, { timelineOnly: false }, (err, report) => err ? reject(err) : resolve(report)));
}
(async function () {
    const first = write(path.join(temp, "Raw", "first.mp4"), "IDENTICAL-VIDEO-DATA");
    const other = write(path.join(temp, "Downloads", "different-name.mp4"), "IDENTICAL-VIDEO-DATA");
    let result = await scan([item("first", first, { usedOnTimeline: true }), item("other", other)]);
    let group = result.duplicateGroups[0];
    check(result.ok && result.duplicateGroups.length === 1, "Unused bin item is included alongside timeline media");
    check(group.projectItemCount === 2 && group.timelineItemCount === 1, "Library and timeline usage are counted separately");
    check(group.files.some(f => f.items.some(it => it.binPath === "Library/Video")), "Report retains project bin paths");
    result = await scan([item("a", first), item("b", first, { usedOnTimeline: true })]);
    check(result.duplicateGroups.length === 1 && result.duplicateGroups[0].files.length === 1, "Repeated imports of one path are reported");
    check(result.duplicateGroups[0].kind === "project-items" && !result.duplicateGroups[0].canConsolidate && result.reclaimableBytes === 0,
        "Shared sources are not offered a fictitious file consolidation");
    result = await scan([item("a", first), item("a", first)]);
    check(result.duplicateGroups.length === 0, "Repeated audit entry is not a second project item");
    const aePath = write(path.join(workspace, "01_assets", "Scene", "VIDEO", "AE-original.mp4"), "IDENTICAL-VIDEO-DATA");
    result = await scan([item("first", first, { usedOnTimeline: true }), item("other", other)], {
        aeProtectedItems: [{ canonicalPath: aePath, isAeProtected: true, classification: "clip" }]
    });
    group = result.duplicateGroups[0];
    check(group.canonicalLocked && group.recommendedCanonical === aePath, "Verified AE copy wins even if it was never imported into Premiere");
    check(group.files[0].references.length === 0 && group.projectItemCount === 2, "AE metadata does not create a Premiere project item");
    check(group.files.every(f => f.isOwned === false), "Being inside the workspace does not invent ownership");
    const changedName = write(path.join(workspace, "01_assets", "Scene", "VIDEO", "false-match.mp4"), "DIFFERENT-VIDEO-DATA");
    result = await scan([item("first", first), item("other", other, {
        crossHost: { canonicalPath: changedName, isAeProtected: true }
    })]);
    check(!result.duplicateGroups[0].canonicalLocked, "Matching AE names or metadata never override different bytes");
    const unrelatedAe = write(path.join(workspace, "01_assets", "unrelated.mp4"), "UNRELATED");
    result = await scan([item("first", first)], {
        aeProtectedItems: [{ canonicalPath: unrelatedAe, isAeProtected: true }, { canonicalPath: aePath, isAeProtected: false }]
    });
    check(result.duplicateGroups.length === 0, "Unprotected and unrelated AE records do not create duplicate groups");
    result = await scan([item("first", first, { hasProxy: true }), item("other", other), item("seq", first, { classification: "sequence" })]);
    check(result.duplicateGroups.length === 0, "Proxy and sequence project items are excluded from ordinary media consolidation");
    const image1 = write(path.join(temp, "Frames", "frame0001.png"), "FRAME");
    const image2 = write(path.join(temp, "FramesCopy", "frame0001.png"), "FRAME");
    result = await scan([item("frame1", image1), item("frame2", image2)]);
    check(result.duplicateGroups.length === 0, "Numbered image sequences are not matched using a single frame");
    const one = new mock.MockClipProjectItem("One", first), two = new mock.MockClipProjectItem("Two", other);
    const sequence1 = new mock.MockSequence("Edit A"), sequence2 = new mock.MockSequence("Edit B");
    const cuts = [sequence1.addClipToTrack(one), sequence1.addClipToTrack(two), sequence2.addClipToTrack(two, true)];
    cuts.forEach((cut, i) => {
        cut.start = 10 + i * 30; cut.end = cut.start + 4; cut.inPoint = i * 5; cut.outPoint = cut.inPoint + 4;
        cut.speed = i === 1 ? 0.5 : 1; cut.keyframes = [{ time: 0, value: 0 }, { time: 3, value: 100 }];
        cut.effects = { opacity: 75, audioGain: i * 3 };
    });
    const before = cuts.map(cut => JSON.stringify({ start: cut.start, end: cut.end, inPoint: cut.inPoint, outPoint: cut.outPoint,
        speed: cut.speed, keyframes: cut.keyframes, effects: cut.effects }));
    [one, two].forEach(clip => {
        const originalChange = clip.changeMediaFilePath.bind(clip);
        clip.changeMediaPath = undefined;
        clip.getMediaFilePath = async () => clip.mediaFilePath;
        clip.canChangeMediaPath = async () => true;
        clip.changeMediaFilePath = async (p, override) => { assert.strictEqual(override, false); return originalChange(p); };
    });
    let cons = await consolidate(group, first, { first: one, other: two });
    check(!cons.ok && cons.code === "AE_CANONICAL_REQUIRED", "A manual override cannot replace the protected AE canonical");
    cons = await consolidate(group, aePath, { first: one, other: two });
    check(cons.ok && cons.relinked === 2 && cons.links.length === 2, "Official asynchronous path changes are awaited");
    check(engine.normalizePath(await one.getMediaFilePath()) === engine.normalizePath(aePath) &&
        engine.normalizePath(await two.getMediaFilePath()) === engine.normalizePath(aePath), "All duplicate source references use AE's exact path");
    check(cuts.every((cut, i) => before[i] === JSON.stringify({ start: cut.start, end: cut.end, inPoint: cut.inPoint, outPoint: cut.outPoint,
        speed: cut.speed, keyframes: cut.keyframes, effects: cut.effects })), "Cuts on different sequences keep positions, trims, speed, effects and keys");
    check(cuts[0].projectItem === one && cuts[1].projectItem === two && cuts[2].projectItem === two, "Original project and timeline items are retained");
    check(fs.existsSync(first) && fs.existsSync(other) && fs.existsSync(aePath), "All originals remain on disk");
    // Same-size source mutation must block the entire operation before any relink.
    const staleMap = { first: new mock.MockClipProjectItem("One", first), other: new mock.MockClipProjectItem("Two", other) };
    write(other, "ALTERED--VIDEO-DATA!");
    cons = await consolidate(group, aePath, staleMap);
    check(!cons.ok && cons.code === "REHASH_MISMATCH" && cons.links.length === 0, "Changed duplicate bytes block consolidation before its first mutation");
    check(staleMap.first.getMediaFilePath() === first, "A failed preflight leaves earlier sources unchanged");
    write(other, "IDENTICAL-VIDEO-DATA");
    staleMap.other.mediaFilePath = first;
    cons = await consolidate(group, aePath, staleMap);
    check(!cons.ok && cons.code === "STALE_SOURCE" && cons.links.length === 0, "A changed live source blocks the complete plan");
    staleMap.other.mediaFilePath = other;
    cons = await consolidate(group, aePath, staleMap, { checkProject: async () => false });
    check(!cons.ok && cons.code === "PROJECT_CHANGED" && cons.links.length === 0, "Project switching blocks consolidation");
    cons = await consolidate(group, aePath, staleMap, {}, Object.assign({}, engine, {
        relinkVerifiedClip: async () => ({ ok: false, code: "RELINK_REJECTED", reason: "Rejected" })
    }));
    check(!cons.ok && !cons.partial && cons.failures.length === 2, "Async host rejection cannot be reported as success");
    // External audio must keep the established audio route and the actual collision-resolved destination.
    const wav1 = write(path.join(temp, "Raw", "Music.wav"), "AUDIO-BYTES");
    const wav2 = write(path.join(temp, "Downloads", "Music-copy.wav"), "AUDIO-BYTES");
    const occupied = write(path.join(workspace, "03_audio", "music", "Music.wav"), "DIFFERENT-AUDIO");
    const audioItems = [item("wav1", wav1, { binPath: "Music" }), item("wav2", wav2, { binPath: "Music" })];
    result = await scan(audioItems);
    const audioMap = { wav1: new mock.MockClipProjectItem("Music", wav1), wav2: new mock.MockClipProjectItem("Music-copy", wav2) };
    cons = await consolidate(result.duplicateGroups[0], wav1, audioMap, { auditItems: audioItems });
    check(cons.ok && engine.normalizePath(cons.canonical).includes("/03_audio/music/"), "External audio canonical is copied into its audio role route");
    check(engine.normalizePath(cons.canonical) !== engine.normalizePath(occupied) && fs.readFileSync(occupied, "utf8") === "DIFFERENT-AUDIO",
        "A different existing destination is retained and the returned collision-resolved path is used");
    check(engine.normalizePath(audioMap.wav1.getMediaFilePath()) === engine.normalizePath(cons.canonical), "Relink uses the actual copied file");
    // A library item with the same path or name as a used item is not itself used.
    const project = new mock.MockProject("duplicate-project", path.join(workspace, "04_edit", "Film.prproj"), "Film");
    const bin = project.rootItem.addItem(new mock.MockFolderItem("Imported"));
    const used = bin.addItem(new mock.MockClipProjectItem("Same name", first));
    const unused = bin.addItem(new mock.MockClipProjectItem("Same name", first));
    used.getId = async () => used.nodeId;
    unused.getId = async () => unused.nodeId;
    [used, unused].forEach(clip => {
        clip.isSequence = async () => false;
        clip.getSequence = async () => null;
    });
    const seq = new mock.MockSequence("Timeline");
    seq.addClipToTrack(used); seq.addClipToTrack(used, true);
    project.rootItem.addItem(seq);
    const ppro = new mock.MockPremierePro("25.6.2"); ppro.setActiveProject(project); adapter.setPpro(ppro);
    const snap = { schemaVersion: 1, host: "aftereffects", items: [{ id: "ae", path: aePath, protected: true }] };
    write(path.join(workspace, ".parddefender", "projects", "AE.media.json"), JSON.stringify(snap));
    // UXP-style readdir callback, with no readdirSync.
    const uxpFs = Object.assign({}, fs); delete uxpFs.readdirSync; adapter.setFs(uxpFs);
    const report = await audit(project);
    check(report.items.some(it => it.id === unused.nodeId), "Full project audit includes unused items in nested bins");
    check(report.items.find(it => it.id === used.nodeId).timelineOccurrences === 2, "All video and audio occurrences are inspected");
    check(report.items.find(it => it.id === unused.nodeId).usedOnTimelineExact === false, "Same path and name do not invent exact timeline usage");
    check(report.aeProtectedItems.some(ae => engine.normalizePath(ae.canonicalPath) === engine.normalizePath(aePath)), "AE snapshots are read with asynchronous UXP directory APIs");
    result = await scan(report.items, { aeProtectedItems: report.aeProtectedItems });
    check(result.duplicateGroups[0].timelineItemCount === 1 && result.duplicateGroups[0].canonicalLocked, "Duplicates use exact item usage and audit-provided AE priority");
    console.log("Итоги: пройдено " + checks + ", провалено 0");
})().catch(err => { console.error(err); process.exitCode = 1; });
