import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildKnowledgeBase } from "./kb.ts";
import { RuleStore } from "./store.ts";
import type { SourceFile } from "./types.ts";

function loadFixture(): SourceFile[] {
  const root = path.resolve("src/fixtures/miniloan");
  const keep = new Set([".brl", ".dta", ".rfl", ".dop", ".var", ".bom", ".voc", ".rulepackage", ".ruleproject"]);
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (keep.has(path.extname(entry.name).toLowerCase())) {
        files.push({ path: path.relative(root, full), content: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  return files;
}

describe("odm knowledge pipeline", () => {
  const kb = buildKnowledgeBase(loadFixture(), { commit: "miniloan" });

  it("parses the miniloan decision service", () => {
    const rules = kb.artifacts.filter((item) => item.type === "actionRule");
    const tables = kb.artifacts.filter((item) => item.type === "decisionTable");
    const flows = kb.artifacts.filter((item) => item.type === "ruleflow");
    assert.equal(rules.length, 3);
    assert.equal(tables.length, 1);
    assert.equal(flows.length, 1);
    assert.equal(kb.signature()?.name, "Miniloan Service Operation");
    assert.ok(kb.terms.some((term) => term.example === "credit score of the borrower"));
    assert.equal(tables[0].rows?.length, 7);
    assert.equal(tables[0].columns?.length, 4);
  });

  it("grounds terms inside action rules and the ruleflow", () => {
    const credit = kb.getArtifact("minimum credit score");
    assert.ok(credit);
    assert.ok(credit?.vocabularyTermsUsed.some((term) => term.includes("credit score")));
    assert.ok(credit?.vocabularyTermsUsed.some((term) => term.includes("reject")));
    const flow = kb.artifacts.find((item) => item.type === "ruleflow");
    const packages = (flow?.tasks ?? []).flatMap((task) => task.packages);
    assert.deepEqual(packages.sort(), ["eligibility", "validation"]);
    const selected = kb.edges.filter((edge) => edge.type === "SELECTS_FROM");
    assert.equal(selected.length, 2);
  });

  it("searches by business language and reports impact", () => {
    const hits = kb.search("credit score below 200");
    assert.equal(hits[0]?.artifact.name, "minimum credit score");
    const impact = kb.impact("eligibility");
    const names = impact.artifacts.map((item) => item.name);
    assert.ok(names.includes("miniloan"));
    assert.ok(names.includes("Miniloan Service Operation"));
    assert.ok(names.includes("repayment and score"));
  });

  it("accepts a grounded requirement and rejects unknown vocabulary", () => {
    const ok = kb.ground("Reject loans when the borrower is over-leveraged");
    assert.equal(ok.accepted, true, ok.rejection ?? ok.unknown.join(","));
    assert.match(ok.draft ?? "", /reject/i);
    assert.ok(ok.tools.some((tool) => tool.name === "search_rules"));
    const bad = kb.ground("Reject the loan when the vibe score of the applicant is low");
    assert.equal(bad.accepted, false);
    assert.ok(bad.unknown.includes("vibe"));
    assert.equal(bad.draft, null);
  });

  it("records feedback and reports drift against a changed index", () => {
    const accepted = kb.recordFeedback("Reject loans when the borrower is over-leveraged", true);
    assert.equal(accepted.accepted, true);
    assert.ok(accepted.mapped.some((term) => term.includes("repayment") || term.includes("income")));
    const before = kb.snapshot();
    const changed = structuredClone(before);
    changed.artifacts = changed.artifacts.filter((item) => item.name !== "minimum credit score");
    changed.commit = "edited";
    const report = kb.driftAgainst(changed);
    assert.ok(report.added.some((item) => item.name === "minimum credit score"));
    assert.ok(kb.projects().length >= 1);
    assert.ok((kb.projects()[0]?.artifacts.length ?? 0) > 0);
  });

  it("round-trips the index through the SQLite file", () => {
    const file = path.join(os.tmpdir(), `rulebase-${process.pid}.sqlite`);
    fs.rmSync(file, { force: true });
    const store = new RuleStore(file);
    const id = store.save(kb.snapshot(), { label: "miniloan", feedback: kb.feedback });
    const loaded = store.load(id);
    store.close();
    fs.rmSync(file, { force: true });
    assert.ok(loaded);
    assert.equal(loaded?.artifacts.length, kb.artifacts.length);
    assert.equal(loaded?.terms.length, kb.terms.length);
    assert.equal(loaded?.edges.length, kb.edges.length);
    assert.equal(loaded?.glossary.length, kb.glossary.length);
  });

  it("passes the production quality gates on the sample", () => {
    const failed = kb.gates.filter((gate) => !gate.pass);
    assert.deepEqual(
      failed.map((gate) => `${gate.id}: ${gate.detail}`),
      [],
    );
  });
});
