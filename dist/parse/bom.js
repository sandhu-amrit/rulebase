const CLASS_MODIFIERS = new Set(["public", "protected", "private", "abstract", "final", "static", "strictfp"]);
const MEMBER_MODIFIERS = new Set(["public", "protected", "private", "static", "final", "readonly", "abstract", "native", "synchronized", "transient", "volatile", "deprecated"]);
export function parseBom(content, provenance, bomEntry) {
    const warnings = [];
    const statements = scan(stripComments(content), provenance.path, warnings);
    const properties = {};
    const classes = [];
    const members = [];
    let currentPackage = "";
    for (const statement of statements) {
        const text = statement.text.trim();
        if (!text)
            continue;
        if (statement.body) {
            const parsed = parseClassHeader(text, currentPackage);
            if (!parsed) {
                warnings.push({
                    path: provenance.path,
                    severity: "error",
                    message: `line ${statement.line}: could not read class header '${text.slice(0, 80)}'`,
                });
                continue;
            }
            const klass = {
                ...parsed,
                virtual: false,
                provenance: { ...provenance },
                bomEntry,
            };
            klass.documentation = documentationOf(klass.properties);
            classes.push(klass);
            for (const memberStatement of statement.body) {
                const memberText = memberStatement.text.trim();
                if (!memberText)
                    continue;
                const member = parseMember(memberText, klass);
                if (!member) {
                    warnings.push({
                        path: provenance.path,
                        severity: "error",
                        message: `line ${memberStatement.line}: could not read member of ${klass.fqn}: '${memberText.slice(0, 80)}'`,
                    });
                    continue;
                }
                if (member === "domain")
                    continue;
                member.provenance = { ...provenance };
                members.push(member);
            }
            continue;
        }
        const pkg = /^package\s+([\w.$]+)$/.exec(text);
        if (pkg) {
            currentPackage = pkg[1];
            continue;
        }
        const prop = /^property\s+("(?:[^"\\]|\\.)*"|[\w.$-]+)\s+("(?:[^"\\]|\\.)*"|\S+)$/.exec(text);
        if (prop) {
            properties[unquote(prop[1])] = unquote(prop[2]);
            continue;
        }
        if (/^import\s/.test(text))
            continue;
        warnings.push({
            path: provenance.path,
            severity: "error",
            message: `line ${statement.line}: unrecognised top-level statement '${text.slice(0, 80)}'`,
        });
    }
    // `property` lines at the top are written without a trailing `;` and end at the newline,
    // so the scanner can glue them onto the following statement. Split them out here.
    return { properties, classes, members, warnings };
}
function stripComments(content) {
    let out = "";
    let i = 0;
    while (i < content.length) {
        const ch = content[i];
        if (ch === '"') {
            const end = endOfString(content, i);
            out += content.slice(i, end);
            i = end;
            continue;
        }
        if (ch === "/" && content[i + 1] === "/") {
            while (i < content.length && content[i] !== "\n")
                i++;
            continue;
        }
        if (ch === "/" && content[i + 1] === "*") {
            const end = content.indexOf("*/", i + 2);
            const chunk = content.slice(i, end < 0 ? content.length : end + 2);
            out += chunk.replace(/[^\n]/g, " ");
            i = end < 0 ? content.length : end + 2;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}
function endOfString(text, start) {
    let i = start + 1;
    while (i < text.length) {
        if (text[i] === "\\") {
            i += 2;
            continue;
        }
        if (text[i] === '"')
            return i + 1;
        i++;
    }
    return text.length;
}
/**
 * Split into statements. Top level: `property ...` lines (newline-terminated),
 * `package x;`, and class headers with a `{ ... }` body. Inside a body,
 * members end at `;`.
 */
function scan(content, path, warnings) {
    const out = [];
    let i = 0;
    let line = 1;
    let buffer = "";
    let bufferLine = 1;
    let body = null;
    let memberBuffer = "";
    let memberLine = 1;
    const flushTop = () => {
        if (buffer.trim())
            out.push({ text: collapse(buffer), line: bufferLine });
        buffer = "";
    };
    while (i < content.length) {
        const ch = content[i];
        if (ch === "\n")
            line++;
        if (ch === '"') {
            const end = endOfString(content, i);
            const chunk = content.slice(i, end);
            if (body)
                memberBuffer += chunk;
            else
                buffer += chunk;
            i = end;
            continue;
        }
        if (body === null) {
            if (!buffer.trim())
                bufferLine = line;
            if (ch === "\n" && /^\s*property\s/.test(buffer) && !/\bclass\b|\binterface\b/.test(buffer)) {
                flushTop();
                i++;
                continue;
            }
            if (ch === ";") {
                flushTop();
                i++;
                continue;
            }
            if (ch === "{") {
                if (/\bdomain\s*$/.test(buffer)) {
                    const end = matchingBrace(content, i);
                    buffer += content.slice(i, end);
                    line += countNewlines(content.slice(i, end));
                    i = end;
                    continue;
                }
                body = [];
                memberBuffer = "";
                memberLine = line;
                i++;
                continue;
            }
            if (ch === "}") {
                warnings.push({ path, severity: "error", message: `line ${line}: unexpected '}'` });
                i++;
                continue;
            }
            buffer += ch;
            i++;
            continue;
        }
        // inside a class body
        if (!memberBuffer.trim())
            memberLine = line;
        if (ch === "{") {
            if (/\bdomain\s*$/.test(memberBuffer)) {
                const end = matchingBrace(content, i);
                memberBuffer += content.slice(i, end);
                line += countNewlines(content.slice(i, end));
                i = end;
                continue;
            }
            warnings.push({ path, severity: "error", message: `line ${line}: nested '{' in class body is not supported` });
            const end = matchingBrace(content, i);
            line += countNewlines(content.slice(i, end));
            i = end;
            continue;
        }
        if (ch === ";") {
            body.push({ text: collapse(memberBuffer), line: memberLine });
            memberBuffer = "";
            i++;
            continue;
        }
        if (ch === "}") {
            if (memberBuffer.trim()) {
                // A trailing `domain {..}` or property without `;` still belongs to the class.
                body.push({ text: collapse(memberBuffer), line: memberLine });
            }
            out.push({ text: collapse(buffer), body, line: bufferLine });
            buffer = "";
            body = null;
            i++;
            continue;
        }
        memberBuffer += ch;
        i++;
    }
    if (body) {
        warnings.push({ path, severity: "error", message: `class body starting near line ${bufferLine} is not closed` });
        out.push({ text: collapse(buffer), body, line: bufferLine });
    }
    else {
        flushTop();
    }
    return out;
}
function matchingBrace(text, start) {
    let depth = 0;
    let i = start;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            i = endOfString(text, i);
            continue;
        }
        if (ch === "{")
            depth++;
        if (ch === "}") {
            depth--;
            if (depth === 0)
                return i + 1;
        }
        i++;
    }
    return text.length;
}
function countNewlines(text) {
    let n = 0;
    for (const ch of text)
        if (ch === "\n")
            n++;
    return n;
}
function collapse(text) {
    // Keep string contents intact; collapse whitespace outside them.
    let out = "";
    let i = 0;
    while (i < text.length) {
        if (text[i] === '"') {
            const end = endOfString(text, i);
            out += text.slice(i, end);
            i = end;
            continue;
        }
        if (/\s/.test(text[i])) {
            if (!out.endsWith(" "))
                out += " ";
            i++;
            continue;
        }
        out += text[i];
        i++;
    }
    return out.trim();
}
function unquote(value) {
    if (value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
    }
    return value;
}
/** Pull `property "k" "v"` clauses and a `domain ...` clause off a header or member. */
function extractClauses(text) {
    const properties = {};
    let rest = text;
    const propRe = /\bproperty\s+("(?:[^"\\]|\\.)*"|[\w.$-]+)\s+("(?:[^"\\]|\\.)*"|[^\s"]+)/g;
    rest = rest.replace(propRe, (_, key, value) => {
        properties[unquote(key)] = unquote(value);
        return " ";
    });
    let domain;
    // `domain` followed by something: a member that is itself named `domain` is left alone.
    const domainMatch = /(^|\s)domain\s+(?=\S)/.exec(rest);
    if (domainMatch) {
        domain = rest.slice(domainMatch.index + domainMatch[0].length).trim();
        rest = rest.slice(0, domainMatch.index);
    }
    else if (/^\s*domain\s*\{/.test(rest)) {
        domain = rest.replace(/^\s*domain\s*/, "").trim();
        rest = "";
    }
    return { rest: rest.replace(/\s+/g, " ").trim(), properties, domain };
}
function parseClassHeader(header, packageName) {
    const { rest, properties, domain } = extractClauses(header);
    const match = /^((?:\w+\s+)*)(class|interface)\s+([\w$.]+)(?:\s+extends\s+([\w$.<>, ]+?))?(?:\s+implements\s+([\w$.<>, ]+))?$/.exec(rest);
    if (!match)
        return null;
    const modifiers = match[1].trim().split(/\s+/).filter(Boolean);
    if (modifiers.some((item) => !CLASS_MODIFIERS.has(item)))
        return null;
    const kind = match[2];
    const name = match[3];
    const superTypes = [...splitTypes(match[4]), ...splitTypes(match[5])];
    const fqn = name.includes(".") || !packageName ? name : `${packageName}.${name}`;
    return {
        fqn,
        name: fqn.split(".").pop() ?? name,
        packageName: fqn.includes(".") ? fqn.slice(0, fqn.lastIndexOf(".")) : "",
        kind,
        modifiers,
        superTypes,
        domain: domain ? staticDomainValues(domain) : undefined,
        properties,
    };
}
function splitTypes(list) {
    if (!list)
        return [];
    return list
        .split(",")
        .map((item) => item.replace(/<.*>/, "").trim())
        .filter(Boolean);
}
/** `{static GOLD, static SILVER}` -> ["GOLD", "SILVER"]. Other domain kinds return undefined. */
function staticDomainValues(domain) {
    const inner = /^\{([\s\S]*)\}$/.exec(domain.trim());
    if (!inner)
        return undefined;
    const values = inner[1]
        .split(",")
        .map((item) => item.trim().replace(/^static\s+/, ""))
        .filter(Boolean);
    return values.length ? values : undefined;
}
function parseMember(text, klass) {
    const { rest, properties, domain } = extractClauses(text);
    if (!rest && domain !== undefined)
        return "domain";
    const paren = rest.indexOf("(");
    const head = paren >= 0 ? rest.slice(0, paren).trim() : rest;
    const params = paren >= 0 ? rest.slice(paren + 1, rest.lastIndexOf(")")).trim() : null;
    const afterParams = paren >= 0 ? rest.slice(rest.lastIndexOf(")") + 1).trim() : "";
    if (afterParams && !/^throws\s/.test(afterParams))
        return null;
    const words = splitHead(head);
    const modifiers = [];
    while (words.length && MEMBER_MODIFIERS.has(words[0]))
        modifiers.push(words.shift());
    let type;
    let name;
    let kind;
    if (params !== null && words.length === 1 && (words[0] === klass.name || words[0] === klass.fqn)) {
        kind = "constructor";
        type = klass.fqn;
        name = klass.name;
    }
    else if (words.length === 2) {
        type = words[0];
        name = words[1];
        kind = params === null ? "attribute" : "method";
    }
    else {
        return null;
    }
    if (!/^[\w$]+$/.test(name))
        return null;
    const parsedParams = params ? splitParams(params) : [];
    if (parsedParams === null)
        return null;
    const signature = parsedParams.map((item) => item.type).join(",");
    const id = kind === "attribute" ? `${klass.fqn}.${name}` : `${klass.fqn}.${name}(${signature})`;
    return {
        id,
        owner: klass.fqn,
        name,
        kind,
        type,
        params: parsedParams,
        static: modifiers.includes("static"),
        final: modifiers.includes("final"),
        readonly: modifiers.includes("readonly"),
        domain,
        properties,
        virtual: false,
        derivedFrom: [],
        documentation: documentationOf(properties),
        provenance: { project: "", path: "" },
    };
}
/** Split `java.util.Map<string, int> name` keeping generic arguments together. */
function splitHead(head) {
    const words = [];
    let depth = 0;
    let current = "";
    for (const ch of head) {
        if (ch === "<")
            depth++;
        if (ch === ">")
            depth--;
        if (/\s/.test(ch) && depth === 0) {
            if (current)
                words.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    if (current)
        words.push(current);
    // `int []` -> `int[]`
    const merged = [];
    for (const word of words) {
        if (/^(\[\])+$/.test(word) && merged.length)
            merged[merged.length - 1] += word;
        else
            merged.push(word);
    }
    return merged;
}
function splitParams(params) {
    if (!params)
        return [];
    const parts = [];
    let depth = 0;
    let current = "";
    for (const ch of params) {
        if (ch === "<")
            depth++;
        if (ch === ">")
            depth--;
        if (ch === "," && depth === 0) {
            parts.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    parts.push(current);
    const out = [];
    for (const part of parts) {
        const words = splitHead(part.trim()).filter((word) => word !== "final");
        if (words.length === 1)
            out.push({ type: words[0] });
        else if (words.length === 2)
            out.push({ type: words[0], name: words[1] });
        else
            return null;
    }
    return out;
}
function documentationOf(properties) {
    for (const [key, value] of Object.entries(properties)) {
        if (/doc(umentation)?$/i.test(key) || /description$/i.test(key))
            return value;
    }
    return undefined;
}
/** BOM primitive and well-known types, used to decide literal compatibility. */
export function typeCategory(type) {
    if (!type)
        return "unknown";
    const t = type.replace(/<.*>/, "").replace(/\[\]$/, "[]");
    if (t.endsWith("[]"))
        return "collection";
    if (/^(int|long|short|byte|double|float|java\.lang\.(Integer|Long|Short|Byte|Double|Float|Number)|java\.math\.Big(Decimal|Integer))$/.test(t))
        return "number";
    if (/^(string|java\.lang\.String|char|java\.lang\.Character)$/.test(t))
        return "string";
    if (/^(boolean|java\.lang\.Boolean)$/.test(t))
        return "boolean";
    if (/^(java\.util\.Date|java\.time\.\w+|ilog\.rules\.brl\.Time|java\.sql\.(Date|Timestamp))$/.test(t))
        return "date";
    if (/^java\.util\.(Collection|List|Set|ArrayList|HashSet|Vector)$/.test(t))
        return "collection";
    return "object";
}
