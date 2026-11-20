import fs from "node:fs";
import path from "node:path";
import { buildFromDaif } from "./daif.ts";
import { driftReport } from "./drift.ts";
import { buildKnowledgeBase } from "./kb.ts";
import { RuleStore } from "./store.ts";
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
const out = path.resolve(process.argv[3] ?? "rulebase.sqlite");
const kb = root.endsWith(".json")
  ? buildFromDaif(fs.readFileSync(root, "utf8"), { commit: path.basename(root), source: root })
  : buildKnowledgeBase(loadFolder(root), { commit: path.basename(root) });
const snapshot = kb.snapshot();
const store = new RuleStore(out);
const previousId = store.latestId();
const previous = previousId == null ? null : store.load(previousId);
const id = store.save(snapshot, { label: path.basename(root), feedback: kb.feedback });
const failed = kb.gates.filter((gate) => !gate.pass);
console.log(`${snapshot.projectName}: ${snapshot.artifacts.length} artifacts, ${snapshot.terms.length} terms`);
console.log(`saved snapshot ${id} in ${out}`);
for (const gate of kb.gates) console.log(`${gate.pass ? "PASS" : "FAIL"} ${gate.id}: ${gate.detail}`);
if (previous) {
  const report = driftReport(snapshot, previous);
  console.log(`drift vs snapshot ${previousId}: +${report.added.length} -${report.removed.length} ~${report.changed.length}`);
}
store.close();
if (failed.length) process.exitCode = 1;
