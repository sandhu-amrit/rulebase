import assert from "node:assert/strict";
import { test } from "node:test";
import { runGates } from "../src/check.ts";
import { built, MINILOAN } from "./helpers.ts";

const { kb } = built(MINILOAN);

test("parses the whole sample with no warnings", () => {
  assert.deepEqual(kb.warnings(), []);
  const rules = kb.rules();
  assert.equal(rules.filter((rule) => rule.type === "actionRule").length, 3);
  const table = rules.find((rule) => rule.type === "decisionTable");
  assert.equal(table?.rows?.length, 7);
  assert.equal(table?.columns?.length, 4);
  assert.equal(kb.meta.decisionService, "Miniloan Service");
});

test("every gate passes", () => {
  for (const gate of runGates(kb)) assert.ok(gate.pass, `${gate.id}: ${gate.detail}`);
});

test("every term use is resolved to the right member", () => {
  const credit = kb.findArtifact("minimum credit score").artifact!;
  const targets = (kb.model.uses.get(credit.id) ?? []).map((use) => `${use.target}@${use.where}`);
  assert.deepEqual(targets.sort(), [
    "miniloan.Borrower.creditScore@conditions",
    "miniloan.Loan.addToMessages(string)@actions",
    "miniloan.Loan.reject()@actions",
    "var:borrower@conditions",
    "var:loan@actions",
  ]);
  for (const uses of kb.model.uses.values()) for (const use of uses) assert.ok(use.resolved, `${use.target} in ${use.where}`);
});

test("impact follows ruleflow selection and transition conditions", () => {
  const impact = kb.getImpact({ target: "minimum income" }) as { affected: { artifact: { name: string }; reason: string }[] };
  const names = impact.affected.map((item) => item.artifact.name);
  assert.ok(names.includes("miniloan"), "ruleflow");
  assert.ok(names.includes("Miniloan Service Operation"), "operation");
  assert.ok(names.includes("repayment and score"), "same package");
  assert.ok(!names.includes("maximum amount"), "other package is not affected");
  const flow = impact.affected.find((item) => item.artifact.name === "miniloan");
  assert.match(flow!.reason, /reached when: 'the loan' is approved/);
});

test("operation signature binds to ruleset parameters", () => {
  const result = kb.getOperationSignature({}) as { operations: { ruleflow: string; signature: { name: string; type: string; direction: string }[] }[] };
  assert.equal(result.operations[0].ruleflow, "miniloan");
  assert.deepEqual(result.operations[0].signature, [
    { name: "borrower", direction: "IN", type: "miniloan.Borrower", verbalization: "the borrower" },
    { name: "loan", direction: "IN_OUT", type: "miniloan.Loan", verbalization: "the loan" },
  ]);
});

test("decision-table candidates point at columns and rows", () => {
  const result = kb.findChangeCandidates({ terms: ["the credit score of the borrower"] });
  const table = result.modify.find((item) => item.type === "decisionTable") as { table: { columns: { id: string }[]; rows: { row: number; cells: { values: string[] }[] }[] } };
  assert.deepEqual(table.table.columns.map((column) => column.id), ["C1"]);
  assert.equal(table.table.rows.length, 7);
  assert.deepEqual(table.table.rows[0].cells[0].values, ["0", "200"]);
});
