/*
 *
 * @map role: Проверки клиентского адаптера After Effects: вызовы, экранирование, ошибки CEP.
 * @map status: ready
 *
 * Exercises the host adapter in isolation without running the full panel:
 * describe(), initialize(), escaping, error handling when CEP is missing,
 * and verifying every public method constructs the correct AE host call.
 *
 *   node tests/host-adapter.test.js
 */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var passed = 0, failed = 0;

function check(label, actual, expected) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failed++;
    console.log("FAIL  " + label + "\n      ожидалось " + e + "\n      получено  " + a);
}

function group(name) { console.log("\n" + name); }

var adapterFile = path.join(__dirname, "..", "extension", "com.pard.defender",
    "client", "host-adapter.js");
var adapterCode = fs.readFileSync(adapterFile, "utf8");

function createHarness(customCep, options) {
    var opt = options || {};
    var calls = [];
    var cep = customCep;

    if (cep === undefined) {
        cep = {
            evalScript: function (script, callback) {
                calls.push(script);
                if (typeof opt.evalResponse === "function") {
                    callback(opt.evalResponse(script));
                } else if (opt.evalResponse !== undefined) {
                    callback(opt.evalResponse);
                } else {
                    callback("OK");
                }
            }
        };
    }

    var sandbox = {
        require: require, console: console, Date: Date, Math: Math, JSON: JSON,
        String: String, Number: Number, Array: Array, Object: Object,
        RegExp: RegExp, Error: Error,
        window: {
            location: { pathname: "/test-root/client/index.html" },
            __adobe_cep__: cep
        }
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(adapterCode, sandbox, { filename: "host-adapter.js" });

    return {
        adapter: sandbox.PardHostAdapter,
        calls: calls,
        sandbox: sandbox
    };
}

/* ---------------------------------------------------------------- describe */

group("PardHostAdapter.describe()");

var h1 = createHarness();
var desc = h1.adapter.describe();

check("describe возвращает объект", typeof desc, "object");
check("id хоста", desc.id, "after-effects");
check("код приложения AEFT", desc.appCode, "AEFT");
check("capability auditMedia", desc.capabilities.auditMedia, true);
check("capability commitRelinks", desc.capabilities.commitRelinks, true);
check("capability organizePanel", desc.capabilities.organizePanel, true);
check("capability removeUnusedProjectItems", desc.capabilities.removeUnusedProjectItems, true);
check("capability scanForgottenLayers", desc.capabilities.scanForgottenLayers, true);
check("capability revealItems", desc.capabilities.revealItems, true);
check("capability proxies", desc.capabilities.proxies, true);
check("полный набор capability-флагов (7 штук)",
    Object.keys(desc.capabilities).sort(),
    ["auditMedia", "commitRelinks", "organizePanel", "proxies",
        "removeUnusedProjectItems", "revealItems", "scanForgottenLayers"].sort()
);

/* -------------------------------------------------------------- initialize */

group("PardHostAdapter.initialize()");

var loadedFiles = [];
var h2 = createHarness(undefined, {
    evalResponse: function (script) {
        if (script.indexOf("$.evalFile") >= 0) {
            var match = /new File\('([^']+)'\)/.exec(script);
            if (match) loadedFiles.push(match[1].replace(/\\/g, "/"));
            return "OK";
        }
        if (script.indexOf("PardDefenderHost.version") >= 0) {
            return "OK|1.3.0";
        }
        return "OK";
    }
});

var initOk = null, initInfo = null;
h2.adapter.initialize("/my/ext/root", function (ok, info) {
    initOk = ok;
    initInfo = info;
});

check("initialize успешен", initOk, true);
check("initialize вернул версию хоста", initInfo, "1.3.0");
check("порядок загрузки JSX-модулей", loadedFiles, [
    "/my/ext/root/host/PardDefenderCore.jsx",
    "/my/ext/root/host/PardDefenderPlan.jsx",
    "/my/ext/root/host/PardDefenderAudit.jsx",
    "/my/ext/root/host/PardDefenderApply.jsx",
    "/my/ext/root/host/PardDefenderLayers.jsx"
]);

/* Fallback к window.location при отсутствии явного root */
var h2b = createHarness(undefined, {
    evalResponse: function (script) {
        if (script.indexOf("PardDefenderHost.version") >= 0) return "OK|2.0.3";
        return "OK";
    }
});
var initDefaultOk = null, initDefaultInfo = null;
h2b.adapter.initialize(function (ok, info) {
    initDefaultOk = ok;
    initDefaultInfo = info;
});
check("initialize без root использует window.location", initDefaultOk, true);
check("initialize без root вернул версию", initDefaultInfo, "2.0.3");

/* Ошибка при пустом root */
var h2c = createHarness();
h2c.sandbox.window.location.pathname = "";
var noRootOk = null, noRootInfo = null;
h2c.adapter.initialize("", function (ok, info) {
    noRootOk = ok;
    noRootInfo = info;
});
check("отсутствие root даёт ошибку", noRootOk, false);
check("текст ошибки отсутствия root", noRootInfo, "Не удалось определить папку расширения.");

