/*
 * PardDefender - Premiere Pro UXP Plugin Main Controller
 *
 * @map role: UI-контроллер панели Premiere Pro UXP: вкладки «ЗАЩИТА», «ДУБЛИКАТЫ» и «ЖУРНАЛ»,
 *           копирование внешних медиа в workspace с перелинковкой, поиск дубликатов,
 *           двухкликовое объединение файлов и журнал операций.
 * @map status: ready
 *
 * Strictly enforces zero deletions of original files and no removal of project items.
 */
(function () {
    "use strict";

    var el = {
        projTitle: document.getElementById("proj-title"),
        projStatus: document.getElementById("proj-status"),
        projWorkspace: document.getElementById("proj-workspace"),
        projGuid: document.getElementById("proj-guid"),
        btnScan: document.getElementById("btn-scan"),
        btnProtect: document.getElementById("btn-protect"),
        scanIndicator: document.getElementById("scan-indicator"),
        statClips: document.getElementById("stat-clips"),
        statSeqs: document.getElementById("stat-seqs"),
        statOffline: document.getElementById("stat-offline"),
        statGen: document.getElementById("stat-gen"),
        bannerNoProject: document.getElementById("banner-no-project"),
        bannerUnsaved: document.getElementById("banner-unsaved"),
        itemsCount: document.getElementById("items-count"),
        itemsList: document.getElementById("items-list"),

        tabs: document.getElementById("tabs"),
        badgeDuplicates: document.getElementById("badge-duplicates"),
        paneProtect: document.getElementById("pane-protect"),
        paneDuplicates: document.getElementById("pane-duplicates"),
        paneLog: document.getElementById("pane-log"),

        btnScanDuplicates: document.getElementById("btn-scan-duplicates"),
        duplicatesProgressBox: document.getElementById("duplicates-progress-box"),
        duplicatesProgressStats: document.getElementById("duplicates-progress-stats"),
        duplicatesProgressFill: document.getElementById("duplicates-progress-fill"),
        duplicatesSummary: document.getElementById("duplicates-summary"),
        duplicatesList: document.getElementById("duplicates-list"),
        logBox: document.getElementById("log-box")
    };

    var state = {
        scanning: false,
        lastReport: null,
        activeTab: "protect",
        duplicatesResult: null,
        canonicalOverrides: {},
        consolidationArmedGroup: null,
        consolidationArmedUntil: 0
    };

    function log(msg, kind) {
        if (!el.logBox) return;
        var line = document.createElement("div");
        line.className = "log-line " + (kind || "neutral");
        var time = new Date().toTimeString().split(" ")[0];
        line.textContent = "[" + time + "] " + msg;
        el.logBox.appendChild(line);
        el.logBox.scrollTop = el.logBox.scrollHeight;
    }

    function showTab(tabName) {
        state.activeTab = tabName;
        var tabBtns = el.tabs ? el.tabs.querySelectorAll(".tab-btn") : [];
        for (var i = 0; i < tabBtns.length; i++) {
            var btn = tabBtns[i];
            if (btn.getAttribute("data-tab") === tabName) {
                btn.classList.add("is-active");
            } else {
                btn.classList.remove("is-active");
            }
        }

        if (el.paneProtect) el.paneProtect.hidden = (tabName !== "protect");
        if (el.paneDuplicates) el.paneDuplicates.hidden = (tabName !== "duplicates");
        if (el.paneLog) el.paneLog.hidden = (tabName !== "log");
    }

    function render(report) {
        if (!report || !report.ok) {
            if (report && report.error === "NO_ACTIVE_PROJECT") {
                el.bannerNoProject.hidden = false;
                el.bannerUnsaved.hidden = true;
                el.projTitle.textContent = "Нет открытого проекта";
                el.projStatus.textContent = "НЕТ ПРОЕКТА";
                el.projStatus.className = "status-badge";
                el.projWorkspace.textContent = "—";
                el.projGuid.textContent = "—";
                if (el.btnProtect) el.btnProtect.disabled = true;
            } else {
                el.bannerNoProject.hidden = true;
                el.bannerUnsaved.hidden = true;
                el.projTitle.textContent = "Ошибка аудита";
                el.projStatus.textContent = "ОШИБКА";
                el.projStatus.className = "status-badge";
                if (el.btnProtect) el.btnProtect.disabled = true;
            }
            updateStats({ clips: 0, sequences: 0, offline: 0, generated: 0, totalItems: 0 });
            renderItems([]);
            return;
        }

        el.bannerNoProject.hidden = true;

        if (!report.projectSaved) {
            el.bannerUnsaved.hidden = false;
            el.projTitle.textContent = report.projectName || "Без названия";
            el.projStatus.textContent = "НЕ СОХРАНЁН";
            el.projStatus.className = "status-badge unsaved";
            el.projWorkspace.textContent = "— (требуется сохранение)";
            el.projGuid.textContent = report.projectId || "—";
            if (el.btnProtect) el.btnProtect.disabled = true;
            updateStats(report.stats || {});
            renderItems([]);
            return;
        }

        el.bannerUnsaved.hidden = true;
        el.projTitle.textContent = (report.projectPath ? report.projectPath.substring(report.projectPath.lastIndexOf("/") + 1) : "Проект");
        el.projStatus.textContent = "СОХРАНЁН";
        el.projStatus.className = "status-badge saved";
        el.projWorkspace.textContent = report.workspace || "—";
        el.projWorkspace.title = report.workspace || "";
        el.projGuid.textContent = report.projectId || "—";
        if (el.btnProtect) el.btnProtect.disabled = false;

        updateStats(report.stats || {});
        renderItems(report.items || []);
    }

    function updateStats(stats) {
        el.statClips.textContent = stats.clips || 0;
        el.statSeqs.textContent = stats.sequences || 0;
        el.statOffline.textContent = stats.offline || 0;
        el.statGen.textContent = stats.generated || 0;
        el.itemsCount.textContent = stats.totalItems || 0;
    }

    function renderItems(items) {
        el.itemsList.innerHTML = "";
        if (!items || items.length === 0) {
            var empty = document.createElement("div");
            empty.className = "empty-state";
            empty.textContent = "В проекте не найдено подходящих элементов медиа.";
            el.itemsList.appendChild(empty);
            return;
        }

        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var card = document.createElement("div");
            card.className = "media-item-card";

            var top = document.createElement("div");
            top.className = "item-top";

            var nameSpan = document.createElement("span");
            nameSpan.className = "item-name";
            nameSpan.textContent = item.name || "Элемент";
            nameSpan.title = item.name || "";
            top.appendChild(nameSpan);

            if (item.hasProxy) {
                var proxyBadge = document.createElement("span");
                proxyBadge.className = "proxy-badge";
                proxyBadge.textContent = "PROXY";
                proxyBadge.title = item.proxyPath || "Привязан proxy";
                top.appendChild(proxyBadge);
            }

            var classBadge = document.createElement("span");
            classBadge.className = "class-badge " + (item.classification || "clip");
            classBadge.textContent = (item.classification || "clip").toUpperCase();
            top.appendChild(classBadge);

            card.appendChild(top);

            var meta = document.createElement("div");
            meta.className = "item-meta";

            if (item.binPath) {
                var binSpan = document.createElement("span");
                binSpan.className = "item-bin";
                binSpan.textContent = "Папка: " + item.binPath;
                meta.appendChild(binSpan);
            }

            if (item.path) {
                var pathSpan = document.createElement("span");
                pathSpan.className = "item-path";
                pathSpan.textContent = item.path;
                pathSpan.title = item.path;
                meta.appendChild(pathSpan);
            }

            card.appendChild(meta);
            el.itemsList.appendChild(card);
        }
    }

    function triggerAudit(onComplete) {
        if (state.scanning) return;
        state.scanning = true;
        if (el.btnScan) el.btnScan.disabled = true;
        if (el.scanIndicator) el.scanIndicator.hidden = false;

        if (typeof PardPremiereAdapter === "undefined" || !PardPremiereAdapter.auditMedia) {
            state.scanning = false;
            if (el.btnScan) el.btnScan.disabled = false;
            if (el.scanIndicator) el.scanIndicator.hidden = true;
            return;
        }

        PardPremiereAdapter.auditMedia(null, {}, function (err, report) {
            state.scanning = false;
            if (el.btnScan) el.btnScan.disabled = false;
            if (el.scanIndicator) el.scanIndicator.hidden = true;

            if (err) {
                log("Ошибка аудита: " + err.message, "bad");
                render({ ok: false, error: err.message });
            } else {
                state.lastReport = report;
                render(report);
                log("Аудит обновлён: " + (report.items ? report.items.length : 0) + " элементов.", "neutral");
            }
            if (onComplete) onComplete(err, report);
        });
    }

    /* ------------------------------------------------ Protection (Copy & Relink) */

    function protectExternalMedia() {
        var rep = state.lastReport;
        if (!rep || !rep.ok || !rep.projectSaved || !rep.workspace) {
            log("Защита невозможна: проект не сохранён.", "bad");
            return;
        }

        var ws = rep.workspace;
        var normWs = PardPremiereAdapter.normalizePath(ws);

        var externalTasks = [];
        var items = rep.items || [];

        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.classification === "clip" && it.path && !it.missing) {
                var pNorm = PardPremiereAdapter.normalizePath(it.path);
                if (pNorm.indexOf(normWs + "/") !== 0) {
                    var fName = pNorm.substring(pNorm.lastIndexOf("/") + 1);
                    var dest = normWs + "/01_assets/_SHARED/VIDEO/" + fName;
                    externalTasks.push({
                        id: it.id,
                        item: it,
                        sourcePath: it.path,
                        destPath: dest,
                        branch: "_SHARED",
                        category: "video",
                        allowReuse: true
                    });
                }
            }
        }

        if (externalTasks.length === 0) {
            log("Все медиафайлы уже находятся внутри рабочей папки проекта.", "good");
            return;
        }

        log("Начало защиты " + externalTasks.length + " внешних файлов…", "work");
        el.btnProtect.disabled = true;
        el.scanIndicator.hidden = false;

        PardPremiereCopyEngine.runQueue(ws, externalTasks, {}, {
            onTask: function (t, cur, total) {
                log("Копирование (" + cur + "/" + total + "): " + t.sourcePath, "work");
            },
            onDone: function (res) {
                el.btnProtect.disabled = false;
                el.scanIndicator.hidden = true;

                var copied = 0;
                var relinked = 0;

                // Create item lookup map from current project
                var proj = typeof premierepro !== "undefined" ? premierepro.Project.getActiveProject() : null;
                var pMap = buildProjectMap(proj);

                for (var r = 0; r < res.results.length; r++) {
                    var taskRes = res.results[r];
                    if (taskRes.ok) {
                        copied++;
                        var clipItem = pMap[taskRes.id];
                        if (clipItem) {
                            var rel = PardPremiereCopyEngine.relinkClip(clipItem, taskRes.destPath);
                            if (rel.ok) relinked++;
                            else log("Ошибка перелинковки клипа #" + taskRes.id + ": " + rel.reason, "bad");
                        }
                    } else {
                        log("Ошибка копирования #" + taskRes.id + ": " + taskRes.error, "bad");
                    }
                }

                log("Защита завершена: скопировано " + copied + ", перелинковано " + relinked + ".", "good");
                triggerAudit();
            }
        });
    }

    function buildProjectMap(project) {
        var map = {};
        if (!project || !project.getRootItem) return map;
        function walk(node) {
            if (!node) return;
            var id = String(node.nodeId || node.guid || node.treePath || "");
            if (id) map[id] = node;
            var children = node.children || (typeof node.getItems === "function" ? node.getItems() : []);
            for (var c = 0; c < children.length; c++) walk(children[c]);
        }
        walk(project.getRootItem());
        return map;
    }

    /* ------------------------------------------------ Duplicates */

    function scanDuplicates() {
        var rep = state.lastReport;
        if (!rep || !rep.ok || !rep.projectSaved) {
            log("Поиск дубликатов невозможен: сохраните проект.", "bad");
            return;
        }

        el.btnScanDuplicates.disabled = true;
        el.duplicatesProgressBox.hidden = false;
        el.duplicatesProgressFill.style.width = "0%";
        el.duplicatesProgressStats.textContent = "Сканирование файлов…";
        log("Поиск точных дубликатов…", "work");

        PardPremiereDuplicates.scanDuplicates(rep.workspace, rep.items, PardPremiereCopyEngine, {
            onProgress: function (p) {
                el.duplicatesProgressFill.style.width = (p.percent || 0) + "%";
                el.duplicatesProgressStats.textContent = "Проверено " + p.scannedFiles + " из " + p.totalFiles + " файлов (" + p.percent + "%)";
            },
            onDone: function (res) {
                el.btnScanDuplicates.disabled = false;
                el.duplicatesProgressBox.hidden = true;
                state.duplicatesResult = res;

                var groups = res.duplicateGroups || [];
                if (el.badgeDuplicates) {
                    el.badgeDuplicates.textContent = groups.length;
                    el.badgeDuplicates.hidden = (groups.length === 0);
                }

                log("Поиск завершён: найдено " + groups.length + " групп дубликатов.", groups.length > 0 ? "work" : "good");
                renderDuplicates(res);
            }
        });
    }

    function renderDuplicates(res) {
        if (!el.duplicatesList) return;
        el.duplicatesList.innerHTML = "";

        var groups = (res && res.duplicateGroups) || [];
        if (groups.length === 0) {
            el.duplicatesSummary.hidden = false;
            el.duplicatesSummary.textContent = "Точных дубликатов в проекте не обнаружено.";
            return;
        }

        el.duplicatesSummary.hidden = false;
        el.duplicatesSummary.textContent = "Найдено групп дубликатов: " + groups.length + " · Освободится: " + formatBytes(res.reclaimableBytes);

        for (var i = 0; i < groups.length; i++) {
            el.duplicatesList.appendChild(renderDuplicateGroupCard(groups[i]));
        }
    }

    function renderDuplicateGroupCard(group) {
        var card = document.createElement("div");
        card.className = "duplicate-group";

        var head = document.createElement("div");
        head.className = "duplicate-group-head";

        var title = document.createElement("span");
        title.className = "duplicate-group-title";
        title.textContent = "Копия · " + formatBytes(group.size);
        head.appendChild(title);

        var reclaim = document.createElement("span");
        reclaim.className = "duplicate-group-reclaim";
        reclaim.textContent = "+" + formatBytes(group.reclaimableBytes);
        head.appendChild(reclaim);

        card.appendChild(head);

        var rec = document.createElement("div");
        rec.className = "duplicate-group-rec";
        rec.textContent = "Рекомендация: " + (group.reasons || []).join("; ");
        card.appendChild(rec);

        var effectiveCanonical = state.canonicalOverrides[group.contentId] || group.recommendedCanonical;

        for (var f = 0; f < group.files.length; f++) {
            var file = group.files[f];
            var isCan = (PardPremiereAdapter.normalizePath(file.path) === PardPremiereAdapter.normalizePath(effectiveCanonical));

            var row = document.createElement("div");
            row.className = "duplicate-file-row" + (isCan ? " is-canonical" : "");

            var top = document.createElement("div");
            top.className = "duplicate-file-top";

            var radio = document.createElement("input");
            radio.type = "radio";
            radio.name = "canonical-" + group.groupId;
            radio.checked = isCan;
            (function (cId, fPath) {
                radio.onchange = function () {
                    state.canonicalOverrides[cId] = fPath;
                    renderDuplicates(state.duplicatesResult);
                };
            })(group.contentId, file.path);
            top.appendChild(radio);

            if (isCan) {
                var canBadge = document.createElement("span");
                canBadge.className = "canonical-badge";
                canBadge.textContent = "КАНОНИКАЛ";
                top.appendChild(canBadge);
            }

            var pSpan = document.createElement("span");
            pSpan.className = "duplicate-file-path";
            pSpan.textContent = file.path;
            pSpan.title = file.path;
            top.appendChild(pSpan);

            row.appendChild(top);
            card.appendChild(row);
        }

        // Consolidation Action Button (Two-click confirmation)
        if (group.files.length > 1) {
            var actBox = document.createElement("div");
            actBox.className = "duplicate-group-actions";

            var btnCons = document.createElement("button");
            btnCons.className = "btn";

            var isArm = (state.consolidationArmedGroup === group.groupId && Date.now() < state.consolidationArmedUntil);
            if (isArm) {
                btnCons.className = "btn btn-warn";
                btnCons.textContent = "ПОДТВЕРДИТЬ ОБЪЕДИНЕНИЕ (оригиналы не удаляются)";
                btnCons.onclick = function () {
                    executeConsolidation(group, effectiveCanonical);
                };
            } else {
                btnCons.textContent = "ОБЪЕДИНИТЬ В ОДИН ФАЙЛ";
                btnCons.onclick = function () {
                    state.consolidationArmedGroup = group.groupId;
                    state.consolidationArmedUntil = Date.now() + 6000;
                    renderDuplicates(state.duplicatesResult);
                    setTimeout(function () {
                        if (state.consolidationArmedGroup === group.groupId) {
                            state.consolidationArmedGroup = null;
                            state.consolidationArmedUntil = 0;
                            renderDuplicates(state.duplicatesResult);
                        }
                    }, 6050);
                };
            }

            actBox.appendChild(btnCons);
            card.appendChild(actBox);
        }

        return card;
    }

    function executeConsolidation(group, canonicalPath) {
        var rep = state.lastReport;
        if (!rep || !rep.ok || !rep.workspace) return;

        state.consolidationArmedGroup = null;
        state.consolidationArmedUntil = 0;
        log("Объединение дубликатов в каноникал " + canonicalPath + "…", "work");

        var proj = typeof premierepro !== "undefined" ? premierepro.Project.getActiveProject() : null;
        var pMap = buildProjectMap(proj);

        PardPremiereDuplicates.consolidateGroup(rep.workspace, group, canonicalPath, pMap, PardPremiereCopyEngine, {
            onDone: function (res) {
                if (res.ok) {
                    log("Дубликаты успешно объединены: перелинковано " + res.relinked + " ссылок. Оригиналы сохранены.", "good");
                } else if (res.partial) {
                    log("Частичное объединение: перелинковано " + res.relinked + ", пропущено " + res.skipped + ", ошибок " + res.failures.length, "bad");
                } else {
                    log("Ошибка объединения: " + (res.message || "Сбой перелинковки"), "bad");
                }
                scanDuplicates();
                triggerAudit();
            }
        });
    }

    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return "0 Б";
        var k = 1024;
        var sizes = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
        var i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
    }

    /* ------------------------------------------------ Boot & Event Wiring */

    function init() {
        if (el.tabs) {
            el.tabs.onclick = function (e) {
                var target = e.target;
                while (target && target !== el.tabs) {
                    if (target.getAttribute && target.getAttribute("data-tab")) {
                        showTab(target.getAttribute("data-tab"));
                        break;
                    }
                    target = target.parentNode;
                }
            };
        }

        if (el.btnScan) {
            el.btnScan.onclick = function () { triggerAudit(); };
        }

        if (el.btnProtect) {
            el.btnProtect.onclick = function () { protectExternalMedia(); };
        }

        if (el.btnScanDuplicates) {
            el.btnScanDuplicates.onclick = function () { scanDuplicates(); };
        }

        log("PardDefender UXP загружен.", "neutral");
        triggerAudit();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
