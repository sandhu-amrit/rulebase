import { XMLParser } from "fast-xml-parser";

const ARRAY_TAGS = new Set([
  "Param",
  "Condition",
  "Action",
  "Partition",
  "ConditionDefinition",
  "ActionDefinition",
  "variables",
  "referencedVariables",
  "RuleTask",
  "Transition",
  "Package",
  "Rule",
  "entries",
  "modelFolders",
  "paths",
  "TaskNode",
  "StopTask",
  "StartTask",
  "ActionTask",
  "SubflowTask",
  "Property",
  "Filter",
  "Select",
]);

export const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  cdataPropName: "#cdata",
  trimValues: false,
  ignoreDeclaration: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function localName(key: string): string {
  const i = key.lastIndexOf(":");
  return i >= 0 ? key.slice(i + 1) : key;
}

export function child(node: unknown, name: string): unknown {
  if (!node || typeof node !== "object") return undefined;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (localName(key) === name) return value;
  }
  return undefined;
}

export function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object") {
    const record = node as Record<string, unknown>;
    if ("#cdata" in record) return textOf(record["#cdata"]);
    if ("Text" in record) return textOf(record.Text);
    if (typeof record["#text"] === "string") return record["#text"];
  }
  return "";
}

export function attr(node: unknown, name: string): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const value = (node as Record<string, unknown>)[`@${name}`];
  if (value == null) return undefined;
  return String(value);
}

export function rootElement(doc: unknown): { name: string; node: Record<string, unknown> } | null {
  if (!doc || typeof doc !== "object") return null;
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (key === "?xml" || value == null || typeof value !== "object") continue;
    return { name: localName(key), node: value as Record<string, unknown> };
  }
  return null;
}

export function scalar(node: Record<string, unknown>, name: string): string | undefined {
  const value = child(node, name);
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  const text = textOf(value).trim();
  return text || undefined;
}
