/*
 * PardDefender - Premiere Pro UXP Plugin Main Controller
 *
 * @map role: UI-контроллер панели Premiere Pro UXP: вкладки «ЗАЩИТА», «ДУБЛИКАТЫ» и «ЖУРНАЛ»,
 *           копирование внешних медиа в workspace с перелинковкой, поиск дубликатов,
 *           поиск по всей библиотеке, объединение с приоритетом AE и журнал операций.
 * @map status: ready
 *
 * Strictly enforces zero deletions of original files and no removal of project items.
 */
(function () {
    "use strict";

    var fs = null;
    var path = null;
    try { fs = require("fs"); } catch (e) {}
    try { path = require("path"); } catch (e) {}

    var el = {
        version: document.getElementById("version"),
        projTitle: document.getElementById("proj-title"),
        projStatus: document.getElementById("proj-status"),
        projWorkspace: document.getElementById("proj-workspace"),
        projGuid: document.getElementById("proj-guid"),
        btnScan: document.getElementById("btn-scan"),
        btnPauseUi: document.getElementById("btn-pause-ui"),
        btnProtect: document.getElementById("btn-protect"),
        btnSortUnused: document.getElementById("btn-sort-unused"),
        btnRelinkAe: document.getElementById("btn-relink-ae"),
        scanIndicator: document.getElementById("scan-indicator"),
        bannerAeDetected: document.getElementById("banner-ae-detected"),
        bannerProtectStatus: document.getElementById("banner-protect-status"),
        statClips: document.getElementById("stat-clips"),
        statSeqs: document.getElementById("stat-seqs"),
        statOffline: document.getElementById("stat-offline"),
        statGen: document.getElementById("stat-gen"),
        bannerNoProject: document.getElementById("banner-no-project"),
        bannerUnsaved: document.getElementById("banner-unsaved"),
        itemsCount: document.getElementById("items-count"),
        itemsList: document.getElementById("items-list"),
        itemsFilter: document.getElementById("items-filter"),
        itemsGroup: document.getElementById("items-group"),
        itemsVisible: document.getElementById("items-visible"),

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
        logBox: document.getElementById("log-box"),
        btnClearLog: document.getElementById("btn-clear-log")
    };

    var state = {
        scanning: false,
        protecting: false,
        userPaused: false,
        lastReport: null,
        itemsFilter: "all",
        itemsGroup: "none",
        lastDiagnosticsKey: "",
        activeTab: "protect",
        duplicatesResult: null,
        duplicateReport: null,
        duplicateScanning: false,
        consolidating: false,
        canonicalOverrides: {},
        protectionLinks: {},
        consolidationArmedGroup: null,
        consolidationArmedUntil: 0
    };

    function showProtectBanner(text, kind) {
        if (!el.bannerProtectStatus) return;
        if (!text) {
            el.bannerProtectStatus.hidden = true;
            return;
        }
        el.bannerProtectStatus.hidden = false;
        var cls = "alert-banner " + (kind === "good" ? "alert-good" : (kind === "bad" ? "alert-bad" : (kind === "warn" ? "alert-warn" : "alert-info")));
        el.bannerProtectStatus.className = cls;
        el.bannerProtectStatus.textContent = text;
    }

    function audioRoleKey(item, report) {
        return "pard.audioRole:" + report.workspace + ":" + report.projectId + ":" + item.path;
    }

    function protectionRoute(item, report) {
        if (PardPremiereCopyEngine.isAudio(item)) {
            try { item.audioRole = localStorage.getItem(audioRoleKey(item, report)) || item.audioRole; } catch (ignore) {}
        }
        return PardPremiereCopyEngine.resolveDestination(item, report.workspace,
            PardPremiereCopyEngine.loadWorkspaceMeta(report.workspace));
    }

    function needsProtection(item, report) {
        if (!PardPremiereCopyEngine.isInProjectMediaFolder(item.path, report.workspace)) return true;
        if (!PardPremiereCopyEngine.isAudio(item)) return !!(item.crossHost && item.crossHost.canRelink);
        var route = protectionRoute(item, report);
        // Unclassified internal audio stays put until the owner selects its role.
        return !route.needsAudioRole &&
            PardPremiereAdapter.normalizePath(item.path).toLowerCase() !== route.destPath.toLowerCase();
    }

    function log(msg, kind) {
        try { console.log("[PardDefender " + (kind || "info") + "]", msg); } catch (eLog) {}
        if (el.logBox) {
            var line = document.createElement("div");
            line.className = "log-line " + (kind || "neutral");
            var time = new Date().toTimeString().split(" ")[0];
            line.textContent = "[" + time + "] " + msg;
            el.logBox.appendChild(line);
            // Bound the visible journal without discarding the on-disk session log.
            while (el.logBox.children.length > 300) el.logBox.removeChild(el.logBox.firstChild);
            el.logBox.scrollTop = el.logBox.scrollHeight;
        }
        try {
            var ws = state.lastReport && state.lastReport.workspace;
            if (ws && fs && typeof fs.writeFileSync === "function") {
                var sessLog = ws.replace(/\\/g, "/") + "/.parddefender/session.log";
                var timeIso = new Date().toISOString();
                fs.writeFileSync(sessLog, "[" + timeIso + "] [" + (kind || "info") + "] " + msg + "\n", { encoding: "utf-8", flag: "a" });
            }
        } catch (eFsLog) {}
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
        if (state.userPaused) {
            el.projStatus.textContent = "ПАУЗА";
            el.projStatus.className = "status-badge paused";
        } else {
            el.projStatus.textContent = "СОХРАНЁН";
            el.projStatus.className = "status-badge saved";
        }
        el.projWorkspace.textContent = report.workspace || "—";
        el.projWorkspace.title = report.workspace || "";
        el.projGuid.textContent = report.projectId || "—";
        if (el.btnProtect) el.btnProtect.disabled = false;

        updateStats(report.stats || {});
        renderItems(report.items || []);

        var relinkableAeCount = 0;
        var externalCount = 0;
        var repItems = report.items || [];
        var normWs = report.workspace ? PardPremiereAdapter.normalizePath(report.workspace) : "";
        for (var k = 0; k < repItems.length; k++) {
            var it = repItems[k];
            if (it.crossHost && it.crossHost.canRelink && it.crossHost.canonicalPath) {
                if (it.usedOnTimeline === true) {
                    relinkableAeCount++;
                }
            }
            if (it.classification === "clip" && it.path && !it.missing && it.usedOnTimeline === true) {
                var pNorm = PardPremiereAdapter.normalizePath(it.path);
                var isInternal = typeof PardPremiereCopyEngine !== "undefined" && PardPremiereCopyEngine.isInProjectMediaFolder
                    ? PardPremiereCopyEngine.isInProjectMediaFolder(pNorm, normWs)
                    : (pNorm.indexOf(normWs + "/") === 0);
                if (needsProtection(it, report)) {
                    externalCount++;
                }
            }
        }

        var unusedCount = 0;
        for (var uc = 0; uc < repItems.length; uc++) {
            var uIt = repItems[uc];
            if (uIt.classification === "clip" && uIt.path && !uIt.missing && uIt.usedOnTimeline === false) {
                unusedCount++;
            }
        }

        if (el.btnProtect) {
            el.btnProtect.disabled = (externalCount === 0);
            if (externalCount > 0) {
                el.btnProtect.textContent = "ЗАЩИТИТЬ ВНЕШНИЕ (" + externalCount + ")";
            } else {
                el.btnProtect.textContent = "ЗАЩИТИТЬ ВНЕШНИЕ";
            }
        }

        if (el.btnSortUnused) {
            el.btnSortUnused.disabled = (unusedCount === 0);
            if (unusedCount > 0) {
                el.btnSortUnused.textContent = "📁 В ПАПКУ UNUSED (" + unusedCount + ")";
            } else {
                el.btnSortUnused.textContent = "📁 В ПАПКУ UNUSED";
            }
        }

        if (el.btnRelinkAe) {
            if (relinkableAeCount > 0) {
                el.btnRelinkAe.hidden = false;
                el.btnRelinkAe.textContent = "ПЕРЕЛИНКОВАТЬ НА МЕДИА AE (" + relinkableAeCount + ")";
            } else {
                el.btnRelinkAe.hidden = true;
            }
        }
        if (el.bannerAeDetected) {
            if (relinkableAeCount > 0) {
                el.bannerAeDetected.hidden = false;
                el.bannerAeDetected.textContent = "Обнаружено файлов под защитой After Effects: " + relinkableAeCount + ". Нажмите «ПЕРЕЛИНКОВАТЬ НА МЕДИА AE», чтобы подключить их без повторного копирования.";
            } else {
                el.bannerAeDetected.hidden = true;
            }
        }

        if (Array.isArray(report.diagnostics) && report.diagnostics.length > 0) {
            var diagnosticsKey = report.projectId + ":" + JSON.stringify(report.diagnostics);
            if (diagnosticsKey !== state.lastDiagnosticsKey) {
                state.lastDiagnosticsKey = diagnosticsKey;
                for (var d = 0; d < report.diagnostics.length; d++) {
                    log(report.diagnostics[d], "neutral");
                }
            }
        }

        publishMediaSnapshot(report);
    }

    function publishMediaSnapshot(report) {
        if (!report || !report.workspace || !report.projectId) return;
        var coord = (typeof PardSyncCoordinator !== "undefined") ? PardSyncCoordinator : null;
        if (!coord) {
            try { coord = require("./sync-coordinator.js"); } catch (eC) {}
        }
        if (!coord || typeof coord.publishSnapshot !== "function") return;

        var rawItems = report.items || [];
        var previous = coord.loadSnapshot ? coord.loadSnapshot(report.workspace, report.projectId) : null;
        var previousById = {};
        ((previous && previous.items) || []).forEach(function (it) { previousById[it.id] = it; });
        var snapItems = [];
        for (var si = 0; si < rawItems.length; si++) {
            var sIt = rawItems[si];
            var canonicalP = sIt.path;
            if (canonicalP) {
                var link = state.protectionLinks[report.projectId + ":" + sIt.id] || previousById[sIt.id];
                var sameLink = link && link.path === canonicalP;
                snapItems.push({
                    id: sIt.id,
                    key: sIt.key || ("p" + sIt.id),
                    name: sIt.name || "",
                    path: canonicalP,
                    oldPath: sameLink ? link.oldPath : sIt.oldPath,
                    contentId: sameLink ? (link.contentId || "") : (sIt.contentId || ""),
                    size: sIt.size || 0,
                    classification: sIt.classification || "clip",
                    forAfterEffects: true,
                    protected: PardPremiereCopyEngine.isInProjectMediaFolder(canonicalP, report.workspace)
                });
            }
        }

        try {
            return Promise.resolve(coord.publishSnapshot(report.workspace, {
                projectId: report.projectId,
                host: "premiere",
                projectName: report.projectName || "PremierePro",
                projectPath: report.projectPath || "",
                items: snapItems
            })).then(function (saved) {
                if (saved === false) throw new Error("Запись снимка отклонена");
            }).catch(function (error) {
                log("Не удалось сохранить данные синхронизации с AE: " + error.message, "bad");
            });
        } catch (eSnap) {
            log("Не удалось сохранить данные синхронизации с AE: " + eSnap.message, "bad");
        }
    }

    function updateStats(stats) {
        var s = stats || {};
        if (el.statClips) el.statClips.textContent = String(typeof s.clips === "number" ? s.clips : (parseInt(s.clips, 10) || 0));
        if (el.statSeqs) el.statSeqs.textContent = String(typeof s.sequences === "number" ? s.sequences : (parseInt(s.sequences, 10) || 0));
        if (el.statOffline) el.statOffline.textContent = String(typeof s.offline === "number" ? s.offline : (parseInt(s.offline, 10) || 0));
        if (el.statGen) el.statGen.textContent = String(typeof s.generated === "number" ? s.generated : (parseInt(s.generated, 10) || 0));
        if (el.itemsCount) el.itemsCount.textContent = String(typeof s.totalItems === "number" ? s.totalItems : (parseInt(s.totalItems, 10) || 0));
    }

    var MEDIA_LABELS = { video: "Видео", image: "Изображения", audio: "Аудио",
        sequence: "Секвенции", other: "Другие" };

    function mediaFormat(item) {
        if (item.classification === "sequence") return "";
        var match = /\.([^./\\]+)$/.exec(item.path || item.name || "");
        return match ? match[1].toLowerCase() : "";
    }

    function mediaType(item) {
        if (item.classification === "sequence") return "sequence";
        if (PardPremiereCopyEngine.isAudio(item)) return "audio";
        var ext = mediaFormat(item);
        if (/^(mp4|mov|avi|mxf|mkv|webm|m4v|mpg|mpeg|mpe|mts|m2ts|r3d|braw|wmv|dv|m2v|qt|ari|arri)$/.test(ext)) return "video";
        if (/^(png|jpe?g|tiff?|exr|dpx|gif|bmp|webp|psd|psb|ai|svg|eps|tga|cin|hdr|heic|heif|avif)$/.test(ext)) return "image";
        return "other";
    }

    function mediaGroup(item) {
        if (state.itemsGroup === "type") return MEDIA_LABELS[mediaType(item)];
        if (state.itemsGroup === "format") return mediaFormat(item).toUpperCase() || MEDIA_LABELS[mediaType(item)];
        if (state.itemsGroup === "bin") return item.binPath || "Корень проекта";
        return "";
    }

    function renderItems(items) {
        var all = items || [];
        // Never sort or filter report.items: protection and snapshots need ALL media.
        items = all.filter(function (item) { return state.itemsFilter === "all" || mediaType(item) === state.itemsFilter; });
        el.itemsVisible.textContent = items.length + " / " + all.length;
        if (state.itemsGroup !== "none") {
            items = items.map(function (item, index) { return { item: item, index: index }; });
            items.sort(function (a, b) {
                var left = state.itemsGroup === "name" ? a.item.name : mediaGroup(a.item);
                var right = state.itemsGroup === "name" ? b.item.name : mediaGroup(b.item);
                return String(left || "").localeCompare(String(right || "")) || a.index - b.index;
            });
            items = items.map(function (entry) { return entry.item; });
        }
        var scroll = el.itemsList.scrollTop || 0;
        el.itemsList.innerHTML = "";
        if (!items || items.length === 0) {
            var empty = document.createElement("div");
            empty.className = "empty-state";
            empty.textContent = all.length ? "Нет элементов этого типа. Выберите «Все типы»." : "В проекте не найдено подходящих элементов медиа.";
            el.itemsList.appendChild(empty);
            return;
        }

        var previousGroup = null;
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var group = mediaGroup(item);
            if (group && group !== previousGroup) {
                var groupTitle = document.createElement("div");
                groupTitle.className = "media-group-heading";
                groupTitle.textContent = group;
                el.itemsList.appendChild(groupTitle);
            }
            previousGroup = group;
            var card = document.createElement("div");
            card.className = "media-item-card media-" + mediaType(item) + (item.binPath ? " in-bin" : "");
            card.title = "Открыть в мониторе «Источник»" + (item.binPath ? " — " + item.binPath : "");

            (function (it) {
                card.addEventListener("click", async function (event) {
                    if (event && event.target && /^(SELECT|OPTION|BUTTON)$/i.test(event.target.tagName || "")) return;
                    if (typeof PardPremiereAdapter === "undefined" || !PardPremiereAdapter.revealItem) return;
                    var result = await PardPremiereAdapter.revealItem(it._projectItem || it._nativeItem);
                    var location = it.binPath ? " • Папка проекта: " + it.binPath : "";
                    if (result && result.ok) {
                        log("Открыт в «Источнике»: " + (it.name || "Элемент") + location, "good");
                    } else {
                        var message = result && result.reason || "Не удалось открыть элемент. Повторите сканирование.";
                        log(message, "warn");
                        showProtectBanner(message, "warn");
                    }
                });
            })(item);

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
            var typeBadge = document.createElement("span");
            typeBadge.className = "media-type-label";
            typeBadge.textContent = MEDIA_LABELS[mediaType(item)];
            top.appendChild(typeBadge);

            if (item.crossHost) {
                if (item.crossHost.canRelink && item.crossHost.isAeProtected) {
                    var aeBadge = document.createElement("span");
                    aeBadge.className = "status-badge-loc ae-protected";
                    aeBadge.textContent = "AE защита";
                    aeBadge.title = "Файл уже защищён в After Effects: " + (item.crossHost.canonicalPath || "");
                    top.appendChild(aeBadge);
                } else if (item.crossHost.sharedInProject && item.crossHost.isAeProtected) {
                    var sharedBadge = document.createElement("span");
                    sharedBadge.className = "status-badge-loc ae-protected";
                    sharedBadge.textContent = "AE защита";
                    sharedBadge.title = "Файл общий с After Effects и уже находится в проекте: " + (item.crossHost.canonicalPath || "");
                    top.appendChild(sharedBadge);
                } else if (item.crossHost.isAeProtected) {
                    var aeBadge2 = document.createElement("span");
                    aeBadge2.className = "status-badge-loc ae-protected";
                    aeBadge2.textContent = "AE защита";
                    aeBadge2.title = "Файл уже защищён в After Effects: " + (item.crossHost.canonicalPath || "");
                    top.appendChild(aeBadge2);
                }
            }

            if (item.path && state.lastReport && state.lastReport.workspace) {
                if (PardPremiereCopyEngine.isAudio(item)) {
                    var roleSelect = document.createElement("select");
                    roleSelect.title = "Тип звука: влияет на папку защиты. Авто — по папке Premiere и имени.";
                    [["", "Тип звука: авто"], ["voice", "Голос / диктор"], ["music", "Музыка"], ["sfx", "Звуки / SFX"]].forEach(function (pair) {
                        var option = document.createElement("option");
                        option.value = pair[0]; option.textContent = pair[1]; roleSelect.appendChild(option);
                    });
                    (function (it, select, report) {
                        try { select.value = localStorage.getItem(audioRoleKey(it, report)) || ""; } catch (ignore) {}
                        select.addEventListener("click", function (event) { event.stopPropagation(); });
                        select.addEventListener("change", function () {
                            if (state.protecting) return;
                            try { localStorage.setItem(audioRoleKey(it, report), select.value); }
                            catch (e) { log("Не удалось сохранить тип звука: " + e.message, "warn"); }
                            it.audioRole = select.value;
                            render(report);
                        });
                    })(item, roleSelect, state.lastReport);
                    roleSelect.disabled = state.protecting;
                    top.appendChild(roleSelect);
                }
                var locBadge = document.createElement("span");
                var inProj = (typeof PardPremiereCopyEngine !== "undefined" && PardPremiereCopyEngine.isInProjectMediaFolder)
                    ? PardPremiereCopyEngine.isInProjectMediaFolder(PardPremiereAdapter.normalizePath(item.path), PardPremiereAdapter.normalizePath(state.lastReport.workspace))
                    : (PardPremiereAdapter.normalizePath(item.path).indexOf(PardPremiereAdapter.normalizePath(state.lastReport.workspace) + "/") === 0);
                locBadge.className = "status-badge-loc " + (inProj ? "internal" : "external");
                locBadge.textContent = inProj ? "В ПРОЕКТЕ" : "ВНЕ ПРОЕКТА";
                top.appendChild(locBadge);
            }

            var tlBadge = document.createElement("span");
            tlBadge.className = "status-badge-loc " + (item.usedOnTimeline ? "timeline-used" : "timeline-unused");
            tlBadge.textContent = item.usedOnTimeline ? "НА ТАЙМЛАЙНЕ" : "ВНЕ ТАЙМЛАЙНА";
            tlBadge.title = item.usedOnTimeline ? "Медиафайл используется на таймлайне секвенции" : "Медиафайл находится только в проекте (не на таймлайне)";
            top.appendChild(tlBadge);

            if (item.crossHost && item.crossHost.canRelink && item.crossHost.canonicalPath) {
                var btnRelinkItem = document.createElement("button");
                btnRelinkItem.className = "btn-mini btn-relink-item";
                btnRelinkItem.textContent = "ПЕРЕЛИНКОВАТЬ НА AE";
                btnRelinkItem.title = "Перелинковать этот клип на защищённый файл After Effects:\n" + item.crossHost.canonicalPath;
                (function (it) {
                    btnRelinkItem.addEventListener("click", function (e) {
                        e.stopPropagation();
                        relinkSingleItemToAe(it);
                    });
                })(item);
                top.appendChild(btnRelinkItem);
            }

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
        el.itemsList.scrollTop = scroll;
    }

    function setScanButtonsState(disabled) {
        if (el.btnScan) el.btnScan.disabled = disabled;
    }

    var scanTimeout = null;

    function triggerAudit(onComplete, isSilent) {
        if (state.userPaused && isSilent) {
            if (onComplete) onComplete(null, state.lastReport);
            return;
        }
        if (state.scanning || state.protecting || state.consolidating || state.duplicateScanning) return;
        state.scanning = true;
        if (!isSilent) {
            setScanButtonsState(true);
            if (el.scanIndicator) el.scanIndicator.hidden = false;
            // Keep the last protection result visible across manual and automatic audits.
        }

        if (scanTimeout) clearTimeout(scanTimeout);
        scanTimeout = setTimeout(function () {
            if (state.scanning) {
                state.scanning = false;
                setScanButtonsState(false);
                if (el.scanIndicator) el.scanIndicator.hidden = true;
            }
        }, 15000);

        if (typeof PardPremiereAdapter === "undefined" || !PardPremiereAdapter.auditMedia) {
            if (scanTimeout) clearTimeout(scanTimeout);
            state.scanning = false;
            setScanButtonsState(false);
            if (el.scanIndicator) el.scanIndicator.hidden = true;
            return;
        }

        PardPremiereAdapter.auditMedia(null, { timelineOnly: true }, function (err, report) {
            if (scanTimeout) clearTimeout(scanTimeout);
            state.scanning = false;
            setScanButtonsState(false);
            if (el.scanIndicator) el.scanIndicator.hidden = true;

            if (err) {
                log("Ошибка аудита: " + err.message, "bad");
                render({ ok: false, error: err.message });
            } else {
                state.lastReport = report;
                render(report);
                if (!isSilent) {
                    var count = (report.items ? report.items.length : 0);
                    log("Сканирование проекта завершено: " + count + " элементов.", "neutral");
                }
            }
            if (onComplete) onComplete(err, report);
        });
    }

    /* ------------------------------------------------ Protection (Copy & Relink) */

    function protectExternalMedia() {
        if (state.duplicateScanning || state.consolidating) {
            log("Дождитесь завершения проверки или объединения дубликатов.", "warn");
            return;
        }
        if (state.protecting) {
            log("Защита уже выполняется в фоновом режиме.", "warn");
            return;
        }
        state.protecting = true;

        try {
            var rep = state.lastReport;
            if (!rep || !rep.ok) {
                state.protecting = false;
                showProtectBanner("Сканирование проекта перед защитой...", "info");
                triggerAudit(function (err, newRep) {
                    if (err || !newRep || !newRep.ok) {
                        showProtectBanner("Не удалось просканировать проект. Нажмите «СКАНИРОВАТЬ ПРОЕКТ».", "bad");
                        return;
                    }
                    protectExternalMedia();
                });
                return;
            }

            if (!rep.projectSaved || !rep.workspace) {
                state.protecting = false;
                var noSaveMsg = "Защита невозможна: проект не сохранён на диск.";
                log(noSaveMsg, "bad");
                showProtectBanner(noSaveMsg, "warn");
                return;
            }

            var ws = rep.workspace;
            var normWs = PardPremiereAdapter.normalizePath(ws);
            var wsMeta = typeof PardPremiereCopyEngine !== "undefined" && PardPremiereCopyEngine.loadWorkspaceMeta ? PardPremiereCopyEngine.loadWorkspaceMeta(ws) : null;

            var externalTasks = [];
            var items = rep.items || [];

            var seenSources = {};
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                // Only protect media that is actively used on the timeline!
                if (it.classification === "clip" && it.path && !it.missing && it.usedOnTimeline === true) {
                    var pNorm = PardPremiereAdapter.normalizePath(it.path);
                    var isInternal = typeof PardPremiereCopyEngine !== "undefined" && PardPremiereCopyEngine.isInProjectMediaFolder
                        ? PardPremiereCopyEngine.isInProjectMediaFolder(pNorm, normWs)
                        : (pNorm.indexOf(normWs + "/") === 0);

                    if (needsProtection(it, rep)) {
                        var dest = "";
                        var isAeCan = false;
                        var branch = "_SHARED";
                        var category = "video";

                        if (!PardPremiereCopyEngine.isAudio(it) && it.crossHost && it.crossHost.canonicalPath) {
                            dest = it.crossHost.canonicalPath;
                            isAeCan = true;
                        } else {
                            var routeInfo = typeof PardPremiereCopyEngine !== "undefined" && PardPremiereCopyEngine.resolveDestination
                                ? protectionRoute(it, rep)
                                : { destPath: normWs + "/01_assets/_SHARED/OTHER/" + pNorm.substring(pNorm.lastIndexOf("/") + 1), branch: "_SHARED", category: "other" };
                            dest = seenSources[pNorm] || routeInfo.destPath;
                            isAeCan = !!routeInfo.isAeCanonical;
                            branch = routeInfo.branch || "_SHARED";
                            category = routeInfo.category || "video";
                        }
                        seenSources[pNorm] = dest;

                        externalTasks.push({
                            id: it.id,
                            item: it,
                            sourcePath: it.path,
                            destPath: dest,
                            branch: branch,
                            category: category,
                            allowReuse: true,
                            isAeCanonical: isAeCan,
                            fallbackDestPath: isAeCan ? PardPremiereCopyEngine.resolveDestination(it, ws, {}).destPath : null
                        });
                    }
                }
            }

            if (externalTasks.length === 0) {
                state.protecting = false;
                var zeroMsg = "Все используемые на таймлайне файлы уже защищены в папке проекта.";
                log(zeroMsg, "good");
                showProtectBanner(zeroMsg, "good");
                if (el.btnProtect) {
                    el.btnProtect.disabled = true;
                    el.btnProtect.textContent = "ЗАЩИТИТЬ ВНЕШНИЕ";
                }
                return;
            }

            var startMsg = "Защита " + externalTasks.length + " внешних файлов на таймлайне...";
            log(startMsg, "work");
            showProtectBanner(startMsg, "info");
            if (el.btnProtect) {
                el.btnProtect.disabled = true;
                el.btnProtect.textContent = "ВЫПОЛНЯЕТСЯ...";
            }
            if (el.scanIndicator) el.scanIndicator.hidden = false;

            PardPremiereCopyEngine.runQueue(ws, externalTasks, {
                onProgress: function (progress) {
                    showProtectBanner((progress.phase || "Копирование") + ": " + progress.percent + "% (" +
                        Math.round(progress.bytesWritten / 1024 / 1024) + " МБ)", "info");
                }
            }, {
                onTask: function (t, cur, total) {
                    var fName = (t && t.sourcePath) ? t.sourcePath.substring(t.sourcePath.lastIndexOf("/") + 1) : "файл";
                    var taskMsg = "Копирование (" + cur + "/" + total + "): " + fName;
                    log("Копирование (" + cur + "/" + total + ")\nИсходник: " + t.sourcePath + "\nНазначение: " + t.destPath, "work");
                    showProtectBanner(taskMsg, "info");
                },
                onDone: async function (res) {
                    try {
                        if (!res || res.error) throw new Error(res ? res.error : "Нет результата копирования");
                        if (el.btnProtect) el.btnProtect.disabled = false;
                        if (el.scanIndicator) el.scanIndicator.hidden = true;

                        var copied = 0;
                        var reused = 0;
                        var relinked = 0;

                        // Create item lookup map from current project
                        var proj = await PardPremiereAdapter.resolveActiveProject();
                        var activeInfo = PardPremiereAdapter.identifyProject(proj);
                        if (activeInfo.projectId !== rep.projectId || activeInfo.projectPath !== rep.projectPath) {
                            throw new Error("Активный проект изменился. Копии сохранены, перелинковка отложена до повторного сканирования.");
                        }
                        var pMap = buildProjectMap(proj);

                        var relinkPromises = [];
                        var resultsList = (res && res.results) || [];
                        for (var r = 0; r < resultsList.length; r++) {
                            (function (taskRes) {
                                if (taskRes.ok) {
                                    if (taskRes.reused) reused++;
                                    else copied++;
                                    var clipItem = (taskRes.item && taskRes.item._nativeItem) || pMap[taskRes.id] || pMap[String(taskRes.id)];
                                    if (!clipItem && pMap && taskRes.sourcePath) {
                                        var sNorm = PardPremiereAdapter.normalizePath(taskRes.sourcePath);
                                        for (var k in pMap) {
                                            if (pMap.hasOwnProperty(k)) {
                                                var cand = pMap[k];
                                                var mPath = "";
                                                if (cand && typeof cand.getMediaFilePath === "function") {
                                                    try { mPath = cand.getMediaFilePath(); } catch (eMp) {}
                                                } else if (cand && cand.mediaFilePath) {
                                                    mPath = cand.mediaFilePath;
                                                }
                                                if (mPath && PardPremiereAdapter.normalizePath(mPath) === sNorm) {
                                                    clipItem = cand;
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                    if (clipItem) {
                                        var p = Promise.resolve(PardPremiereCopyEngine.relinkClip(clipItem, taskRes.destPath, taskRes.sourcePath)).then(function (rel) {
                                            if (rel && rel.ok) {
                                                relinked++;
                                                state.protectionLinks[rep.projectId + ":" + taskRes.id] = {
                                                    path: taskRes.destPath, oldPath: taskRes.sourcePath, contentId: taskRes.hash || ""
                                                };
                                                if (taskRes.item) {
                                                    taskRes.item.path = taskRes.destPath;
                                                    try { if (taskRes.item.audioRole) localStorage.setItem(audioRoleKey(taskRes.item, rep), taskRes.item.audioRole); } catch (ignore) {}
                                                }
                                            } else {
                                                taskRes.ok = false;
                                                taskRes.error = rel ? rel.reason : "Сбой перелинковки";
                                                log("Ошибка перелинковки клипа #" + taskRes.id + ": " + (rel ? rel.reason : "Сбой"), "bad");
                                            }
                                        }).catch(function (eRel) {
                                            taskRes.ok = false;
                                            taskRes.error = eRel.message;
                                            log("Исключение перелинковки клипа #" + taskRes.id + ": " + (eRel ? eRel.message : "Сбой"), "bad");
                                        });
                                        relinkPromises.push(p);
                                    } else {
                                        taskRes.ok = false;
                                        taskRes.error = "Элемент не найден для перелинковки";
                                        log("Элемент проекта #" + taskRes.id + " не найден для перелинковки.", "bad");
                                    }
                                } else {
                                    log("Ошибка копирования #" + taskRes.id + ": " + (taskRes.error || taskRes.code || "Сбой"), "bad");
                                }
                            })(resultsList[r]);
                        }

                        Promise.all(relinkPromises).then(async function () {
                            await publishMediaSnapshot(rep);
                            var failedCount = 0;
                            var firstErr = "";
                            for (var fi = 0; fi < resultsList.length; fi++) {
                                if (!resultsList[fi].ok) {
                                    failedCount++;
                                    if (!firstErr) {
                                        firstErr = resultsList[fi].error || resultsList[fi].code || "Не удалось скопировать файл";
                                    }
                                }
                            }

                            if (copied === 0 && reused === 0 && failedCount > 0) {
                                var failMsg = "Сбой защиты: " + (firstErr || "Не удалось скопировать файлы") + " (см. вкладку «ЖУРНАЛ»)";
                                log(failMsg, "bad");
                                showProtectBanner(failMsg, "bad");
                            } else if (failedCount > 0) {
                                var partMsg = "Защита завершена частично: " + (reused > 0 ? ("переиспользовано " + reused + ", ") : "") + (copied > 0 ? ("скопировано " + copied + ", ") : "") + "перелинковано " + relinked + ", ошибок: " + failedCount + " (см. «ЖУРНАЛ»).";
                                log(partMsg, "warn");
                                showProtectBanner(partMsg, "warn");
                            } else {
                                var msg = "Защита завершена: " + (reused > 0 ? ("переиспользовано " + reused + ", ") : "") + (copied > 0 ? ("скопировано " + copied + ", ") : "") + "перелинковано " + relinked + ".";
                                log(msg, "good");
                                showProtectBanner(msg, (copied > 0 || relinked > 0 || reused > 0) ? "good" : "warn");
                            }
                            if (relinked > 0) {
                                if (proj && typeof proj.save === "function") {
                                    try {
                                        var saved = await proj.save();
                                        if (saved === false) throw new Error("Premiere отклонил сохранение");
                                        log("Проект сохранён после перелинковки.", "good");
                                    } catch (eSave) {
                                        log("Копии созданы, но проект нужно сохранить вручную: " + eSave.message, "bad");
                                        showProtectBanner("Файлы защищены. Не удалось сохранить проект — сохраните его вручную.", "warn");
                                    }
                                } else if (typeof premierepro !== "undefined" && premierepro.Project && premierepro.Project.activeProject && typeof premierepro.Project.activeProject.save === "function") {
                                    try {
                                        premierepro.Project.activeProject.save();
                                        log("Проект успешно сохранён после перелинковки.", "good");
                                    } catch (eSave2) {}
                                }
                            }
                            state.protecting = false;
                            triggerAudit();
                        }).catch(function (eAll) {
                            state.protecting = false;
                            var allMsg = "Ошибка финализации защиты: " + (eAll ? eAll.message : "Сбой");
                            log(allMsg, "bad");
                            showProtectBanner(allMsg, "bad");
                            triggerAudit();
                        });
                    } catch (eDoneErr) {
                        state.protecting = false;
                        var dMsg = "Сбой обработки результатов защиты: " + (eDoneErr ? eDoneErr.message : "Ошибка");
                        log(dMsg, "bad");
                        showProtectBanner(dMsg, "bad");
                        if (el.btnProtect) el.btnProtect.disabled = false;
                        if (el.scanIndicator) el.scanIndicator.hidden = true;
                        triggerAudit();
                    }
                }
            });
        } catch (eTopProtect) {
            state.protecting = false;
            var topErrMsg = "Сбой запуска защиты: " + (eTopProtect ? eTopProtect.message : "Ошибка");
            log(topErrMsg, "bad");
            showProtectBanner(topErrMsg, "bad");
            if (el.btnProtect) el.btnProtect.disabled = false;
            if (el.scanIndicator) el.scanIndicator.hidden = true;
        }
    }

    function sortUnusedClips() {
        if (state.protecting || state.consolidating || state.duplicateScanning) {
            log("Защита или сортировка уже выполняется.", "warn");
            return;
        }

        var rep = state.lastReport;
        if (!rep || !rep.ok) {
            showProtectBanner("Сканирование проекта перед сортировкой...", "info");
            triggerAudit(function (err, newRep) {
                if (err || !newRep || !newRep.ok) {
                    showProtectBanner("Не удалось просканировать проект. Нажмите «СКАНИРОВАТЬ ПРОЕКТ».", "bad");
                    return;
                }
                sortUnusedClips();
            });
            return;
        }

        if (!rep.projectSaved || !rep.workspace) {
            var noSaveMsg = "Сортировка невозможна: проект не сохранён на диск.";
            log(noSaveMsg, "bad");
            showProtectBanner(noSaveMsg, "warn");
            return;
        }

        var ws = rep.workspace;
        var normWs = PardPremiereAdapter.normalizePath(ws);

        var unusedRoot = normWs + "/unused";
        if (fs) {
            try {
                var nativeUnusedRoot = unusedRoot.replace(/\//g, path ? path.sep : "\\");
                if (!fs.existsSync(nativeUnusedRoot)) {
                    fs.mkdirSync(nativeUnusedRoot, { recursive: true });
                }
            } catch (eDir) {}
        }

        var items = rep.items || [];
        var unusedCandidates = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.classification === "clip" && it.path && !it.missing && it.usedOnTimeline === false) {
                unusedCandidates.push(it);
            }
        }

        if (unusedCandidates.length === 0) {
            var zeroMsg = "Неиспользуемых клипов вне таймлайна не обнаружено.";
            log(zeroMsg, "good");
            showProtectBanner(zeroMsg, "good");
            return;
        }

        state.protecting = true;
        if (el.btnSortUnused) {
            el.btnSortUnused.disabled = true;
            el.btnSortUnused.textContent = "СОРТИРОВКА…";
        }
        if (el.scanIndicator) el.scanIndicator.hidden = false;

        var copyTasks = [];
        var internalMoves = [];
        var seenDest = {};

        for (var j = 0; j < unusedCandidates.length; j++) {
            var cIt = unusedCandidates[j];
            var route = typeof PardPremiereCopyEngine !== "undefined" && PardPremiereCopyEngine.resolveUnusedDestination
                ? PardPremiereCopyEngine.resolveUnusedDestination(cIt, normWs)
                : { destPath: normWs + "/unused/OTHER/" + (cIt.name || "file"), branch: "unused", category: "other" };

            var destPath = route.destPath;
            var normSrc = PardPremiereAdapter.normalizePath(cIt.path);
            var normDst = PardPremiereAdapter.normalizePath(destPath);

            var fName = normDst.substring(normDst.lastIndexOf("/") + 1);
            var dirName = normDst.substring(0, normDst.lastIndexOf("/"));
            var disambig = 2;
            var baseWithoutExt = fName.replace(/\.[^.]+$/, "");
            var ext = fName.indexOf(".") !== -1 ? fName.substring(fName.lastIndexOf(".")) : "";
            while (seenDest[normDst.toLowerCase()]) {
                fName = baseWithoutExt + " (" + disambig + ")" + ext;
                destPath = dirName + "/" + fName;
                normDst = PardPremiereAdapter.normalizePath(destPath);
                disambig++;
            }
            seenDest[normDst.toLowerCase()] = true;

            if (normSrc.toLowerCase() === normDst.toLowerCase()) {
                continue;
            }

            var isInternal = (normSrc.toLowerCase().indexOf(normWs.toLowerCase() + "/") === 0);

            if (isInternal) {
                internalMoves.push({
                    item: cIt,
                    sourcePath: normSrc,
                    destPath: normDst
                });
            } else {
                copyTasks.push({
                    id: cIt.id,
                    item: cIt,
                    sourcePath: cIt.path,
                    destPath: normDst,
                    branch: route.branch || "unused",
                    category: route.category || "other",
                    allowReuse: true
                });
            }
        }

        if (copyTasks.length === 0 && internalMoves.length === 0) {
            state.protecting = false;
            if (el.btnSortUnused) el.btnSortUnused.disabled = false;
            if (el.scanIndicator) el.scanIndicator.hidden = true;
            var allDoneMsg = "Все неиспользуемые клипы уже находятся в папке unused.";
            log(allDoneMsg, "good");
            showProtectBanner(allDoneMsg, "good");
            return;
        }

        var startMsg = "Сортировка " + (copyTasks.length + internalMoves.length) + " неиспользуемых клипов в папку /unused…";
        log(startMsg, "work");
        showProtectBanner(startMsg, "info");

        var proj = typeof PardPremiereAdapter !== "undefined" ? PardPremiereAdapter.resolveActiveProjectSync() : (typeof premierepro !== "undefined" ? (premierepro.Project.activeProject || (premierepro.Project.projects && premierepro.Project.projects[0])) : null);
        var pMap = buildProjectMap(proj);

        var internalRelinkPromises = [];
        var movedCount = 0;
        for (var m = 0; m < internalMoves.length; m++) {
            (function (moveOp) {
                var sPath = moveOp.sourcePath;
                var dPath = moveOp.destPath;
                var sNat = sPath.replace(/\//g, path ? path.sep : "\\");
                var dNat = dPath.replace(/\//g, path ? path.sep : "\\");
                var dDir = dNat.substring(0, dNat.lastIndexOf(path ? path.sep : "\\"));
                try {
                    if (fs && !fs.existsSync(dDir)) {
                        fs.mkdirSync(dDir, { recursive: true });
                    }
                } catch (eMk) {}

                var okMove = false;
                if (fs && fs.existsSync(sNat)) {
                    try {
                        var sStat = fs.statSync(sNat);
                        var canReuse = false;
                        if (fs.existsSync(dNat)) {
                            var dStat = fs.statSync(dNat);
                            if (dStat.size === sStat.size) canReuse = true;
                        }
                        if (canReuse) {
                            okMove = true;
                        } else {
                            var partFile = dNat + ".pdpart";
                            fs.copyFileSync(sNat, partFile);
                            var pStat = fs.statSync(partFile);
                            if (pStat.size === sStat.size) {
                                if (fs.existsSync(dNat)) fs.unlinkSync(dNat);
                                fs.renameSync(partFile, dNat);
                                try { fs.unlinkSync(sNat); } catch (eUnl) {}
                                okMove = true;
                            } else {
                                try { fs.unlinkSync(partFile); } catch (eCl) {}
                            }
                        }
                    } catch (eMvErr) {
                        log("Ошибка переноса в unused: " + sPath + " — " + eMvErr.message, "warn");
                    }
                }

                if (okMove) {
                    movedCount++;
                    var clipItem = (moveOp.item && moveOp.item._nativeItem) || pMap[moveOp.item.id] || pMap[String(moveOp.item.id)];
                    if (clipItem) {
                        var pRel = Promise.resolve(PardPremiereCopyEngine.relinkClip(clipItem, dPath)).catch(function (eRel) {
                            log("Ошибка перелинковки перемещённого клипа: " + (eRel ? eRel.message : "Сбой"), "warn");
                        });
                        internalRelinkPromises.push(pRel);
                    }
                }
            })(internalMoves[m]);
        }

        function afterInternalMoves() {
            if (copyTasks.length > 0) {
                PardPremiereCopyEngine.runQueue(ws, copyTasks, {}, {
                    onTask: function (t, cur, total) {
                        var fName = (t && t.sourcePath) ? t.sourcePath.substring(t.sourcePath.lastIndexOf("/") + 1) : "файл";
                        log("Копирование в unused (" + cur + "/" + total + "): " + fName, "work");
                    },
                    onDone: function (res) {
                        var resList = (res && res.results) || [];
                        var copyRelinkPromises = [];
                        for (var cr = 0; cr < resList.length; cr++) {
                            (function (cRes) {
                                if (cRes.ok && cRes.destPath) {
                                    var cItem = (cRes.item && cRes.item._nativeItem) || pMap[cRes.id] || pMap[String(cRes.id)];
                                    if (cItem) {
                                        var pCr = Promise.resolve(PardPremiereCopyEngine.relinkClip(cItem, cRes.destPath)).catch(function (eRel) {
                                            log("Ошибка перелинковки скопированного клипа: " + (eRel ? eRel.message : "Сбой"), "warn");
                                        });
                                        copyRelinkPromises.push(pCr);
                                    }
                                }
                            })(resList[cr]);
                        }
                        Promise.all(copyRelinkPromises).then(function () {
                            finishSort(movedCount + copyRelinkPromises.length);
                        });
                    }
                });
            } else {
                finishSort(movedCount);
            }
        }

        function finishSort(totalSorted) {
            state.protecting = false;
            if (proj && typeof proj.save === "function") {
                try {
                    proj.save();
                    log("Проект успешно сохранён после сортировки неиспользуемых.", "good");
                } catch (eSave) {}
            }
            if (el.btnSortUnused) el.btnSortUnused.disabled = false;
            if (el.scanIndicator) el.scanIndicator.hidden = true;
            var doneMsg = "Сортировка завершена: " + totalSorted + " неиспользуемых клипов перемещено в папку /unused.";
            log(doneMsg, "good");
            showProtectBanner(doneMsg, "good");
            triggerAudit();
        }

        Promise.all(internalRelinkPromises).then(afterInternalMoves);
    }

    function relinkSingleItemToAe(item) {
        if (state.duplicateScanning || state.consolidating) return;
        if (!item || !item.crossHost || !item.crossHost.canonicalPath) return;
        var proj = typeof PardPremiereAdapter !== "undefined" ? PardPremiereAdapter.resolveActiveProjectSync() : (typeof premierepro !== "undefined" ? (premierepro.Project.activeProject || (premierepro.Project.projects && premierepro.Project.projects[0])) : null);
        var pMap = buildProjectMap(proj);
        var clipItem = pMap[item.id] || (item._nativeItem && typeof item._nativeItem.relink === "function" ? item._nativeItem : null);
        if (!clipItem) {
            log("Элемент проекта #" + item.id + " не найден для перелинковки.", "bad");
            return;
        }

        Promise.resolve(PardPremiereCopyEngine.relinkVerifiedClip(clipItem, item.crossHost.canonicalPath, item.path)).then(function (rel) {
            if (rel && rel.ok) {
                log("Перелинкован на медиа AE: " + (item.name || "Клип") + " -> " + item.crossHost.canonicalPath, "good");
                if (state.lastReport && state.lastReport.workspace) {
                    try {
                        var ws = state.lastReport.workspace;
                        var tsvPath = PardPremiereCopyEngine.nativePath(PardPremiereCopyEngine.assetsFile(ws));
                        var fsMod = null;
                        try { fsMod = require("fs"); } catch (eF) {}
                        var fSize = 0;
                        if (fsMod) {
                            try { fSize = fsMod.statSync(PardPremiereCopyEngine.nativePath(item.crossHost.canonicalPath)).size; } catch (eS) {}
                        }
                        var row = [
                            new Date().toISOString(),
                            item.id || "1",
                            PardPremiereAdapter.normalizePath(item.path),
                            fSize || item.size || 0,
                            PardPremiereAdapter.normalizePath(item.crossHost.canonicalPath),
                            item.crossHost.branch || "_SHARED",
                            "video"
                        ].join("\t") + "\n";
                        if (fsMod) fsMod.appendFileSync(tsvPath, row, "utf8");
                    } catch (eTsv) {}
                }
                triggerAudit();
            } else {
                log("Ошибка перелинковки клипа #" + item.id + ": " + (rel ? (rel.reason || rel.message) : "Неизвестная ошибка"), "bad");
            }
        });
    }

    function relinkAllAeMedia() {
        if (state.duplicateScanning || state.consolidating) return;
        var rep = state.lastReport;
        if (!rep || !rep.items) return;
        var items = rep.items;
        var targets = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.crossHost && it.crossHost.canRelink && it.crossHost.canonicalPath) {
                // Only relink media that is actively used on the timeline!
                if (it.usedOnTimeline === true) {
                    targets.push(it);
                }
            }
        }
        if (targets.length === 0) {
            log("Нет элементов на таймлайне для перелинковки на AE.", "neutral");
            return;
        }

        log("Перелинковка " + targets.length + " клипов на медиа After Effects…", "work");
        var proj = typeof PardPremiereAdapter !== "undefined" ? PardPremiereAdapter.resolveActiveProjectSync() : (typeof premierepro !== "undefined" ? (premierepro.Project.activeProject || (premierepro.Project.projects && premierepro.Project.projects[0])) : null);
        var pMap = buildProjectMap(proj);

        var successCount = 0;
        var fsMod = null;
        try { fsMod = require("fs"); } catch (eF) {}
        var tsvPath = (rep.workspace && fsMod) ? PardPremiereCopyEngine.nativePath(PardPremiereCopyEngine.assetsFile(rep.workspace)) : null;

        var relinkPromises = [];
        for (var t = 0; t < targets.length; t++) {
            (function (itTarget) {
                var clipItem = pMap[itTarget.id] || (itTarget._nativeItem && typeof itTarget._nativeItem.relink === "function" ? itTarget._nativeItem : null);
                if (clipItem) {
                    var p = Promise.resolve(PardPremiereCopyEngine.relinkVerifiedClip(clipItem, itTarget.crossHost.canonicalPath, itTarget.path)).then(function (rel) {
                        if (rel && rel.ok) {
                            successCount++;
                            if (tsvPath) {
                                try {
                                    var fSize = 0;
                                    try { fSize = fsMod.statSync(PardPremiereCopyEngine.nativePath(itTarget.crossHost.canonicalPath)).size; } catch (eS2) {}
                                    var row = [
                                        new Date().toISOString(),
                                        itTarget.id || "1",
                                        PardPremiereAdapter.normalizePath(itTarget.path),
                                        fSize || itTarget.size || 0,
                                        PardPremiereAdapter.normalizePath(itTarget.crossHost.canonicalPath),
                                        itTarget.crossHost.branch || "_SHARED",
                                        "video"
                                    ].join("\t") + "\n";
                                    fsMod.appendFileSync(tsvPath, row, "utf8");
                                } catch (eT) {}
                            }
                        } else {
                            log("Ошибка перелинковки клипа #" + itTarget.id + ": " + (rel ? rel.reason : "Сбой"), "bad");
                        }
                    });
                    relinkPromises.push(p);
                }
            })(targets[t]);
        }

        Promise.all(relinkPromises).then(function () {
            log("Успешно перелинковано на AE: " + successCount + " из " + targets.length + " клипов на таймлайне.", successCount > 0 ? "good" : "bad");
            triggerAudit();
        });
    }

    function extractChildrenSafe(node) {
        if (!node) return [];
        var raw = null;
        if (typeof node.getItems === "function") {
            try { raw = node.getItems(); } catch (e1) {}
        }
        if (!raw && node.children) raw = node.children;
        if (!raw && node.items) raw = node.items;
        if (!raw && typeof node.getChildren === "function") {
            try { raw = node.getChildren(); } catch (e2) {}
        }
        if (!raw) return [];
        if (Array.isArray(raw)) return raw;
        var list = [];
        if (typeof raw.numItems === "number") {
            for (var i = 0; i < raw.numItems; i++) {
                var it = (typeof raw.item === "function" ? raw.item(i) : null) || raw[i];
                if (it) list.push(it);
            }
            return list;
        }
        if (typeof raw.length === "number") {
            for (var j = 0; j < raw.length; j++) {
                var itm = (typeof raw.item === "function" ? raw.item(j) : null) || raw[j];
                if (itm) list.push(itm);
            }
            return list;
        }
        return [];
    }

    function buildProjectMap(project) {
        var map = {};
        if (state.lastReport && state.lastReport.items) {
            for (var i = 0; i < state.lastReport.items.length; i++) {
                var it = state.lastReport.items[i];
                if (it._nativeItem) {
                    map[it.id] = it._nativeItem;
                    map[String(it.id)] = it._nativeItem;
                }
            }
        }
        if (!project) return map;
        var rItem = project.rootItem;
        if (!rItem) return map;
        function walk(node) {
            if (!node) return;
            var id = String(node.nodeId || (node.guid ? (typeof node.guid.toString === "function" ? node.guid.toString() : String(node.guid)) : null) || node.id || node.treePath || "");
            if (id && !map[id]) map[id] = node;
            var children = extractChildrenSafe(node);
            for (var c = 0; c < children.length; c++) walk(children[c]);
        }
        walk(rItem);
        return map;
    }

    /* ------------------------------------------------ Duplicates */

    function auditDuplicateProject() {
        return new Promise(function (resolve, reject) {
            PardPremiereAdapter.auditMedia(null, { timelineOnly: false }, function (err, report) {
                if (err) reject(err);
                else if (!report || !report.ok || !report.projectSaved || !report.workspace) reject(new Error("Сохраните проект перед поиском дубликатов."));
                else resolve(report);
            });
        });
    }

    async function duplicateProjectIsActive(report) {
        var project = await PardPremiereAdapter.resolveActiveProject();
        if (!project) return false;
        var info = PardPremiereAdapter.identifyProject(project);
        return info.projectId === report.projectId && info.projectPath === report.projectPath;
    }

    function scanDuplicateReport(report) {
        return new Promise(function (resolve) {
            PardPremiereDuplicates.scanDuplicates(report.workspace, report.items, PardPremiereCopyEngine, {
                aeProtectedItems: report.aeProtectedItems || [],
                onProgress: function (p) {
                    el.duplicatesProgressFill.style.width = (p.percent || 0) + "%";
                    el.duplicatesProgressStats.textContent = "Проверено " + p.scannedFiles + " из " + p.totalFiles + " файлов (" + p.percent + "%)";
                },
                onDone: resolve
            });
        });
    }

    async function scanDuplicates() {
        if (state.duplicateScanning || state.consolidating || state.protecting || state.scanning) return;
        state.duplicateScanning = true;
        state.consolidationArmedGroup = null;
        el.btnScanDuplicates.disabled = true;
        el.duplicatesProgressBox.hidden = false;
        el.duplicatesProgressFill.style.width = "0%";
        el.duplicatesProgressStats.textContent = "Проверка всей библиотеки проекта и таймлайнов…";
        log("Поиск точных дубликатов во всём проекте…", "work");
        try {
            var rep = await auditDuplicateProject();
            var res = await scanDuplicateReport(rep);
            if (!await duplicateProjectIsActive(rep)) throw new Error("Активный проект изменился. Повторите поиск дубликатов.");
            state.duplicateReport = rep;
            state.duplicatesResult = res;
            var groups = res.duplicateGroups || [];
            log("Поиск завершён: найдено " + groups.length + " групп дубликатов.", groups.length > 0 ? "work" : "good");
            (res.errors || []).forEach(function (err) { log("Не проверен файл: " + (err.path || "") + " · " + err.message, "warn"); });
        } catch (err) {
            state.duplicateReport = null;
            state.duplicatesResult = { ok: false, duplicateGroups: [], errors: [{ message: err.message }] };
            log("Ошибка поиска дубликатов: " + err.message, "bad");
        } finally {
            state.duplicateScanning = false;
            el.btnScanDuplicates.disabled = false;
            el.duplicatesProgressBox.hidden = true;
            if (el.badgeDuplicates) {
                var count = (state.duplicatesResult.duplicateGroups || []).length;
                el.badgeDuplicates.textContent = count;
                el.badgeDuplicates.hidden = count === 0;
            }
            renderDuplicates(state.duplicatesResult);
        }
    }

    function renderDuplicates(res) {
        if (!el.duplicatesList) return;
        el.duplicatesList.innerHTML = "";

        var groups = (res && res.duplicateGroups) || [];
        if (groups.length === 0) {
            el.duplicatesSummary.hidden = false;
            el.duplicatesSummary.textContent = res && res.errors && res.errors.length ?
                "Проверка неполная: " + res.errors[0].message : "Точных дубликатов в проекте не обнаружено.";
            return;
        }

        el.duplicatesSummary.hidden = false;
        el.duplicatesSummary.textContent = "Групп: " + groups.length + " · Вся библиотека проекта; использование проверено по таймлайнам." +
            (res.errors && res.errors.length ? " · Не проверено файлов: " + res.errors.length : "");

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
        title.textContent = (group.kind === "project-items" ? "Общий источник" : "Точные копии") + " · " + formatBytes(group.size);
        head.appendChild(title);

        var reclaim = document.createElement("span");
        reclaim.className = "duplicate-group-reclaim";
        reclaim.textContent = "Элементов: " + group.projectItemCount + " · На таймлайнах: " + group.timelineItemCount;
        head.appendChild(reclaim);

        card.appendChild(head);

        var rec = document.createElement("div");
        rec.className = "duplicate-group-rec";
        rec.textContent = "Рекомендация: " + (group.reasons || []).join("; ");
        card.appendChild(rec);

        var effectiveCanonical = group.canonicalLocked ? group.recommendedCanonical :
            state.canonicalOverrides[group.contentId] || group.recommendedCanonical;
        if (!group.files.some(function (file) { return file.path === effectiveCanonical; })) effectiveCanonical = group.recommendedCanonical;

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
            radio.disabled = group.canonicalLocked || !group.canConsolidate || state.consolidating || state.duplicateScanning;
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
                canBadge.textContent = file.isAeProtected ? "ОРИГИНАЛ AE" : "ОСНОВНОЙ";
                top.appendChild(canBadge);
            }

            var pSpan = document.createElement("span");
            pSpan.className = "duplicate-file-path";
            pSpan.textContent = file.path;
            pSpan.title = file.path;
            top.appendChild(pSpan);

            row.appendChild(top);
            (file.items || []).forEach(function (item) {
                var usage = document.createElement("div");
                usage.className = "duplicate-group-rec";
                usage.textContent = (item.binPath ? item.binPath + "/" : "") + item.name +
                    (item.usedOnTimeline ? " · На таймлайне" : " · Только в библиотеке проекта");
                row.appendChild(usage);
            });
            card.appendChild(row);
        }

        // Consolidation Action Button (Two-click confirmation)
        if (group.canConsolidate) {
            var actBox = document.createElement("div");
            actBox.className = "duplicate-group-actions";

            var btnCons = document.createElement("button");
            btnCons.className = "btn";
            btnCons.disabled = state.consolidating || state.duplicateScanning || state.protecting;

            var isArm = (state.consolidationArmedGroup === group.groupId && Date.now() < state.consolidationArmedUntil);
            if (isArm) {
                btnCons.className = "btn btn-warn";
                btnCons.textContent = "ПОДТВЕРДИТЬ ОБЪЕДИНЕНИЕ (оригиналы не удаляются)";
                btnCons.onclick = function () {
                    return executeConsolidation(group, effectiveCanonical);
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
        var note = document.createElement("div");
        note.className = "duplicate-group-rec";
        note.textContent = group.canConsolidate ? "Перелинковка существующих элементов сохраняет нарезку, позиции, эффекты и ключи. Файлы и элементы библиотеки сохраняются." :
            "Эти элементы уже используют один файл. Автоматическое сведение элементов библиотеки в один недоступно; нарезка и ключи сохраняются.";
        card.appendChild(note);

        return card;
    }

    async function executeConsolidation(group, canonicalPath) {
        var originalReport = state.duplicateReport;
        if (!originalReport || state.consolidating || state.duplicateScanning || state.protecting) return;
        state.consolidating = true;
        state.consolidationArmedGroup = null;
        state.consolidationArmedUntil = 0;
        renderDuplicates(state.duplicatesResult);
        try {
            if (!await duplicateProjectIsActive(originalReport)) throw new Error("Активный проект изменился. Повторите поиск дубликатов.");
            var rep = await auditDuplicateProject();
            if (rep.projectId !== originalReport.projectId || rep.projectPath !== originalReport.projectPath) throw new Error("Активный проект изменился.");
            var fresh = await scanDuplicateReport(rep);
            var currentGroup = (fresh.duplicateGroups || []).filter(function (g) { return g.contentId === group.contentId; })[0];
            if (!currentGroup || !currentGroup.canConsolidate) throw new Error("Группа изменилась или уже использует общий файл. Повторите поиск.");
            var pMap = {}, auditById = {};
            rep.items.forEach(function (it) { pMap[it.id] = it._nativeItem || it._projectItem; auditById[it.id] = it; });
            group.files.forEach(function (file) {
                file.references.forEach(function (id) {
                    if (!auditById[id] || PardPremiereDuplicates.normalizePath(auditById[id].path) !== PardPremiereDuplicates.normalizePath(file.path))
                        throw new Error("Источник элемента изменился: " + id + ". Повторите поиск.");
                    if (!currentGroup.files.some(function (currentFile) { return currentFile.references.indexOf(id) !== -1; }))
                        throw new Error("Содержимое исходника изменилось. Повторите поиск.");
                });
            });
            if (currentGroup.canonicalLocked) canonicalPath = currentGroup.recommendedCanonical;
            log("Объединение дубликатов на основной файл " + canonicalPath + "…", "work");
            var res = await new Promise(function (resolve) {
                PardPremiereDuplicates.consolidateGroup(rep.workspace, currentGroup, canonicalPath, pMap, PardPremiereCopyEngine, {
                    auditItems: rep.items, checkProject: function () { return duplicateProjectIsActive(rep); }, onDone: resolve
                });
            });
            (res.links || []).forEach(function (link) {
                state.protectionLinks[rep.projectId + ":" + link.id] = link;
                if (auditById[link.id]) auditById[link.id].path = link.path;
            });
            if (res.links && res.links.length) {
                await publishMediaSnapshot(rep);
                if (await duplicateProjectIsActive(rep)) {
                    var project = await PardPremiereAdapter.resolveActiveProject();
                    if (!project || !project.save || await project.save() === false) throw new Error("Ссылки изменены, но Premiere не сохранил проект. Сохраните его вручную.");
                }
            }
            if (res.ok) log("Объединено: перелинковано " + (res.relinked - res.unchanged) + ", уже на основном файле " + res.unchanged + ". Нарезка и исходники сохранены.", "good");
            else log("Объединение выполнено не полностью: " + (res.message || "ошибок " + res.failures.length) + ". Изменено ссылок: " + (res.links || []).length, "bad");
            (res.failures || []).forEach(function (failure) { log("Элемент " + failure.id + ": " + failure.reason, "bad"); });
        } catch (err) { log("Ошибка объединения: " + err.message, "bad"); }
        finally {
            state.consolidating = false;
            await scanDuplicates();
            triggerAudit();
        }
    }

    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return "0 Б";
        var k = 1024;
        var sizes = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
        var i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
    }

    /* ------------------------------------------------ Boot & Event Wiring */

    function updatePauseButtons() {
        if (el.btnPauseUi) {
            el.btnPauseUi.textContent = state.userPaused ? "▶ Пуск" : "⏸ Пауза";
            el.btnPauseUi.title = state.userPaused
                ? "Возобновить фоновое сканирование"
                : "Приостановить фоновое сканирование; начатая защита завершится";
            if (state.userPaused) {
                el.btnPauseUi.classList.add("is-paused");
            } else {
                el.btnPauseUi.classList.remove("is-paused");
            }
        }
    }

    function toggleUserPause(desiredState) {
        var nextState = (typeof desiredState === "boolean") ? desiredState : !state.userPaused;
        if (state.userPaused === nextState) return;
        state.userPaused = nextState;
        updatePauseButtons();

        if (state.userPaused) {
            log("Фоновые процессы и сканирование приостановлены пользователем.", "warn");
            if (el.projStatus) {
                el.projStatus.textContent = "ПАУЗА";
                el.projStatus.className = "status-badge paused";
            }
        } else {
            log("Фоновые процессы и сканирование возобновлены.", "work");
            if (state.lastReport) {
                render(state.lastReport);
            }
            triggerAudit(null, false);
        }
    }

    var pollTimer = null;

    function startAutoRefresh() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(function () {
            if (state.userPaused) return;
            // If project is not saved yet or no project detected, poll quietly every 3 seconds
            if (!state.lastReport || !state.lastReport.projectSaved) {
                triggerAudit(null, true);
            }
        }, 3000);
    }

    function init() {
        el.itemsFilter.value = state.itemsFilter;
        el.itemsGroup.value = state.itemsGroup;
        el.itemsFilter.addEventListener("change", function () {
            state.itemsFilter = el.itemsFilter.value;
            el.itemsList.scrollTop = 0;
            renderItems(state.lastReport && state.lastReport.ok && state.lastReport.projectSaved ? state.lastReport.items : []);
        });
        el.itemsGroup.addEventListener("change", function () {
            state.itemsGroup = el.itemsGroup.value;
            el.itemsList.scrollTop = 0;
            renderItems(state.lastReport && state.lastReport.ok && state.lastReport.projectSaved ? state.lastReport.items : []);
        });
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
            el.btnScan.addEventListener("click", function () { triggerAudit(); });
        }



        if (el.btnPauseUi) {
            el.btnPauseUi.addEventListener("click", function () { toggleUserPause(); });
        }



        if (el.btnProtect) {
            el.btnProtect.addEventListener("click", protectExternalMedia);
        }

        if (el.btnSortUnused) {
            el.btnSortUnused.onclick = function () {
                sortUnusedClips();
            };
        }

        if (el.btnRelinkAe) {
            el.btnRelinkAe.onclick = function () { relinkAllAeMedia(); };
        }

        if (el.btnScanDuplicates) {
            el.btnScanDuplicates.onclick = function () { return scanDuplicates(); };
        }
        if (el.btnClearLog) {
            el.btnClearLog.addEventListener("click", function () {
                if (el.logBox) el.logBox.innerHTML = "";
                // Clear only the visible list; session.log remains available for diagnostics.
            });
        }

        // Auto-refresh when user switches focus to panel (e.g. after saving in Premiere)
        window.addEventListener("focus", function () {
            if (state.userPaused) return;
            triggerAudit(null, true);
        });

        document.addEventListener("visibilitychange", function () {
            if (state.userPaused) return;
            if (!document.hidden) {
                triggerAudit(null, true);
            }
        });

        updatePauseButtons();

        if (el.version) {
            try {
                if (typeof PardPremiereAdapter !== "undefined" && PardPremiereAdapter.pluginVersion) {
                    el.version.textContent = "v" + PardPremiereAdapter.pluginVersion;
                }
            } catch (eV) {}
        }

        window.PardPremiere = {
            state: state,
            sortUnusedClips: sortUnusedClips,
            protectExternalMedia: protectExternalMedia,
            scanDuplicates: scanDuplicates,
            executeConsolidation: executeConsolidation,
            triggerAudit: triggerAudit
        };

        log("PardDefender UXP загружен.", "neutral");
        triggerAudit();
        startAutoRefresh();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
