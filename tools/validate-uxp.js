/*
 * @map role: Валидация структуры, манифеста и чистоты кода Premiere Pro UXP расширения перед релизом.
 * @map status: ready
 * @map layer: tools
 *
 * Runs validation checks for Premiere Pro UXP plugin:
 *   node tools/validate-uxp.js
 */
"use strict";

var fs = require("fs");
var path = require("path");

var uxpDir = path.join(__dirname, "..", "premiere", "com.pard.defender.uxp");
var errors = [];

function fail(msg) {
    errors.push(msg);
    console.error("  FAIL: " + msg);
}

function pass(msg) {
    console.log("  OK:   " + msg);
}

console.log("Валидация UXP расширения PardDefender для Premiere Pro...");

var manifestPath = path.join(uxpDir, "manifest.json");
if (!fs.existsSync(manifestPath)) {
    fail("manifest.json отсутствует: " + manifestPath);
} else {
    try {
        var raw = fs.readFileSync(manifestPath, "utf8");
        var manifest = JSON.parse(raw);

        if (manifest.manifestVersion !== 5) fail("manifestVersion должен быть равен 5 (получено: " + manifest.manifestVersion + ")");
        else pass("manifestVersion === 5");

        if (manifest.id !== "com.pard.defender.uxp") fail("Неверный ID плагина: " + manifest.id);
        else pass("Plugin ID === com.pard.defender.uxp");

        if (manifest.version !== "2.0.4") fail("Версия плагина должна быть 2.0.4 (получено: " + manifest.version + ")");
        else pass("Version === 2.0.4");

        var pproHost = Array.isArray(manifest.host)
            ? manifest.host.find(function (h) { return h.app === "premierepro"; })
            : (manifest.host && manifest.host.app === "premierepro" ? manifest.host : null);
        if (!pproHost) fail("Host premierepro не найден в манифесте");
        else if (pproHost.minVersion !== "25.6") fail("minVersion должен быть 25.6 (получено: " + pproHost.minVersion + ")");
        else pass("Host premierepro с minVersion 25.6 подтверждён");

        var mainFile = path.join(uxpDir, manifest.main || "index.html");
        if (!fs.existsSync(mainFile)) fail("Главный файл не найден: " + mainFile);
        else pass("Entrypoint main файл найден: " + manifest.main);
    } catch (e) {
        fail("Ошибка парсинга manifest.json: " + e.message);
    }
}

// Проверка наличия ключевых файлов
var requiredFiles = ["index.html", "main.js", "adapter.js", "copy-engine.js", "duplicates.js", "sync-coordinator.js", "styles.css"];
requiredFiles.forEach(function (f) {
    var full = path.join(uxpDir, f);
    if (!fs.existsSync(full)) fail("Отсутствует обязательный файл: " + f);
    else pass("Файл присутствует: " + f);
});

// Проверка чистоты кода на отсутствие запрещённых паттернов
var forbiddenPatterns = [
    { name: "qe DOM", regex: /\bqe\./ },
    { name: "evalScript", regex: /\bevalScript\s*\(/ },
    { name: "CSInterface", regex: /\bCSInterface\b/ },
    { name: "ExtendScript #include", regex: /\b#include\b/i }
];

var jsFiles = ["main.js", "adapter.js", "copy-engine.js", "duplicates.js", "sync-coordinator.js"];
jsFiles.forEach(function (file) {
    var p = path.join(uxpDir, file);
    if (!fs.existsSync(p)) return;
    var content = fs.readFileSync(p, "utf8");
    forbiddenPatterns.forEach(function (pat) {
        if (pat.regex.test(content)) {
            fail("Обнаружен запрещённый паттерн " + pat.name + " в файле " + file);
        }
    });
});

if (errors.length === 0) {
    console.log("\nВалидация UXP расширения успешно пройдена без замечаний.");
    process.exit(0);
} else {
    console.error("\nОшибок валидации UXP: " + errors.length);
    process.exit(1);
}
