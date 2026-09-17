/*
 *
 * @map role: Прогоняет все наборы и выдаёт один вердикт.
 * @map status: ready
 * Runs every suite and reports one verdict.
 *   node tests/run-all.js
 */
"use strict";

var childProcess = require("child_process");
var path = require("path");

var suites = ["host.test.js", "copy-queue.test.js", "runtime.test.js",
    "host-adapter.test.js", "workspace-store.test.js",
    "duplicate-index.test.js", "consolidation.test.js",
    "premiere-adapter.test.js", "premiere-protection.test.js",
    "sync-coordinator.test.js", "panel.test.js", "e2e-hardening.test.js"];

var failedSuites = [];

suites.forEach(function (name) {
    var result = childProcess.spawnSync(
        process.execPath,
        [path.join(__dirname, name)],
        { encoding: "utf8" }
    );
    var tail = String(result.stdout || "").trim().split("\n").pop();
    var ok = result.status === 0;
    if (!ok) {
        failedSuites.push(name);
        process.stdout.write(result.stdout || "");
        process.stdout.write(result.stderr || "");
    }
    console.log((ok ? "  OK  " : "  FAIL") + "  " + name + "  —  " + tail);
});

console.log(failedSuites.length === 0
    ? "\nВсе наборы пройдены."
    : "\nПровалено наборов: " + failedSuites.length + " (" + failedSuites.join(", ") + ")");

process.exit(failedSuites.length === 0 ? 0 : 1);
