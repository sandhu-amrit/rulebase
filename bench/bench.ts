/**
 * Benchmark against the phase 1 targets (docs/DESIGN.md, D15):
 *   full reindex of 5,000 artifacts < 30 s, incremental < 2 s,
 *   query p95 < 50 ms, memory < 300 MB.
 *
 *   npm run bench -- [artifacts=5000] [workdir]
 *   (run with --expose-gc for a steady-state memory reading; `npm run bench` does)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGates } from "../src/check.ts";
import { Session } from "../src/session.ts";
import { generate } from "./generate.ts";

const count = Number(process.argv[2] ?? 5000);
const work = path.resolve(process.argv[3] ?? path.join(os.tmpdir(), `rulebase-bench-${count}`));
const workspace = path.join(work, "workspace");
const cacheFile = path.join(work, "cache.sqlite");
fs.mkdirSync(work, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(cacheFile + suffix, { force: true });

const t0 = performance.now();
const { files } = generate(workspace, count);
console.log(`generated ${files} files in ${Math.round(performance.now() - t0)} ms → ${workspace}`);

const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const time = <T>(fn: () => T): [T, number] => {
  const start = performance.now();
  const out = fn();
  return [out, performance.now() - start];
};

const cold = new Session(workspace, { cacheFile });
const [first, fullMs] = time(() => cold.rebuild());
console.log(`\nfull index: ${Math.round(fullMs)} ms (scan ${first.stats.scanMs}, parse ${first.stats.parseMs}, link ${first.stats.linkMs}) · ${first.kb.rules().length} rules · ${first.kb.model.phrases.size} phrases · RSS ${mb()} MB`);
cold.close();

const warm = new Session(workspace, { cacheFile });
const [, warmMs] = time(() => warm.rebuild());
console.log(`warm start (cache reused): ${Math.round(warmMs)} ms`);

let rules = warm.kb().rules();
const victim = path.join(workspace, rules[Math.floor(rules.length / 2)].provenance.path);
fs.writeFileSync(victim, fs.readFileSync(victim, "utf8").replace(/is more than (\d+)/, (_, n: string) => `is more than ${Number(n) + 1}`));
const [inc, incMs] = time(() => warm.rebuild());
console.log(`incremental (1 file changed): ${Math.round(incMs)} ms (parsed ${inc.stats.parsed}, reused ${inc.stats.reused})`);

const q = warm.kb();
rules = q.rules();
(globalThis as { gc?: () => void }).gc?.();
const sampleMember = [...q.model.members.values()].find((member) => member.kind === "attribute" && !member.virtual)!;
const samplePhrase = [...q.model.phrases.values()].find((phrase) => phrase.memberId === sampleMember.id && phrase.kind === "navigation")!;
const words = samplePhrase.text.replace(/<[^>]*>/g, "").trim();
const calls: [string, () => unknown][] = [
  ["find_terms", () => q.findTerms({ query: words })],
  ["list_terms(class)", () => q.listTerms({ class: sampleMember.owner })],
  ["validate_phrases", () => q.validatePhrases({ phrases: [`${samplePhrase.text.replace(/<([^>]*)>/, "the $1")} is more than 3`] })],
  ["find_change_candidates", () => q.findChangeCandidates({ terms: [sampleMember.id], requirement: `raise the ${words} threshold` })],
  ["get_impact(member)", () => q.getImpact({ target: sampleMember.id })],
  ["get_impact(rule)", () => q.getImpact({ target: rules[7].id })],
  ["get_artifact", () => q.getArtifact({ id: rules[3].id })],
  ["drift", () => warm.drift()],
];
console.log("\nquery latency over 100 calls (ms):");
let worst = 0;
for (const [name, fn] of calls) {
  const samples: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 100; i++) {
    const [out, ms] = time(fn);
    samples.push(ms);
    if (i === 0) bytes = JSON.stringify(out).length;
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[49];
  const p95 = samples[94];
  worst = Math.max(worst, p95);
  console.log(`  ${name.padEnd(24)} p50 ${p50.toFixed(1).padStart(6)}  p95 ${p95.toFixed(1).padStart(6)}  response ${(bytes / 1024).toFixed(1)} KB`);
}
const [gates, gatesMs] = time(() => runGates(q));
console.log(`\nrulebase check: ${Math.round(gatesMs)} ms, ${gates.filter((gate) => gate.pass).length}/${gates.length} gates pass`);
for (const gate of gates) if (!gate.pass) console.log(`  FAIL ${gate.id}: ${gate.detail} ${(gate.failures ?? []).slice(0, 3).join("; ")}`);
console.log(`cache file: ${(warm.store.sizeBytes() / 1024 / 1024).toFixed(1)} MB · RSS ${mb()} MB`);
for (let i = 0; i < 5; i++) warm.rebuild();
console.log(`cache after 5 more identical reindexes: ${(warm.store.sizeBytes() / 1024 / 1024).toFixed(1)} MB`);
warm.close();
const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "--no-warnings", path.join(import.meta.dirname, "memory.ts"), workspace, cacheFile], { encoding: "utf8" });
const fresh = JSON.parse(child.stdout.trim().split("\n").pop() ?? "{}") as { startMs: number; rssMb: number; heapMb: number };
const rss = fresh.rssMb;
console.log(`fresh server process: warm start ${fresh.startMs} ms · RSS ${fresh.rssMb} MB · heap ${fresh.heapMb} MB`);

const targets = [
  ["full reindex < 30 s", fullMs < 30_000],
  ["incremental < 2 s", incMs < 2_000],
  ["query p95 < 50 ms", worst < 50],
  ["memory < 300 MB (fresh server process, RSS)", rss < 300],
] as const;
console.log("\ntargets:");
for (const [label, ok] of targets) console.log(`  ${ok ? "MET " : "MISS"} ${label}`);
