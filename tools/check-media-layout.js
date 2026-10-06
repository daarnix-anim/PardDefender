/*
 * @map role: Необязательная браузерная проверка адаптивной вёрстки списка AE без запуска Adobe.
 * @map status: ready
 * Run: node tools/check-media-layout.js. Needs local Chrome; adds no dependencies.
 */
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const assert = require("assert");
const browser = process.env.PARD_LAYOUT_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (!fs.existsSync(browser)) throw Error("Chrome unavailable; set PARD_LAYOUT_CHROME to its executable.");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pard-media-layout-"));
const client = path.join(__dirname, "../extension/com.pard.defender/client");
const html = fs.readFileSync(path.join(client, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace('<link rel="stylesheet" href="styles.css">', "<style>" + fs.readFileSync(path.join(client, "styles.css"), "utf8") + "</style>");
const fixtures = [
    ["comp", "Композиция", "Main", false],
    ["video", "Видео", "Shot.mp4", true],
    ["image", "Изображения", "Картинка с очень длинным названием.psd", true],
    ["audio", "Аудио", "Voice.wav", true],
    ["model", "3D-модели", "Scene.glb", true],
    ["comp", "Вложенная композиция", "Nested", true]
];
const script = `(function () {
    document.getElementById('panel').className = 'panel layers-active';
    document.querySelectorAll('.pane').forEach(function (pane) { pane.hidden = pane.id !== 'pane-layers'; });
    document.getElementById('layers-section').hidden = false;
    document.getElementById('status').textContent = 'ПРОЕКТ ЗАЩИЩЁН';
    document.getElementById('counts').hidden = false;
    document.getElementById('counts').textContent = 'Защищено: 24 · выключено: 12';
    document.getElementById('tabs').hidden = false;
    document.getElementById('tabs').innerHTML = '<button class="tab">ПАНЕЛЬ</button><button class="tab active">ВЫКЛЮЧЕНО И ЗАБЫТО</button>';
    document.getElementById('layers-visible').textContent = '12 / 12';
    var rows = ${JSON.stringify(fixtures)};
    for (var i = 0; i < 12; i++) {
        var item = rows[i % rows.length], row = document.createElement('div');
        row.className = 'layer-row media-' + item[0] + (item[3] ? ' in-comp' : '') + (item[0] === 'comp' && item[3] ? ' nested-comp' : '');
        row.innerHTML = '<div class="layer-head"><span class="dot yellow"></span><span class="layer-name">' + item[2] + '</span><span class="layer-where">Интро · слой ' + (i + 1) + '</span></div><div class="layer-text">' + item[1] + ' · выключен</div><div class="layer-foot"><span class="layer-size">2 MB</span><span class="issue-actions"><button class="icon act">⌕</button><button class="icon act">⚑</button><button class="icon act">✎</button><button class="icon act">↓</button></span></div>';
        document.getElementById('layers').appendChild(row);
    }
    var list = document.getElementById('layers').getBoundingClientRect();
    var complete = Array.from(document.querySelectorAll('.layer-row')).filter(function (row) {
        var r = row.getBoundingClientRect(); return r.top >= list.top && r.bottom <= Math.min(list.bottom, innerHeight);
    }).length;
    var result = { width: innerWidth, height: innerHeight, listHeight: list.height, complete: complete,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        bodyHeight: document.documentElement.scrollHeight };
    var output = document.createElement('pre'); output.id = 'layout-result'; output.hidden = true;
    output.textContent = JSON.stringify(result); document.body.appendChild(output);
})();`;
const fixture = path.join(root, "ae.html");
fs.writeFileSync(fixture, html.replace("</body>", "<script>" + script + "</script></body>"));
// Chrome's window flag clamps narrow windows to 500px. Use real emulated
// viewports so the 280px media query and screenshots are genuinely tested.
const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-pipe", "--user-data-dir=" + path.join(root, "profile")],
    { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
let nextId = 0, buffer = "";
const pending = new Map(), listeners = new Map();
child.stdio[4].on("data", chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
        const data = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (pending.has(data.id)) {
            const call = pending.get(data.id); pending.delete(data.id); clearTimeout(call.timer);
            if (data.error) call.reject(Error(JSON.stringify(data.error))); else call.resolve(data.result);
        } else if (listeners.has(data.method)) listeners.get(data.method)(data);
    }
});
function send(method, params, sessionId) {
    return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(Error("CDP timeout: " + method)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdio[3].write(JSON.stringify({ id, method, params: params || {}, sessionId }) + "\0");
    });
}
(async function () {
    const target = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    const results = [];
    for (const size of [[380, 640], [380, 900], [280, 440], [800, 640]]) {
        const name = size.join("x"), screenshot = path.join(root, name + ".png");
        await send("Emulation.setDeviceMetricsOverride", { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false }, sessionId);
        let timer;
        const loaded = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(Error("Fixture load timeout")), 15000);
            listeners.set("Page.loadEventFired", () => { clearTimeout(timer); resolve(); });
        });
        await send("Page.navigate", { url: pathToFileURL(fixture).href }, sessionId);
        await loaded;
        const evaluation = await send("Runtime.evaluate", { expression: "document.getElementById('layout-result').textContent", returnByValue: true }, sessionId);
        const result = JSON.parse(evaluation.result.value);
        assert.strictEqual(result.width, size[0], "Exact narrow viewport, not clamped window size");
        assert.strictEqual(result.height, size[1], "Exact panel height");
        assert.ok(!result.horizontalOverflow, "No horizontal overflow at " + name);
        const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
        fs.writeFileSync(screenshot, Buffer.from(shot.data, "base64"));
        results.push(result);
        console.log(name + ": " + JSON.stringify(result));
    }
    assert.ok(results[0].complete >= 5, "Initially at least five complete rows at 640px height");
    assert.ok(results[1].complete > results[0].complete, "Taller panel shows more rows");
    assert.ok(results[2].complete < results[0].complete, "Smaller panel shows fewer rows");
    console.log("Layout checks passed. Screenshots: " + root);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    pending.forEach(call => clearTimeout(call.timer));
    child.kill();
});
