import fs from "node:fs";
import path from "node:path";
import { driftReport } from "./drift.ts";
import { buildKnowledgeBase } from "./kb.ts";
import type { SourceFile } from "./types.ts";

const KEEP = new Set([".brl", ".dta", ".dtr", ".fct", ".trl", ".rfl", ".dop", ".var", ".bom", ".voc", ".rulepackage", ".ruleproject"]);

function loadFolder(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (KEEP.has(path.extname(entry.name).toLowerCase())) {
        files.push({ path: path.relative(root, full), content: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  return files;
}

const root = path.resolve(process.argv[2] ?? "src/fixtures/miniloan");
const out = path.resolve(process.argv[3] ?? "rulebase.json");
const previousPath = process.argv[4] ? path.resolve(process.argv[4]) : "";
const kb = buildKnowledgeBase(loadFolder(root), { commit: path.basename(root) });
const snapshot = kb.snapshot();
fs.writeFileSync(out, JSON.stringify(snapshot, null, 2));
const failed = kb.gates.filter((gate) => !gate.pass);
console.log(`${snapshot.projectName}: ${snapshot.artifacts.length} artifacts, ${snapshot.terms.length} terms`);
console.log(`wrote ${out}`);
for (const gate of kb.gates) console.log(`${gate.pass ? "PASS" : "FAIL"} ${gate.id}: ${gate.detail}`);
if (previousPath && fs.existsSync(previousPath)) {
  const previous = JSON.parse(fs.readFileSync(previousPath, "utf8")) as typeof snapshot;
  const report = driftReport(snapshot, previous);
  console.log(
    `drift vs ${previousPath}: +${report.added.length} -${report.removed.length} ~${report.changed.length}`,
  );
}
if (failed.length) process.exitCode = 1;
