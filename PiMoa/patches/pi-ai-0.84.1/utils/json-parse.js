import { parse as partialParse } from "partial-json";
const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
function isControlCharacter(char) {
    const codePoint = char.codePointAt(0);
    return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}
function escapeControlCharacter(char) {
    switch (char) {
        case "\b":
            return "\\b";
        case "\f":
            return "\\f";
        case "\n":
            return "\\n";
        case "\r":
            return "\\r";
        case "\t":
            return "\\t";
        default:
            return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
    }
}
/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json) {
    let repaired = "";
    let inString = false;
    for (let index = 0; index < json.length; index++) {
        const char = json[index];
        if (!inString) {
            repaired += char;
            if (char === '"') {
                inString = true;
            }
            continue;
        }
        if (char === '"') {
            repaired += char;
            inString = false;
            continue;
        }
        if (char === "\\") {
            const nextChar = json[index + 1];
            if (nextChar === undefined) {
                repaired += "\\\\";
                continue;
            }
            if (nextChar === "u") {
                const unicodeDigits = json.slice(index + 2, index + 6);
                if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
                    repaired += `\\u${unicodeDigits}`;
                    index += 5;
                    continue;
                }
            }
            if (VALID_JSON_ESCAPES.has(nextChar)) {
                repaired += `\\${nextChar}`;
                index += 1;
                continue;
            }
            repaired += "\\\\";
            continue;
        }
        repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
    }
    return repaired;
}
export function parseJsonWithRepair(json) {
    try {
        return JSON.parse(json);
    }
    catch (error) {
        const repairedJson = repairJson(json);
        if (repairedJson !== json) {
            return JSON.parse(repairedJson);
        }
        throw error;
    }
}
/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson(partialJson) {
    if (!partialJson || partialJson.trim() === "") {
        return {};
    }
    const fenced = stripCodeFence(partialJson);
    if (fenced !== partialJson && fenced.trim() !== "") return parseStreamingJson(fenced);
    try {
        return parseJsonWithRepair(partialJson);
    }
    catch {
        try {
            const result = partialParse(partialJson);
            return (result ?? {});
        }
        catch {
            try {
                const result = partialParse(repairJson(partialJson));
                return (result ?? {});
            }
            catch {
                return {};
            }
        }
    }
}
// ── 本地补丁 B3（2026-09-27）：剥 markdown 头围栏后重走上游解析管线 ──────────
// 病灶：工具参数流式解析遇 "```json" 开头输入三级兜底全灭、静默退化 {}（上游
// earendil-works/pi#8858 未修）。纪律：仅在命中**头**围栏时才剥尾围栏 ⇒ 裸 JSON
// 路径逐字节不变（含「值以 ``` 结尾」的半程帧）；递归终止由「剥除后严格变短」保证。
function stripCodeFence(input) {
    const s = input.trim();
    const head = s.match(/^```[\w-]*[ \t]*\r?\n?/);
    if (!head) return input;
    return s.slice(head[0].length).replace(/\r?\n?```[ \t]*$/, "").trim();
}
//# sourceMappingURL=json-parse.js.map