/* Обработка MISSING файла */
var h2d = createHarness(undefined, {
    evalResponse: function (script) {
        if (script.indexOf("PardDefenderPlan.jsx") >= 0) return "MISSING|/host/PardDefenderPlan.jsx";
        return "OK";
    }
});
var missingOk = null, missingInfo = null;
h2d.adapter.initialize("/root", function (ok, info) {
    missingOk = ok;
    missingInfo = info;
});
check("MISSING файла даёт ошибку", missingOk, false);
check("текст ошибки MISSING файла", missingInfo,
    "PardDefenderPlan.jsx: MISSING — /host/PardDefenderPlan.jsx");

/* Обработка NO_API */
var h2e = createHarness(undefined, {
    evalResponse: function (script) {
        if (script.indexOf("PardDefenderHost.version") >= 0) return "NO_API";
        return "OK";
    }
});
var noApiOk = null, noApiInfo = null;
h2e.adapter.initialize("/root", function (ok, info) {
    noApiOk = ok;
    noApiInfo = info;
});
check("NO_API даёт ошибку", noApiOk, false);
check("текст ошибки NO_API", noApiInfo, "Хост загрузился, но API недоступен: NO_API");

/* ---------------------------------------------------- отсутствие CEP API */

group("Отсутствие CEP API или сбой evalScript");

var h3 = createHarness(null);
var noCepInitOk = null, noCepInitInfo = null;
h3.adapter.initialize("/root", function (ok, info) {
    noCepInitOk = ok;
    noCepInitInfo = info;
});
check("initialize без CEP не падает, а сообщает ошибку", noCepInitOk, false);
check("сообщение об ошибке evalScript при загрузке", noCepInitInfo,
    "PardDefenderCore.jsx: EvalScript error.");

var methodsTested = 0;
function testNoCep(methodName, callMethod) {
    var result = null;
    callMethod(function (raw) { result = raw; });
    check(methodName + " без CEP возвращает EvalScript error.", result, "EvalScript error.");
    methodsTested++;
}

testNoCep("auditToFile", function (cb) { h3.adapter.auditToFile(cb); });
testNoCep("commitFromFileJson", function (cb) { h3.adapter.commitFromFileJson("/plan", cb); });
testNoCep("organizeFromFileJson", function (cb) { h3.adapter.organizeFromFileJson("/plan", cb); });
testNoCep("removeItemsFromFileJson", function (cb) { h3.adapter.removeItemsFromFileJson("/plan", cb); });
testNoCep("scanLayersToFile", function (cb) { h3.adapter.scanLayersToFile(cb); });
testNoCep("revealComp", function (cb) { h3.adapter.revealComp("1", cb); });
testNoCep("revealLayer", function (cb) { h3.adapter.revealLayer("1", 2, "L", cb); });
testNoCep("selectItemById", function (cb) { h3.adapter.selectItemById("1", cb); });
testNoCep("writeSettingsFromFile", function (cb) { h3.adapter.writeSettingsFromFile("/p", cb); });
testNoCep("revealWorkspace", function (cb) { h3.adapter.revealWorkspace(cb); });
check("все методы проверены на отсутствие CEP", methodsTested, 10);

/* Исключение внутри evalScript не ломает вызов */
var h3b = createHarness({
    evalScript: function () { throw new Error("CEP crash"); }
});
var crashResult = null;
h3b.adapter.auditToFile(function (raw) { crashResult = raw; });
check("исключение CEP перехватывается", crashResult, "EvalScript error.");

/* Вызов без callback не бросает исключений */
var threwNoCb = false;
try {
    h3.adapter.revealWorkspace();
    h3.adapter.auditToFile();
} catch (e) {
    threwNoCb = true;
}
check("вызов без callback безопасен", threwNoCb, false);

/* ------------------------------------------- каждый метод строит вызов AE */

group("Формирование вызовов хоста и передача ответов");

var h4 = createHarness();
var rawEcho = null;

h4.calls.length = 0;
h4.adapter.auditToFile(function (r) { rawEcho = r; });
check("auditToFile script", h4.calls[0], "$.global.PardDefenderHost.auditToFile();");
check("auditToFile callback", rawEcho, "OK");

h4.calls.length = 0;
h4.adapter.commitFromFileJson("C:/temp/relink.json", function (r) { rawEcho = r; });
check("commitFromFileJson script", h4.calls[0],
    "$.global.PardDefenderHost.commitFromFileJson('C:/temp/relink.json');");

h4.calls.length = 0;
h4.adapter.organizeFromFileJson("C:/temp/panel.json", function (r) { rawEcho = r; });
check("organizeFromFileJson script", h4.calls[0],
    "$.global.PardDefenderHost.organizeFromFileJson('C:/temp/panel.json');");

