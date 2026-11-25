import { asArray, child, children, rootElement, textOf, attr, parseXml } from "./xml.js";
const KNOWN_CLASS_CHILDREN = new Set(["businessName", "executionName", "attribute", "method", "constructor", "import", "tester", "extender"]);
export function parseB2x(content, provenance) {
    const warnings = [];
    const classes = [];
    let doc;
    try {
        doc = parseXml(content);
    }
    catch (error) {
        warnings.push({ path: provenance.path, severity: "error", message: `B2X is not well-formed XML: ${errorText(error)}` });
        return { classes, provenance, warnings };
    }
    const root = rootElement(doc);
    if (!root) {
        warnings.push({ path: provenance.path, severity: "error", message: "B2X has no root element" });
        return { classes, provenance, warnings };
    }
    for (const node of children(root.node, "class")) {
        const businessName = textOf(child(node, "businessName")).trim();
        if (!businessName) {
            warnings.push({ path: provenance.path, severity: "error", message: "B2X <class> without <businessName>" });
            continue;
        }
        const klass = {
            businessName,
            executionName: textOf(child(node, "executionName")).trim() || undefined,
            members: [],
        };
        for (const kind of ["attribute", "method", "constructor"]) {
            for (const memberNode of children(node, kind)) {
                const name = textOf(child(memberNode, "name")).trim() || (kind === "constructor" ? businessName.split(".").pop() ?? "" : "");
                const paramTypes = children(memberNode, "parameter").map((param) => attr(param, "type") ?? textOf(param).trim());
                const parts = [];
                for (const label of ["getter", "setter", "body"]) {
                    const text = textOf(child(memberNode, label)).trim();
                    if (text)
                        parts.push(`${label}: ${text}`);
                }
                klass.members.push({ name, kind, paramTypes, implementation: parts.join("\n") });
            }
        }
        const extra = ["import", "tester", "extender"]
            .map((label) => textOf(child(node, label)).trim())
            .filter(Boolean)
            .join("\n");
        if (extra)
            klass.extra = extra;
        for (const key of Object.keys(node)) {
            const local = key.startsWith("@") || key.startsWith("#") ? null : key.slice(key.lastIndexOf(":") + 1);
            if (local && !KNOWN_CLASS_CHILDREN.has(local)) {
                warnings.push({ path: provenance.path, severity: "info", message: `B2X <${local}> in ${businessName} is not interpreted` });
            }
        }
        classes.push(klass);
    }
    if (!classes.length) {
        warnings.push({ path: provenance.path, severity: "info", message: "B2X file maps no classes" });
    }
    return { classes, provenance, warnings };
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
export { asArray };
