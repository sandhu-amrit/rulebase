/**
 * `rulebase anonymize <workspace> <out>`: a copy of the workspace with business
 * content replaced, structure kept, so a real workspace can be tested (or a
 * parser bug shared) without its rules leaving the machine.
 *
 * - Every business word becomes a pseudonym (`borrower` -> `w12`), the same one
 *   everywhere: BOM identifiers (split on camelCase), verbalizations, BAL, B2X,
 *   rule, package, file, folder and project names. So vocabulary still matches.
 * - BAL / BOM / IRL keywords and ODM folder names are kept.
 * - Digits in rule text and table cells are permuted; string literals are replaced.
 * - UUIDs, locales, statuses and layout data are left as they are.
 *
 * Afterwards both copies are indexed and their shapes compared. A mismatch means
 * the anonymizer changed meaning, and is reported.
 */
import fs from "node:fs";
import path from "node:path";
import { BAL_WORDS } from "./bal.js";
import { buildWorkspace } from "./indexer.js";
import { decodeBytes } from "./parse/xml.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { scanWorkspace } from "./workspace.js";
const KEEP = new Set([
    ...BAL_WORDS,
    // BAL structure
    "definitions",
    "if",
    "then",
    "else",
    "this",
    "true",
    "false",
    "null",
    "print",
    "make",
    "set",
    "to",
    "add",
    "remove",
    "is",
    "not",
    // BOM and Java / IRL syntax
    "public",
    "protected",
    "private",
    "class",
    "interface",
    "extends",
    "implements",
    "readonly",
    "static",
    "final",
    "abstract",
    "package",
    "property",
    "domain",
    "void",
    "int",
    "long",
    "short",
    "byte",
    "double",
    "float",
    "boolean",
    "char",
    "string",
    "java",
    "lang",
    "util",
    "math",
    "object",
    "integer",
    "big",
    "decimal",
    "date",
    "collection",
    "list",
    "vector",
    "array",
    "hash",
    "map",
    "return",
    "new",
    "when",
    "evaluate",
    "insert",
    "retract",
    "update",
    "modify",
    "bind",
    "get",
    "is",
    "has",
    "irl",
    "bal",
    "xom",
    "platform",
    "ilog",
    "rules",
    "com",
    "ibm",
    "engine",
    "dataio",
    "for",
    "conversion",
    "factory",
    "ignore",
    "business",
    "documentation",
    "origin",
    "uuid",
    "load",
    "getter",
    "setter",
    "as",
    "properties",
    // ODM folder names and file roles
    "bom",
    "deployment",
    "templates",
    "queries",
    "resources",
    "output",
    "var",
    "voc",
    "brl",
    "dta",
    "rfl",
    "dop",
    "b2x",
    "trl",
    "dtr",
    "fct",
]);
/** Elements whose text is never business content. */
const SKIP_TEXT = new Set([
    "uuid",
    "locale",
    "outputLocation",
    "categories",
    "status",
    "priority",
    "Property",
    "effectiveDate",
    "expirationDate",
]);
/** Elements whose `Name` attribute is a technical key (UI properties, layout data), not a business name. */
const KEY_ELEMENTS = new Set(["Property", "Data"]);
/** Attributes that carry business names. */
const MAP_ATTRS = new Set([
    "Name",
    "name",
    "variableName",
    "verbalization",
    "type",
    "ruleflowName",
    "rulesetName",
    "targetRuleProjectName",
    "variableSetName",
    "href",
    "url",
    "origin",
    "initialValue",
    // Ruleflow task and node ids are often business names; they are mapped the same way wherever they appear.
    "Identifier",
    "Task",
    "Source",
    "Target",
]);
export class Anonymizer {
    words = new Map();
    strings = 0;
    stringMap = new Map();
    word(lower) {
        if (KEEP.has(lower) || /^\d+$/.test(lower) || lower.length <= 1)
            return lower;
        let mapped = this.words.get(lower);
        if (!mapped) {
            mapped = `w${this.words.size + 1}`;
            this.words.set(lower, mapped);
        }
        return mapped;
    }
    /** `yearlyIncome` -> `w3W7`, `Borrower` -> `W5`, `MAX_SCORE` -> `W9_W10`, `getYearlyIncome` -> `getW3W7`. */
    identifier(id) {
        return id.replace(/[A-Za-z][A-Za-z0-9]*/g, (token) => {
            const parts = token.match(/[A-Z]{2,}(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? [token];
            return parts
                .map((part) => {
                if (/^\d+$/.test(part))
                    return part;
                const mapped = this.word(part.toLowerCase());
                if (part.length > 1 && part === part.toUpperCase())
                    return mapped.toUpperCase();
                if (part[0] === part[0].toUpperCase())
                    return mapped[0].toUpperCase() + mapped.slice(1);
                return mapped;
            })
                .join("");
        });
    }
    /** Free text (verbalizations, BAL, names): words mapped, braces like {this} and {0} kept. */
    text(value, options = {}) {
        // One pass, so nothing is rewritten twice (a pseudonym's digits are never scrambled).
        const re = /\{(?:this|\d+)\}|"((?:[^"\\]|\\.)*)"|[A-Za-zÀ-ɏ][A-Za-z0-9À-ɏ]*|\d+/g;
        return value.replace(re, (token, quoted) => {
            if (token.startsWith("{"))
                return token;
            if (token.startsWith('"'))
                return options.strings
                    ? `"${this.string(quoted ?? "")}"`
                    : `"${this.text(quoted ?? "", options)}"`;
            if (/^\d+$/.test(token))
                return options.digits
                    ? token.replace(/\d/g, (digit) => String((Number(digit) * 7 + 3) % 10))
                    : token;
            if (/[a-z][A-Z]/.test(token))
                return this.identifier(token);
            const mapped = this.word(token.toLowerCase());
            if (mapped === token.toLowerCase())
                return token;
            return token[0] === token[0].toUpperCase()
                ? mapped[0].toUpperCase() + mapped.slice(1)
                : mapped;
        });
    }
    string(inner) {
        let mapped = this.stringMap.get(inner);
        if (!mapped) {
            mapped = `s${++this.strings}`;
            this.stringMap.set(inner, mapped);
        }
        return mapped;
    }
    pathSegment(segment) {
        if (segment.startsWith("."))
            return segment;
        const dot = segment.lastIndexOf(".");
        const ext = dot > 0 ? segment.slice(dot) : "";
        let stem = dot > 0 ? segment.slice(0, dot) : segment;
        // `model_en_US.voc`: the locale suffix is how the vocabulary is chosen; keep it.
        let locale = "";
        const match = ext.toLowerCase() === ".voc" ? /(_[a-z]{2,3}(?:_[A-Z]{2})?(?:_\w+)?)$/.exec(stem) : null;
        if (match) {
            locale = match[1];
            stem = stem.slice(0, -locale.length);
        }
        return this.text(stem) + locale + ext;
    }
    /** Map every segment of a workspace-relative path, and of `platform:/Project/...` or `../x/y.rfl#id` references. */
    reference(value) {
        const hash = value.indexOf("#");
        const head = hash >= 0 ? value.slice(0, hash) : value;
        const tail = hash >= 0 ? value.slice(hash) : "";
        const mapped = head
            .split("/")
            .map((segment) => {
            if (!segment || segment === ".." || segment === "." || /^[a-z]+:$/.test(segment))
                return segment;
            const decoded = decodeURIComponent(segment);
            const out = this.pathSegment(decoded);
            return segment.includes("%") ? encodeURIComponent(out) : out;
        })
            .join("/");
        return mapped + tail;
    }
    xml(content, mode) {
        const stack = [];
        let out = "";
        let i = 0;
        while (i < content.length) {
            if (content.startsWith("<![CDATA[", i)) {
                const end = content.indexOf("]]>", i);
                const inner = content.slice(i + 9, end < 0 ? content.length : end);
                const parent = stack[stack.length - 1] ?? "";
                out += `<![CDATA[${SKIP_TEXT.has(parent) ? inner : this.text(inner, { digits: mode === "bal", strings: true })}]]>`;
                i = end < 0 ? content.length : end + 3;
                continue;
            }
            if (content[i] === "<") {
                const end = content.indexOf(">", i);
                const tag = content.slice(i, end + 1);
                if (/^<[?!]/.test(tag)) {
                    out += tag;
                }
                else if (tag.startsWith("</")) {
                    stack.pop();
                    out += tag;
                }
                else {
                    const name = /^<([\w.:-]+)/.exec(tag)?.[1] ?? "";
                    const local = name.slice(name.lastIndexOf(":") + 1);
                    out += tag.replace(/([\w.:-]+)="([^"]*)"/g, (whole, attr, value) => {
                        const localAttr = attr.slice(attr.lastIndexOf(":") + 1);
                        // Namespaced attributes (xsi:type, xmi:version) are schema, not content.
                        if (attr !== localAttr || !MAP_ATTRS.has(localAttr) || !value)
                            return whole;
                        if (localAttr === "Name" && KEY_ELEMENTS.has(local))
                            return whole;
                        if (localAttr === "href" || localAttr === "url" || localAttr === "origin")
                            return `${attr}="${this.reference(value)}"`;
                        if (localAttr === "type")
                            return `${attr}="${this.identifier(value)}"`;
                        return `${attr}="${this.text(value)}"`;
                    });
                    if (!tag.endsWith("/>"))
                        stack.push(local);
                }
                i = end + 1;
                continue;
            }
            const next = content.indexOf("<", i);
            const text = content.slice(i, next < 0 ? content.length : next);
            const parent = stack[stack.length - 1] ?? "";
            out +=
                SKIP_TEXT.has(parent) || !text.trim()
                    ? text
                    : this.text(text, { digits: mode === "bal", strings: true });
            i = next < 0 ? content.length : next;
        }
        return out;
    }
    bom(content) {
        return content
            .split("\n")
            .map((line) => {
            // property keys stay; quoted values are documentation, origins or flags
            const prop = /^(\s*property\s+)("?[\w.$-]+"?)(\s+)"(.*)"(.*)$/.exec(line);
            if (prop) {
                const value = prop[2].replace(/"/g, "") === "origin"
                    ? this.reference(prop[4])
                    : /^(true|false|[\w-]{36}|[\d.]+)$/.test(prop[4])
                        ? prop[4]
                        : this.text(prop[4]);
                return `${prop[1]}${prop[2]}${prop[3]}"${value}"${this.bomCode(prop[5])}`;
            }
            return this.bomCode(line);
        })
            .join("\n");
    }
    bomCode(code) {
        return code.replace(/"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$.]*/g, (token) => {
            if (token.startsWith('"'))
                return token.length > 2 &&
                    !/^"(true|false)"$/.test(token) &&
                    !/^"ilog\./.test(token) &&
                    !/^"factory\./.test(token)
                    ? `"${this.text(token.slice(1, -1))}"`
                    : token;
            return token
                .split(".")
                .map((part) => this.identifier(part))
                .join(".");
        });
    }
    voc(content) {
        return content
            .split("\n")
            .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || /^uuid\s*=/.test(trimmed))
                return line;
            if (trimmed.startsWith("#"))
                return this.text(line);
            const eq = line.indexOf("=");
            if (eq < 0)
                return line;
            const key = line.slice(0, eq);
            const value = line.slice(eq + 1);
            const hash = key.lastIndexOf("#");
            const owner = hash >= 0 ? key.slice(0, hash) : key;
            const suffix = hash >= 0 ? key.slice(hash) : "";
            const mappedOwner = owner.replace(/[A-Za-z_$][\w$]*/g, (part) => this.identifier(part));
            // Decode \uXXXX first so an escaped letter is mapped with its word; the output is UTF-8.
            const decoded = value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
            return `${mappedOwner}${suffix}=${this.text(decoded)}`;
        })
            .join("\n");
    }
}
export function anonymizeWorkspace(source, out) {
    const input = path.resolve(source);
    const target = path.resolve(out);
    if (fs.existsSync(target) && fs.readdirSync(target).length)
        throw new Error(`Output folder is not empty: ${target}`);
    const scan = scanWorkspace(input);
    // When pointed at a project folder, the workspace is its parent; paths are relative to that.
    const root = scan.root;
    const anonymizer = new Anonymizer();
    let files = 0;
    const projectFolders = new Set(scan.projects.map((project) => project.folder));
    const write = (rel, text, encoding) => {
        const mappedRel = ["rulebase.yaml", "rulebase.glossary.yaml"].includes(rel)
            ? rel
            : rel
                .split("/")
                .map((segment) => ["rules", "bom", "deployment"].includes(segment)
                ? segment
                : anonymizer.pathSegment(segment))
                .join("/");
        const full = path.join(target, mappedRel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, encodeAs(text, encoding));
        files++;
    };
    for (const folder of projectFolders) {
        for (const name of [".ruleproject", ".project"]) {
            const file = path.join(root, folder, name);
            if (!fs.existsSync(file))
                continue;
            const decoded = decodeBytes(fs.readFileSync(file));
            write(path.posix.join(folder === "." ? "" : folder, name), anonymizer.xml(decoded.text, "plain"), decoded.encoding);
        }
    }
    for (const file of scan.files) {
        const decoded = decodeBytes(fs.readFileSync(path.join(root, file.path)));
        const ext = path.extname(file.path).toLowerCase() || path.basename(file.path);
        let text;
        if (ext === ".bom")
            text = anonymizer.bom(decoded.text);
        else if (ext === ".voc")
            text = anonymizer.voc(decoded.text);
        else if (ext === ".b2x")
            text = anonymizer.xml(decoded.text, "plain");
        else
            text = anonymizer.xml(decoded.text, ext === ".rulepackage" || ext === ".var" || ext === ".dop" ? "plain" : "bal");
        write(file.path, text, decoded.encoding);
    }
    const config = path.join(root, "rulebase.yaml");
    if (fs.existsSync(config)) {
        // Keys stay, values are mapped (decisionService, include/exclude project names, glossary path).
        const data = parseYaml(fs.readFileSync(config, "utf8"));
        const mapValue = (value, key) => Array.isArray(value)
            ? value.map((item) => mapValue(item, key))
            : typeof value === "string" && key !== "locale"
                ? anonymizer.text(value)
                : value;
        write("rulebase.yaml", stringifyYaml(Object.fromEntries(Object.entries(data ?? {}).map(([key, value]) => [key, mapValue(value, key)]))), "utf-8");
    }
    const glossary = path.join(root, "rulebase.glossary.yaml");
    if (fs.existsSync(glossary)) {
        const text = fs
            .readFileSync(glossary, "utf8")
            .replace(/(com\.[\w.$()]+)|("[^"]*")|([A-Za-z][\w-]*)/g, (token, fqn, quoted) => {
            if (fqn)
                return fqn
                    .split(".")
                    .map((part) => anonymizer.identifier(part))
                    .join(".");
            if (quoted)
                return `"${anonymizer.text(quoted.slice(1, -1))}"`;
            return ["phrase", "means", "note", "terms"].includes(token)
                ? token
                : anonymizer.text(token);
        });
        write("rulebase.glossary.yaml", text, "utf-8");
    }
    const original = buildWorkspace(input).kb;
    const anonymizedInput = input === root ? target : path.join(target, anonymizer.pathSegment(path.basename(input)));
    const anonymized = buildWorkspace(anonymizedInput).kb;
    const comparison = shape(original).map(([metric, value], index) => ({
        metric,
        original: value,
        anonymized: shape(anonymized)[index][1],
    }));
    return {
        out: anonymizedInput,
        files,
        words: anonymizer["words"].size,
        comparison,
        ok: comparison.every((row) => row.original === row.anonymized),
    };
}
function shape(kb) {
    const counts = new Map();
    for (const artifact of kb.model.artifacts.values())
        counts.set(artifact.type, (counts.get(artifact.type) ?? 0) + 1);
    let uses = 0;
    let resolved = 0;
    for (const list of kb.model.uses.values()) {
        for (const use of list) {
            uses++;
            if (use.resolved)
                resolved++;
        }
    }
    return [
        ...[
            "actionRule",
            "decisionTable",
            "decisionTree",
            "technicalRule",
            "function",
            "ruleflow",
            "decisionOperation",
            "variableSet",
            "package",
        ].map((type) => [type, counts.get(type) ?? 0]),
        ["table rows", kb.rules().reduce((sum, rule) => sum + (rule.rows?.length ?? 0), 0)],
        ["classes", kb.model.classes.size],
        ["members", kb.model.members.size],
        ["virtual members", [...kb.model.members.values()].filter((member) => member.virtual).length],
        ["phrases", kb.model.phrases.size],
        ["term uses", uses],
        ["typed uses", resolved],
        ["selection edges", kb.model.edges.filter((edge) => edge.type === "SELECTS").length],
        ["errors", kb.warnings().filter((warning) => warning.severity === "error").length],
    ];
}
function encodeAs(text, encoding) {
    if (encoding === "utf-8")
        return Buffer.from(text, "utf8");
    if (encoding === "windows-1252" || encoding === "iso-8859-1" || encoding === "latin1")
        return Buffer.from(text, "latin1");
    if (encoding === "utf-16le")
        return Buffer.from(text, "utf16le");
    return Buffer.from(text, "utf8");
}
