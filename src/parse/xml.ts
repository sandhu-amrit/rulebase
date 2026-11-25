import { XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * Every element is parsed as an array, so a single `<Condition>` and many
 * look the same. This avoids a hand-kept list of "tags that might repeat",
 * which silently drops data when a real file repeats a tag the list missed.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  cdataPropName: "#cdata",
  textNodeName: "#text",
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseTagValue: false,
  parseAttributeValue: false,
  // Callbacks get a matcher, not a path string: building strings per element was the top cost.
  jPath: false,
  isArray: (_name, _jpath, _isLeaf, isAttribute) => !isAttribute,
});

/** Parse, failing loudly on malformed XML (fast-xml-parser is lenient by default). */
export function parseXml(content: string): unknown {
  const valid = XMLValidator.validate(content);
  if (valid !== true) {
    const { msg, line } = valid.err;
    throw new Error(`${msg} (line ${line})`);
  }
  return parser.parse(content);
}

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function localName(key: string): string {
  const i = key.lastIndexOf(":");
  return i >= 0 ? key.slice(i + 1) : key;
}

/** All child elements with this local name. */
export function children(node: unknown, name: string): Record<string, unknown>[] {
  const first = Array.isArray(node) ? node[0] : node;
  if (!first || typeof first !== "object") return [];
  const out: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(first as Record<string, unknown>)) {
    if (key.startsWith("@") || key.startsWith("#")) continue;
    if (localName(key) !== name) continue;
    for (const item of asArray(value)) {
      out.push(item && typeof item === "object" ? (item as Record<string, unknown>) : { "#text": String(item ?? "") });
    }
  }
  return out;
}

/** First child element with this local name. */
export function child(node: unknown, name: string): Record<string, unknown> | undefined {
  return children(node, name)[0];
}

/** Concatenated text and CDATA of an element (not of its children). */
export function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object") {
    const record = node as Record<string, unknown>;
    let out = "";
    if ("#text" in record) out += textOf(record["#text"]);
    if ("#cdata" in record) out += textOf(record["#cdata"]);
    if (!out && "Text" in record) out = textOf(record.Text);
    return out.replace(/\r\n?/g, "\n");
  }
  return "";
}

export function attr(node: unknown, name: string): string | undefined {
  const first = Array.isArray(node) ? node[0] : node;
  if (!first || typeof first !== "object") return undefined;
  const value = (first as Record<string, unknown>)[`@${name}`];
  return value == null ? undefined : String(value);
}

export function rootElement(doc: unknown): { name: string; node: Record<string, unknown> } | null {
  if (!doc || typeof doc !== "object") return null;
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (key.startsWith("?") || key.startsWith("#") || value == null) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first && typeof first === "object") return { name: localName(key), node: first as Record<string, unknown> };
  }
  return null;
}

/** Trimmed text of the first child with this name, or undefined. */
export function scalar(node: unknown, name: string): string | undefined {
  const text = textOf(child(node, name)).trim();
  return text || undefined;
}

/** Decode file bytes: BOM first, then the XML declaration's encoding, then UTF-8, then windows-1252. */
export function decodeBytes(bytes: Uint8Array): { text: string; encoding: string; lossy: boolean } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8", lossy: false };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le", lossy: false };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be", lossy: false };
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const declared = /<\?xml[^>]*encoding=["']([\w.-]+)["']/i.exec(head)?.[1]?.toLowerCase();
  if (declared && declared !== "utf-8" && declared !== "utf8") {
    try {
      return { text: new TextDecoder(declared).decode(bytes), encoding: declared, lossy: false };
    } catch {
      // unknown label: fall through to UTF-8 detection
    }
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8", lossy: false };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252", lossy: !declared };
  }
}
