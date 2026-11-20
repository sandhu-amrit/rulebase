import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { buildFromDaif } from "./daif.ts";

describe("DAIF ingest", () => {
  const kb = buildFromDaif(fs.readFileSync("src/fixtures/daif/fuselage.json", "utf8"), {
    commit: "daif",
    source: "src/fixtures/daif/fuselage.json",
  });

  it("indexes the decision service from the interchange document", () => {
    assert.equal(kb.projectName, "Fuselage Inspection");
    assert.equal(kb.decisionService, "Fuselage operation");
    assert.equal(kb.artifacts.filter((item) => item.type === "actionRule").length, 5);
    assert.equal(kb.artifacts.filter((item) => item.type === "decisionTable").length, 1);
    assert.equal(kb.artifacts.find((item) => item.type === "decisionTable")?.rows?.length, 2);
    assert.ok(kb.artifacts.some((item) => item.type === "ruleflow" && item.name === "myRuleFlow"));
    assert.ok(kb.terms.some((term) => term.kind === "parameter" && term.example === "the inspection details"));
  });

  it("follows ruleflow selection and rejects unknown vocabulary", () => {
    const impact = kb.impact("Eligibility");
    assert.ok(impact.artifacts.some((item) => item.name === "Applicability rule"));
    assert.ok(impact.artifacts.some((item) => item.type === "ruleflow"));
    const bad = kb.ground("Reject when the vibe score is low");
    assert.equal(bad.accepted, false);
    assert.ok(bad.unknown.includes("vibe"));
  });

  it("passes the quality gates on a DAIF document", () => {
    const failed = kb.gates.filter((gate) => !gate.pass);
    assert.deepEqual(
      failed.map((gate) => `${gate.id}: ${gate.detail}`),
      [],
    );
  });
});
