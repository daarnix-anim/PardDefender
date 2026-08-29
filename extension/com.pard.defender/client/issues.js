/*
 * PardDefender - the issue store.
 *
 * @map role: Хранилище проблем: четыре класса ошибок, расписание
 *           повторов, предохранитель. Одна строка на элемент, а не на
 *           попытку.
 * @map status: ready
 *
 * One row per problem element, never one row per attempt. A file that has been
 * locked by another application for two hours is one line saying so, not forty
 * identical log entries.
 *
 * Everything keys off an error CODE, never off message text: a Node version
 * that rewords an errno must not be able to change the retry policy.
 *
 * Four classes, with genuinely different behaviour:
 *
 *   transient  the situation is expected to clear by itself - retry on a
 *              widening schedule, then give up and ask for attention
 *   owner      nothing will change until the owner does something - show it,
 *              offer actions, never spin
 *   permanent  the question no longer applies - record it once and go quiet
 *   system     the whole pass is compromised - pause automatic work
 */
var PardIssues = (function () {
    var api = {};

    /* Attempt 1 is immediate; each later one waits longer. Past the end of the
     * table an issue stops retrying on its own and waits for the owner. */
    var RETRY_STEPS = [0, 60000, 300000, 900000, 3600000];

    var CODES = {
        SOURCE_MISSING:        ["owner",     "исходник не найден на диске"],
        ACCESS_DENIED:         ["owner",     "нет доступа к файлу"],
        SOURCE_BUSY:           ["transient", "источник занят другой программой"],
        SOURCE_STALLED:        ["transient", "источник не отдаёт данные — возможно, файл не скачан из облака"],
        SIZE_MISMATCH:         ["transient", "копия не совпала с исходником по размеру"],
        TOO_MANY_FILES:        ["transient", "слишком много открытых файлов"],
        COPY_FAILED:           ["transient", "копирование не удалось"],

        DISK_FULL:             ["system",    "на диске не хватает места"],
        DEST_UNWRITABLE:       ["system",    "папка назначения недоступна для записи"],
        PATH_INVALID:          ["owner",     "недопустимый путь назначения"],
        PATH_TOO_LONG:         ["owner",     "путь назначения слишком длинный"],
        SEQUENCE_EMPTY:        ["owner",     "кадры секвенции не найдены"],

        RELINK_ITEM_GONE:      ["permanent", "элемент удалён из проекта"],
        RELINK_SOURCE_CHANGED: ["permanent", "исходник сменился после проверки"],
        RELINK_PROXY:          ["permanent", "включён прокси — перелинковка пропущена"],
        RELINK_MISSING_COPY:   ["transient", "проверенная копия не найдена на месте"],
        RELINK_REJECTED:       ["owner",     "After Effects отказал в перелинковке"],

        PROTECTED_GONE:        ["owner",     "защищённый файл исчез из папки проекта"],
        PROTECTED_CHANGED:     ["owner",     "защищённый файл изменился на диске"],

        PANEL_FAILED:          ["transient", "не удалось разложить панель проекта"],
        HOST_ERROR:            ["system",    "хост After Effects вернул ошибку"],
        NODE_UNAVAILABLE:      ["system",    "Node недоступен — копирование невозможно"]
    };

    var SEVERITY = { system: 3, owner: 2, transient: 1, permanent: 0 };

    api.describe = function (code) {
        var entry = CODES[code];
        if (!entry) return { klass: "transient", text: "неизвестная ошибка (" + code + ")" };
        return { klass: entry[0], text: entry[1] };
    };

    api.isSystem = function (code) { return api.describe(code).klass === "system"; };

    /* ------------------------------------------------------------- storage */

    var items = {};
    var workspace = "";
    var dirty = false;

    function storePath() { return workspace + "/.parddefender/issues.json"; }

    api.attach = function (workspacePath) {
        workspace = String(workspacePath || "");
        items = {};
        dirty = false;
        if (!workspace) return;
        var raw = PardCopyQueue.readText(storePath());
        if (!raw) return;
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
        if (parsed && parsed.items && typeof parsed.items === "object") items = parsed.items;
    };

    api.save = function () {
        if (!workspace || !dirty) return;
        PardCopyQueue.writeText(storePath(),
            JSON.stringify({ version: 1, savedAt: new Date().toISOString(), items: items }));
        dirty = false;
    };

    api.detach = function () {
        api.save();
        items = {};
        workspace = "";
    };

    /* -------------------------------------------------------------- record */

    /*
     * Recording the same code for the same element advances its attempt counter
     * and pushes the next retry further out. Recording a DIFFERENT code, or the
     * same code after the source changed size, resets the counter: that is a new
     * situation, not a continuation of the old one.
     */
    api.record = function (entry) {
        var key = String(entry.key || entry.id || "");
        if (!key) return null;

        var now = Date.now();
        var meta = api.describe(entry.code);
        var existing = items[key];
        var isSameSituation = existing &&
            existing.code === entry.code &&
            existing.sourceSize === entry.sourceSize;

        var record = isSameSituation ? existing : {
            key: key,
            id: String(entry.id || ""),
            firstSeen: now,
            attempts: 0
        };

        record.name = entry.name || record.name || key;
        record.code = entry.code;
        record.klass = meta.klass;
        record.text = meta.text;
        record.detail = entry.detail || "";
        record.path = entry.path || record.path || "";
        record.sourceSize = entry.sourceSize;
        record.copied = entry.copied === true;
        record.lastSeen = now;
        record.attempts = (record.attempts || 0) + 1;
        record.ignored = false;
        /* A fresh failure supersedes any pending manual retry request. */
        record.retryRequested = false;

        if (meta.klass === "transient" && record.attempts <= RETRY_STEPS.length) {
            var step = RETRY_STEPS[Math.min(record.attempts, RETRY_STEPS.length - 1)];
            record.nextAttemptAt = now + step;
        } else {
            /* Nothing this side can do on a timer; the owner decides. */
            record.nextAttemptAt = 0;
        }

        items[key] = record;
        dirty = true;
        return record;
    };

    /* An element that succeeded stops being a problem. */
    api.clear = function (key) {
        if (items[key]) { delete items[key]; dirty = true; return true; }
        return false;
    };

    api.ignore = function (key) {
        if (!items[key]) return false;
        items[key].ignored = true;
        items[key].nextAttemptAt = 0;
        dirty = true;
        return true;
    };

    /*
     * The owner pressed retry. This has to override the class rules outright:
     * "owner" and "permanent" exist precisely to stop automatic retries, and a
     * manual press is the owner saying the situation has changed.
     */
    api.retryNow = function (key) {
        if (!items[key]) return false;
        items[key].attempts = 0;
        items[key].nextAttemptAt = 0;
        items[key].ignored = false;
        items[key].retryRequested = true;
        dirty = true;
        return true;
    };

    api.get = function (key) { return items[key] || null; };

    /*
     * Whether the automatic pass may attempt this element right now. An element
     * with no history is always allowed; that is the normal path.
     */
    api.isDue = function (key) {
        var record = items[key];
        if (!record) return true;
        if (record.retryRequested) return true;
        if (record.ignored) return false;
        if (record.klass === "permanent") return false;
        if (record.klass === "owner") return false;
        if (!record.nextAttemptAt) return false;
        return Date.now() >= record.nextAttemptAt;
    };

    api.needsAttention = function (record) {
        if (!record || record.ignored) return false;
        if (record.klass === "owner" || record.klass === "system") return true;
        return record.klass === "transient" && !record.nextAttemptAt;
    };

    api.all = function () {
        var out = [], key;
        for (key in items) { if (items.hasOwnProperty(key)) out.push(items[key]); }
        out.sort(function (a, b) {
            var sa = SEVERITY[a.klass] || 0, sb = SEVERITY[b.klass] || 0;
            if (sa !== sb) return sb - sa;
            return (b.lastSeen || 0) - (a.lastSeen || 0);
        });
        return out;
    };

    api.openCount = function () {
        var count = 0, key;
        for (key in items) {
            if (items.hasOwnProperty(key) && !items[key].ignored) count++;
        }
        return count;
    };

    /*
     * Drops rows for elements that are no longer in the project at all. Without
     * this the list would slowly fill with footage the owner deleted months ago.
     */
    api.pruneMissing = function (aliveKeys) {
        var key, removed = 0;
        for (key in items) {
            if (!items.hasOwnProperty(key)) continue;
            if (key.indexOf("sys:") === 0) continue;
            if (!aliveKeys[key]) { delete items[key]; removed++; }
        }
        if (removed) dirty = true;
        return removed;
    };

    /* -------------------------------------------------- circuit breaker */

    /*
     * Three failures with the same code in one pass is not three problems, it is
     * one: the disk filled up, the drive went away, a route is wrong. Grinding
     * through the remaining queue would produce noise, not protection.
     */
    api.evaluateBreaker = function (results, threshold) {
        var limit = threshold || 3;
        var byCode = {}, i, code, worst = null;

        for (i = 0; i < results.length; i++) {
            if (results[i].ok) continue;
            code = results[i].code || "COPY_FAILED";
            byCode[code] = (byCode[code] || 0) + 1;

            if (api.isSystem(code)) {
                return {
                    tripped: true,
                    code: code,
                    count: byCode[code],
                    reason: api.describe(code).text
                };
            }
            if (byCode[code] >= limit && !worst) {
                worst = {
                    tripped: true,
                    code: code,
                    count: byCode[code],
                    reason: api.describe(code).text
                };
            }
        }
        return worst || { tripped: false };
    };

    api.formatSchedule = function (record) {
        if (!record) return "";
        if (record.ignored) return "скрыто";
        if (record.klass === "permanent") return "повтор не требуется";
        if (!record.nextAttemptAt) return "нужно внимание";
        var seconds = Math.max(0, Math.round((record.nextAttemptAt - Date.now()) / 1000));
        if (seconds < 60) return "следующая попытка через " + seconds + " с";
        return "следующая попытка через " + Math.round(seconds / 60) + " мин";
    };

    return api;
})();
