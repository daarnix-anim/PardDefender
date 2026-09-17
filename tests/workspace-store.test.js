/*
 *
 * @map role: 40 проверок реестра рабочей зоны: идентификация, блокировки, журнал событий.
 * @map status: ready
 *
 * Tests workspace identity, project registry across AE and Premiere,
 * atomic locks, recovery, idempotency and events.jsonl parsing.
 *
 *   node tests/workspace-store.test.js
 */
"use strict";

var fs = require("fs");
var os = require("os");
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

var storeFile = path.join(__dirname, "..", "extension", "com.pard.defender",
    "client", "workspace-store.js");

function loadStore() {
    var sandbox = {
        require: require, console: console, Date: Date, Math: Math, JSON: JSON,
        String: String, Number: Number, Array: Array, Object: Object,
        RegExp: RegExp, Error: Error, process: process
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(storeFile, "utf8"), sandbox, { filename: "workspace-store.js" });
    return sandbox.PardWorkspaceStore;
}

var store = loadStore();

var testRoot = path.join(os.tmpdir(), "pd-test-workspace-" + Date.now()).replace(/\\/g, "/");
fs.mkdirSync(testRoot.replace(/\//g, path.sep), { recursive: true });

/* ----------------------------------------------------------- нормализация */

group("1. Нормализация путей Windows");

check("замена backslash на slash",
    store.normalizePath("C:\\Projects\\Soul\\04_edit\\Soul.aep"),
    "c:/Projects/Soul/04_edit/Soul.aep");

check("приведение буквы диска к нижнему регистру",
    store.normalizePath("D:/Projects/Video/"),
    "d:/Projects/Video");

check("удаление концевого слэша",
    store.normalizePath("E:\\Work\\Proj\\"),
    "e:/Work/Proj");

check("обработка повторных слэшей",
    store.normalizePath("C://Work///Video////edit"),
    "c:/Work/Video/edit");

/* ------------------------------------------------------------- workspace */

group("2. Создание и повторное чтение workspaceId");

var wsRoot1 = testRoot + "/ws1";
var r1 = store.ensureWorkspace(wsRoot1);
check("первичное создание workspace успешно", r1.ok, true);
check("наличие workspaceId", typeof r1.workspaceId === "string" && r1.workspaceId.length > 5, true);

var r2 = store.ensureWorkspace(wsRoot1);
check("повторное чтение возвращает тот же workspaceId", r2.workspaceId, r1.workspaceId);

var wsFile = wsRoot1 + "/.parddefender/workspace.json";
check("файл workspace.json существует", fs.existsSync(wsFile.replace(/\//g, path.sep)), true);
var wsData = store.readJson(wsFile);
check("schemaVersion равен 1", wsData.schemaVersion, 1);
check("root нормализован", wsData.root, store.normalizePath(wsRoot1));

/* ----------------------------------------------------- стабильный AE id */

group("3. Стабильный AE projectId для одного пути");

var aePath = wsRoot1 + "/04_edit/Project.aep";
var p1 = store.registerProject(wsRoot1, { host: "after-effects", path: aePath });
check("регистрация AE проекта успешна", p1.ok, true);
check("наличие projectId", typeof p1.projectId === "string", true);

var p2 = store.registerProject(wsRoot1, { host: "after-effects", path: aePath });
check("повторная регистрация того же пути даёт тот же projectId", p2.projectId, p1.projectId);
check("проект обновлён, а не создан заново", p2.updated, true);

/* ---------------------------------------- Save As в сессии vs отдельная копия */

group("4. Save As в текущей сессии и отдельная неизвестная копия");

var session = { projectId: p1.projectId };
var saveAsPath = wsRoot1 + "/04_edit/Project_v2.aep";

var pSaveAs = store.registerProject(wsRoot1, { host: "after-effects", path: saveAsPath }, session);
check("Save As в той же сессии сохраняет projectId", pSaveAs.projectId, p1.projectId);
check("путь проекта обновлён", pSaveAs.project.normalizedPath, store.normalizePath(saveAsPath));

/* Неизвестная копия после перезапуска без сессии */
var freshCopyPath = wsRoot1 + "/04_edit/Project_copy.aep";
var pFresh = store.registerProject(wsRoot1, { host: "after-effects", path: freshCopyPath }, {});
check("неизвестная копия получает новый projectId", pFresh.projectId !== p1.projectId, true);
check("у новой копии created === true", pFresh.created, true);

/* ------------------------------------------------ Premiere GUID identity */

group("5. Идентичность Premiere Pro по GUID");

var pproGuid = "{ABCDEF01-2345-6789-ABCD-EF0123456789}";
var pproPath1 = wsRoot1 + "/04_edit/Premiere.prproj";
var pr1 = store.registerProject(wsRoot1, {
    host: "premiere-pro",
    path: pproPath1,
    projectGuid: pproGuid
});
check("регистрация Premiere успешна", pr1.ok, true);
var prId = pr1.projectId;

/* Save As в Premiere Pro в новой независимой сессии (session = {}) */
var pproPath2 = wsRoot1 + "/04_edit/Premiere_Final.prproj";
var pr2 = store.registerProject(wsRoot1, {
    host: "premiere-pro",
    path: pproPath2,
    projectGuid: pproGuid
}, {});
check("Save As в Premiere Pro сохраняет projectId по GUID даже в новой сессии", pr2.projectId, prId);
check("новый путь зафиксирован", pr2.project.normalizedPath, store.normalizePath(pproPath2));

/* ------------------------------------------------ Конфликт без перезаписи */

group("6. Конфликт без перезаписи");

/* Другой проект пытается занять путь, уже принадлежащий проекту prId */
var prConflict = store.registerProject(wsRoot1, {
    host: "premiere-pro",
    path: pproPath2,
    projectGuid: "{DIFFERENT-GUID-0000}"
}, {});

check("коллизия пути даёт conflict: true", prConflict.conflict, true);
check("коллизия не успешна", prConflict.ok, false);

/* Проверяем, что исходный файл проекта не перезаписан */
var prSaved = store.readJson(wsRoot1 + "/.parddefender/projects/" + prId + ".json");
check("исходный проект остался невредим", prSaved.projectGuid, pproGuid);

/* ----------------------------------------- Atomic JSON write & rollback */

group("7. Атомарная запись JSON и отказ до rename");

var atomicTarget = wsRoot1 + "/test-atomic.json";
store.writeJsonAtomic(atomicTarget, { a: 1 });
check("первая запись успешна", store.readJson(atomicTarget), { a: 1 });

var hookFailed = false;
try {
    store.writeJsonAtomic(atomicTarget, { a: 2 }, function () {
        throw new Error("Simulated crash before rename");
    });
} catch (e) {
    hookFailed = true;
}
check("исключение до rename перехвачено", hookFailed, true);
check("файл назначения не изменился при сбое до rename", store.readJson(atomicTarget), { a: 1 });

/* ----------------------------------------- Конкуренция блокировок и stale-lock */

group("8. Блокировки: конкуренция, таймаут и stale-lock recovery");

var lockWs = testRoot + "/ws-locks";
fs.mkdirSync(lockWs.replace(/\//g, path.sep), { recursive: true });

var lock1Acquired = false;
var lock2TimedOut = false;

store.withLock(lockWs, "test", function () {
    lock1Acquired = true;
    /* Попытка взять тот же lock с коротким таймаутом должна упасть по timeout */
    try {
        store.withLock(lockWs, "test", function () {}, { timeoutMs: 150, pollMs: 20 });
    } catch (e) {
        lock2TimedOut = true;
    }
});

check("lock1 успешно захвачен", lock1Acquired, true);
check("конкурентный lock2 отвалился по таймауту", lock2TimedOut, true);

/* Stale lock recovery */
var staleLockDir = lockWs + "/.parddefender/locks/stale_test.lock";
fs.mkdirSync(staleLockDir.replace(/\//g, path.sep), { recursive: true });
fs.writeFileSync(
    (staleLockDir + "/owner.json").replace(/\//g, path.sep),
    JSON.stringify({ token: "dead", at: Date.now() - 10000, pid: 999999 }),
    "utf8"
);

var recovered = false;
store.withLock(lockWs, "stale_test", function () {
    recovered = true;
}, { staleMs: 1000, timeoutMs: 500 });
check("stale lock успешно очищен и захвачен", recovered, true);

/* ------------------------------------------------ Идемпотентный eventId */

group("9. Идемпотентность eventId в events.jsonl");

var evWs = testRoot + "/ws-events";
var evId = "event-unique-123";

var e1 = store.appendEvent(evWs, {
    eventId: evId,
    type: "test_event",
    payload: { step: 1 }
});
check("первая запись события успешна", e1.ok, true);
check("duplicate равен undefined/false", !e1.duplicate, true);

var e2 = store.appendEvent(evWs, {
    eventId: evId,
    type: "test_event",
    payload: { step: 1 }
});
check("повторная запись с тем же eventId сообщает duplicate: true", e2.duplicate, true);

var eventsResult = store.readEvents(evWs);
check("в файле ровно 1 запись благодаря идемпотентности", eventsResult.events.length, 1);

/* --------------------------------- Оборванная последняя строка vs середина */

group("10. Чтение events.jsonl: оборванная последняя строка и сбой в середине");

var badEventsWs = testRoot + "/ws-bad-events";
var badMeta = badEventsWs + "/.parddefender";
fs.mkdirSync(badMeta.replace(/\//g, path.sep), { recursive: true });

/* Случай А: оборванная последняя строка (например, аварийное выключение ПК) */
var eventsFileA = badMeta + "/events.jsonl";
fs.writeFileSync(
    eventsFileA.replace(/\//g, path.sep),
    JSON.stringify({ eventId: "e1", type: "one" }) + "\n" +
    JSON.stringify({ eventId: "e2", type: "two" }) + "\n" +
    '{"eventId":"e3","type":"incom',
    "utf8"
);

var readA = store.readEvents(badEventsWs);
check("оборванная последняя строка не роняет чтение (ok: true)", readA.ok, true);
check("прочитано 2 валидных события", readA.events.length, 2);
check("флаг truncatedLastLine установлен", readA.truncatedLastLine, true);

/* Случай Б: битая строка в середине */
var eventsFileB = badMeta + "/events.jsonl";
fs.writeFileSync(
    eventsFileB.replace(/\//g, path.sep),
    JSON.stringify({ eventId: "e1", type: "one" }) + "\n" +
    'CORRUPTED_LINE_IN_MIDDLE\n' +
    JSON.stringify({ eventId: "e2", type: "two" }) + "\n",
    "utf8"
);

var readB = store.readEvents(badEventsWs);
check("битая строка в середине возвращает ok: false", readB.ok, false);
check("номер повреждённой строки", readB.corruptedLine, 2);

/* ------------------------------------------------------------------ итог */

console.log("\nВсе проверки пройдены: " + passed);
process.exit(failed === 0 ? 0 : 1);
