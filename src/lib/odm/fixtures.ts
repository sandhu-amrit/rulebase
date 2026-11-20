import type { SourceFile } from "./types.ts";

/**
 * Apache-2.0 Miniloan decision service from
 * DecisionsDev/odm-on-cloud-getting-started. License text ships beside the files.
 */
const rawModules = import.meta.glob("../../fixtures/miniloan/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const KEEP = [".brl", ".dta", ".dtr", ".fct", ".trl", ".rfl", ".dop", ".var", ".bom", ".voc", ".rulepackage", ".ruleproject"];

export function loadMiniloan(): SourceFile[] {
  return Object.entries(rawModules)
    .filter(([path]) => KEEP.some((ext) => path.toLowerCase().endsWith(ext)))
    .map(([path, content]) => ({
      path: path.replace(/^.*?fixtures\/miniloan\//, ""),
      content,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