h4.calls.length = 0;
h4.adapter.removeItemsFromFileJson("C:/temp/remove.json", function (r) { rawEcho = r; });
check("removeItemsFromFileJson script", h4.calls[0],
    "$.global.PardDefenderHost.removeItemsFromFileJson('C:/temp/remove.json');");

h4.calls.length = 0;
h4.adapter.scanLayersToFile(function (r) { rawEcho = r; });
check("scanLayersToFile script", h4.calls[0],
    "$.global.PardDefenderHost.scanLayersToFile();");

h4.calls.length = 0;
h4.adapter.revealComp("42", function (r) { rawEcho = r; });
check("revealComp script", h4.calls[0],
    "$.global.PardDefenderHost.revealComp('42');");

h4.calls.length = 0;
h4.adapter.revealLayer("42", 3, "Layer Name", function (r) { rawEcho = r; });
check("revealLayer script", h4.calls[0],
    "$.global.PardDefenderHost.revealLayer('42', 3, 'Layer Name');");

h4.calls.length = 0;
h4.adapter.selectItemById("99", function (r) { rawEcho = r; });
check("selectItemById script", h4.calls[0],
    "$.global.PardDefenderHost.selectItemById('99');");

h4.calls.length = 0;
h4.adapter.writeSettingsFromFile("C:/temp/settings.json", function (r) { rawEcho = r; });
check("writeSettingsFromFile script", h4.calls[0],
    "$.global.PardDefenderHost.writeSettingsFromFile('C:/temp/settings.json');");

h4.calls.length = 0;
h4.adapter.revealWorkspace(function (r) { rawEcho = r; });
check("revealWorkspace script", h4.calls[0],
    "$.global.PardDefenderHost.revealWorkspace();");

/* ---------------------------------------------------------- экранирование */

group("Экранирование кавычек, backslash и переводов строк");

var h5 = createHarness();

/* Backslash и кавычки в путях планов */
h5.calls.length = 0;
h5.adapter.commitFromFileJson("C:\\Users\\Artist's Work\\relink.json", function () {});
check("экранирование Windows-пути и одинарной кавычки",
    h5.calls[0],
    "$.global.PardDefenderHost.commitFromFileJson('C:\\\\Users\\\\Artist\\'s Work\\\\relink.json');"
);

/* Кавычки, обратные слеши и переводы строк в композиции и слое */
h5.calls.length = 0;
h5.adapter.revealLayer("Comp '1'\\Test", 5, "Layer 'Main'\r\nSubline", function () {});
check("экранирование revealLayer: кавычки, backslash, \\r и \\n",
    h5.calls[0],
    "$.global.PardDefenderHost.revealLayer('Comp \\'1\\'\\\\Test', 5, 'Layer \\'Main\\'\\r\\nSubline');"
);

/* Экранирование в selectItemById */
h5.calls.length = 0;
h5.adapter.selectItemById("id'with\\special\r\nchars", function () {});
check("экранирование selectItemById",
    h5.calls[0],
    "$.global.PardDefenderHost.selectItemById('id\\'with\\\\special\\r\\nchars');"
);

/* Экранирование в writeSettingsFromFile */
h5.calls.length = 0;
h5.adapter.writeSettingsFromFile("D:\\Projects\\O'Reilly\\settings.json", function () {});
check("экранирование writeSettingsFromFile",
    h5.calls[0],
    "$.global.PardDefenderHost.writeSettingsFromFile('D:\\\\Projects\\\\O\\'Reilly\\\\settings.json');"
);

/* ---------------------------------------------------- чистота main.js */

group("Отсутствие прямых связей с CEP и хостом в main.js");

var mainFile = path.join(__dirname, "..", "extension", "com.pard.defender",
    "client", "main.js");
var mainCode = fs.readFileSync(mainFile, "utf8");

check("main.js не содержит window.__adobe_cep__.evalScript",
    mainCode.indexOf("window.__adobe_cep__.evalScript") >= 0, false);
check("main.js не содержит window.__adobe_cep__",
    mainCode.indexOf("window.__adobe_cep__") >= 0, false);
check("main.js не содержит __adobe_cep__",
    mainCode.indexOf("__adobe_cep__") >= 0, false);
check("main.js не содержит $.global.PardDefenderHost",
    mainCode.indexOf("$.global.PardDefenderHost") >= 0, false);
check("main.js не содержит PardDefenderHost",
    mainCode.indexOf("PardDefenderHost") >= 0, false);
check("main.js не содержит объявления evalScript",
    /function\s+evalScript\s*\(/.test(mainCode), false);
check("main.js не содержит объявления escapeForExtendScript",
    /function\s+escapeForExtendScript\s*\(/.test(mainCode), false);
check("main.js использует PardHostAdapter",
    mainCode.indexOf("PardHostAdapter.") >= 0, true);

/* ------------------------------------------------------------------ итог */

console.log("\nВсе проверки пройдены: " + passed);
process.exit(failed === 0 ? 0 : 1);
