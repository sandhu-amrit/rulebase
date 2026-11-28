import assert from "node:assert/strict";
import { test } from "node:test";
import { runGates } from "../src/check.ts";
import { ACME, built } from "./helpers.ts";

const { kb, scan } = built(ACME);

test("discovers the decision service and the projects it references", () => {
  assert.equal(kb.meta.decisionService, "LoanDS");
  assert.deepEqual(
    kb.meta.projects.map((project) => project.name),
    ["LoanBOM", "LoanDS", "LoanRules"],
  );
  const stale = kb
    .warnings()
    .find((warning) => warning.message.includes("'OldDS' is not referenced"));
  assert.equal(stale?.severity, "info");
  assert.ok(
    !scan.files.some((file) => file.path.startsWith(".metadata/")),
    "Eclipse metadata is skipped",
  );
  assert.ok(
    !scan.files.some((file) => file.path.includes("/templates/")),
    "templates are not indexed",
  );
  assert.equal(scan.skipped["templates/"], 1);
  assert.equal(scan.skipped["queries/"], 1);
});

test("all gates pass and no file failed", () => {
  assert.deepEqual(
    kb.warnings().filter((warning) => warning.severity === "error"),
    [],
  );
  for (const gate of runGates(kb)) assert.ok(gate.pass, `${gate.id}: ${gate.detail}`);
});

test("packages come from folders, nested packages keep their dots", () => {
  const rule = kb.findArtifact("minimum score").artifact!;
  assert.equal(rule.package, "eligibility.scoring");
  assert.equal(rule.provenance.project, "LoanRules");
  assert.equal(rule.provenance.path, "LoanRules/rules/eligibility/scoring/minimum score.brl");
});

test("windows-1252 file with CRLF is decoded and split correctly", () => {
  const rule = kb.findArtifact("vérification héritée").artifact!;
  assert.equal(rule.name, "vérification héritée");
  assert.equal(rule.conditions, "the yearly income of 'the borrower' is less than 1000");
});

test("BOM: inheritance, static domain, virtual members, virtual class", () => {
  const borrower = kb.model.classes.get("com.acme.loan.Borrower")!;
  assert.deepEqual(kb.model.ancestors.get(borrower.fqn), [
    "com.acme.loan.Party",
    "com.acme.loan.Scored",
  ]);
  assert.deepEqual(kb.model.classes.get("com.acme.loan.Grade")?.domain, ["A", "B", "C"]);
  const ratio = kb.model.members.get("com.acme.loan.Borrower.debtRatio")!;
  assert.equal(ratio.virtual, true);
  assert.deepEqual(ratio.derivedFrom, [
    "com.acme.loan.Borrower.monthlyDebt",
    "com.acme.loan.Borrower.yearlyIncome",
  ]);
  assert.equal(kb.model.members.get("com.acme.loan.Borrower.creditScore")?.virtual, false);
  const risk = kb.model.classes.get("com.acme.risk.RiskProfile")!;
  assert.equal(risk.virtual, true, "BOM entry without XOM origin");
});

test("one locale: the French vocabulary does not leak in", () => {
  assert.equal(kb.model.locale, "en_US");
  assert.equal(kb.labelOf("com.acme.loan.Borrower"), "borrower");
  assert.ok(![...kb.model.phrases.values()].some((phrase) => phrase.text.includes("crédit")));
});

test("definitions variables are typed, inherited members resolve", () => {
  const rule = kb.findArtifact("minimum score").artifact!;
  const uses = kb.model.uses.get(rule.id)!;
  const credit = uses.find((use) => use.target === "com.acme.loan.Borrower.creditScore");
  assert.equal(
    credit?.resolved,
    true,
    "'the applicant' is typed through 'the borrower of the loan'",
  );
  const name = uses.find((use) => use.target === "com.acme.loan.Party.name");
  assert.equal(name?.resolved, true, "name is declared on Party, used on a Borrower");
  assert.ok(
    uses.some(
      (use) =>
        use.target === "com.acme.loan.Loan.scoreBand" && use.where === "elseActions" && use.writes,
    ),
  );
});

test("technical rule IRL: class patterns and setters", () => {
  const rule = kb.findArtifact("score floor").artifact!;
  const uses = kb.model.uses
    .get(rule.id)!
    .map((use) => `${use.target}${use.writes ? " (writes)" : ""}${use.resolved ? "" : " ?"}`);
  assert.deepEqual(uses.sort(), [
    "com.acme.loan.Borrower.creditScore",
    "com.acme.loan.Borrower.frozen (writes)",
  ]);
});

test("impact of a member follows virtual members computed from it", () => {
  const impact = kb.getImpact({ target: "com.acme.loan.Borrower.yearlyIncome" }) as {
    affected: { artifact: { name: string }; reason: string }[];
    derived: string[];
  };
  assert.deepEqual(impact.affected.map((item) => item.artifact.name).sort(), [
    "dti bands",
    "vérification héritée",
  ]);
  assert.match(impact.derived[0], /debtRatio is computed from .*yearlyIncome/);
});

test("rule-level selection and never-selected rules", () => {
  const grade = kb.getArtifact({ id: "grade check" }) as { runs: string[]; operations: string[] };
  assert.equal(grade.runs.length, 1);
  assert.match(grade.runs[0], /task 'score'/);
  assert.deepEqual(grade.operations, ["Loan Operation"]);
  const legacy = kb.getImpact({ target: "legacy.vérification héritée" }) as { warning?: string };
  assert.match(legacy.warning ?? "", /does not run/);
  const candidates = kb.findChangeCandidates({ terms: ["the yearly income of the borrower"] });
  const entry = candidates.modify.find((item) => item.name === "vérification héritée");
  assert.match(entry!.runs[0], /does not run/);
});

test("glossary maps business words to terms, both in search and in candidates", () => {
  const found = kb.findTerms({ query: "salary" });
  assert.deepEqual(found.glossary[0].means, ["com.acme.loan.Borrower.yearlyIncome"]);
  const candidates = kb.findChangeCandidates({ terms: ["debt-to-income"] });
  assert.equal(candidates.requested[0].via, "glossary 'debt-to-income'");
  assert.deepEqual(
    candidates.modify.map((item) => item.name),
    ["dti bands"],
  );
});

test("list_terms shows inherited members and what virtual members derive from", () => {
  const result = kb.listTerms({ class: "borrower" }) as {
    members: { id: string; inheritedFrom?: string; virtual?: boolean; derivedFrom?: string[] }[];
  };
  const name = result.members.find((member) => member.id === "com.acme.loan.Party.name");
  assert.equal(name?.inheritedFrom, "com.acme.loan.Party");
  const ratio = result.members.find((member) => member.id === "com.acme.loan.Borrower.debtRatio");
  assert.equal(ratio?.virtual, true);
  assert.equal(ratio?.derivedFrom?.length, 2);
});

test("validation knows domain values, methods with arguments, and virtual classes", () => {
  const results = kb.validatePhrases({
    phrases: [
      "the grade of the borrower is A",
      "the borrower has a score above 700",
      "the risk level of the risk profile is at least 2",
    ],
  }).results;
  for (const result of results) assert.ok(result.ok, JSON.stringify(result));
});
