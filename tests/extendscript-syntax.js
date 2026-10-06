/*
 * @map role: Checks the ES3 literal-regex slash restriction missed by Node's ES5+ parser.
 * @map status: ready
 * Targeted lexical guard, not a complete ExtendScript compiler.
 */
"use strict";

function unsafeRegexSlashes(source) {
    var issues = [], i = 0, line = 1, previous = "";
    function skipQuoted(quote) {
        i++;
        while (i < source.length) {
            var c = source.charAt(i++);
            if (c === "\n") line++;
            if (c === "\\") { if (source.charAt(i) === "\n") line++; i++; }
            else if (c === quote) break;
        }
    }
    while (i < source.length) {
        var c = source.charAt(i), next = source.charAt(i + 1);
        if (/\s/.test(c)) { if (c === "\n") line++; i++; continue; }
        if (c === "'" || c === '"') { skipQuoted(c); previous = "literal"; continue; }
        if (c === "/" && next === "/") {
            while (i < source.length && source.charAt(i) !== "\n") i++;
            continue;
        }
        if (c === "/" && next === "*") {
            i += 2;
            while (i < source.length && !(source.charAt(i) === "*" && source.charAt(i + 1) === "/")) {
                if (source.charAt(i++) === "\n") line++;
            }
            i += 2; continue;
        }
        var regexStart = !previous || /^[=(:,\[!?:;{&|]$/.test(previous) ||
            previous === "return" || previous === "throw";
        if (c === "/" && regexStart) {
            var inClass = false;
            i++;
            while (i < source.length) {
                c = source.charAt(i++);
                if (c === "\\") { i++; continue; }
                if (c === "\n" || c === "\r") break;
                if (c === "[") inClass = true;
                else if (c === "]") inClass = false;
                else if (c === "/") {
                    if (inClass) issues.push({ line: line, reason: "Unescaped slash in regex character class" });
                    else break;
                }
            }
            while (i < source.length && /[a-z]/i.test(source.charAt(i))) i++;
            previous = "literal";
            continue;
        }
        if (/[a-z_$]/i.test(c)) {
            var start = i++;
            while (i < source.length && /[a-z0-9_$]/i.test(source.charAt(i))) i++;
            previous = source.substring(start, i); continue;
        }
        previous = c;
        i++;
    }
    return issues;
}

module.exports = unsafeRegexSlashes;
