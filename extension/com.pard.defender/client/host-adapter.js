/*
 * PardDefender - After Effects host adapter.
 *
 * @map role: Адаптер хоста After Effects: вызовы CEP evalScript, загрузка JSX и изоляция ExtendScript.
 * @map status: ready
 *
 * Owns the CEP evalScript transport, JSX module loading, ExtendScript escaping,
 * and calls to $.global.PardDefenderHost. Feature code uses this adapter rather
 * than touching CEP or ExtendScript directly.
 */
var PardHostAdapter = (function () {
    "use strict";

    var api = {};

    var HOST_MODULES = [
        "PardDefenderCore.jsx",
        "PardDefenderPlan.jsx",
        "PardDefenderAudit.jsx",
        "PardDefenderApply.jsx",
        "PardDefenderLayers.jsx"
    ];

    function getCep() {
        if (typeof window !== "undefined" && window.__adobe_cep__ &&
            typeof window.__adobe_cep__.evalScript === "function") {
            return window.__adobe_cep__;
        }
        if (typeof __adobe_cep__ !== "undefined" && __adobe_cep__ &&
            typeof __adobe_cep__.evalScript === "function") {
            return __adobe_cep__;
        }
        return null;
    }

    function evalScript(script, callback) {
        var cb = typeof callback === "function" ? callback : function () {};
        var cep = getCep();
        if (!cep) {
            cb("EvalScript error.");
            return;
        }
        try {
            cep.evalScript(script, cb);
        } catch (e) {
            cb("EvalScript error.");
        }
    }

    function escapeForExtendScript(value) {
        return String(value || "")
            .replace(/\\/g, "\\\\")
            .replace(/'/g, "\\'")
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n");
    }

    function defaultExtensionRoot() {
        if (typeof window === "undefined" || !window.location) return "";
        var p = decodeURIComponent(window.location.pathname || "").replace(/\\/g, "/");
        if (/^\/[A-Za-z]:\//.test(p)) p = p.substring(1);
        var marker = p.lastIndexOf("/client/");
        return marker < 0 ? "" : p.substring(0, marker);
    }

    api.describe = function () {
        return {
            id: "after-effects",
            appCode: "AEFT",
            capabilities: {
                auditMedia: true,
                commitRelinks: true,
                organizePanel: true,
                removeUnusedProjectItems: true,
                scanForgottenLayers: true,
                revealItems: true,
                proxies: true
            }
        };
    };

    api.initialize = function (extensionRoot, callback) {
        var cb = typeof callback === "function" ? callback
            : (typeof extensionRoot === "function" ? extensionRoot : function () {});
        var root = typeof extensionRoot === "string" ? extensionRoot : defaultExtensionRoot();

        if (!root) {
            cb(false, "Не удалось определить папку расширения.");
            return;
        }

        var index = 0;
        function next() {
            if (index >= HOST_MODULES.length) {
                evalScript(
                    "(function(){try{return $.global.PardDefenderHost ? " +
                    "('OK|' + $.global.PardDefenderHost.version) : 'NO_API';}" +
                    "catch(e){return 'ERR|' + e.toString();}})()",
                    function (raw) {
                        var text = String(raw || "");
                        if (text.indexOf("OK|") === 0) {
                            cb(true, text.substring(3));
                            return;
                        }
                        cb(false, "Хост загрузился, но API недоступен: " + text);
                    }
                );
                return;
            }

            var file = root + "/host/" + HOST_MODULES[index++];
            var script = [
                "(function(){try{",
                "var f=new File('" + escapeForExtendScript(file) + "');",
                "if(!f.exists){return 'MISSING|'+f.fsName;}",
                "$.evalFile(f);",
                "return 'OK';",
                "}catch(e){return 'ERR|'+e.toString()+'|line='+(e.line||0);}})()"
            ].join("");

            evalScript(script, function (raw) {
                var text = String(raw || "");
                if (text === "OK") { next(); return; }
                cb(false, HOST_MODULES[index - 1] + ": " + text.replace(/\|/g, " — "));
            });
        }
        next();
    };

    api.auditToFile = function (callback) {
        evalScript("$.global.PardDefenderHost.auditToFile();", callback);
    };

    api.commitFromFileJson = function (planPath, callback) {
        evalScript(
            "$.global.PardDefenderHost.commitFromFileJson('" +
            escapeForExtendScript(planPath) + "');",
            callback
        );
    };

    api.organizeFromFileJson = function (planPath, callback) {
        evalScript(
            "$.global.PardDefenderHost.organizeFromFileJson('" +
            escapeForExtendScript(planPath) + "');",
            callback
        );
    };

    api.removeItemsFromFileJson = function (planPath, callback) {
        evalScript(
            "$.global.PardDefenderHost.removeItemsFromFileJson('" +
            escapeForExtendScript(planPath) + "');",
            callback
        );
    };

    api.scanLayersToFile = function (callback) {
        evalScript("$.global.PardDefenderHost.scanLayersToFile();", callback);
    };

    api.revealComp = function (compId, callback) {
        evalScript(
            "$.global.PardDefenderHost.revealComp('" +
            escapeForExtendScript(compId) + "');",
            callback
        );
    };

    api.revealLayer = function (compId, layerIndex, layerName, callback) {
        evalScript(
            "$.global.PardDefenderHost.revealLayer('" +
            escapeForExtendScript(compId) + "', " +
            (Number(layerIndex) || 0) + ", '" +
            escapeForExtendScript(layerName) + "');",
            callback
        );
    };

    api.selectItemById = function (itemId, callback) {
        evalScript(
            "$.global.PardDefenderHost.selectItemById('" +
            escapeForExtendScript(itemId) + "');",
            callback
        );
    };

    api.writeSettingsFromFile = function (path, callback) {
        evalScript(
            "$.global.PardDefenderHost.writeSettingsFromFile('" +
            escapeForExtendScript(path) + "');",
            callback
        );
    };

    api.revealWorkspace = function (callback) {
        evalScript("$.global.PardDefenderHost.revealWorkspace();", callback);
    };

    return api;
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = PardHostAdapter;
}
