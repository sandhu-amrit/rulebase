/**
 * Regression tests for places where an agent would have received a confident wrong
 * answer.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildFromScan, buildWorkspace } from "../src/indexer.ts";
import { Session } from "../src/session.ts";
import { scanWorkspace } from "../src/workspace.ts";
import { ACME, built, copyTree, I18N, MINILOAN, tempDir } from "./helpers.ts";

const brl = (name: string, uuid: string, bal: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<ilog.rules.studio.model.brl:ActionRule xmlns:ilog.rules.studio.model.brl="http://ilog.rules.studio/model/brl.ecore"><name>${name}</name><uuid>${uuid}</uuid><locale>en_US</locale><definition><![CDATA[${bal}]]></definition></ilog.rules.studio.model.brl:ActionRule>\n`;

test("1a: a cached parse from another parser version (same hash and path) is not reused", () => {
  const scan = scanWorkspace(MINILOAN);
  const first = buildFromScan(scan);
  const stale = first.parsed.map((file) => ({ ...file, key: "parsed-by-an-older-version" }));
  const second = buildFromScan(scanWorkspace(MINILOAN), undefined, stale);
  assert.equal(second.stats.reused, 0);
  assert.equal(second.stats.parsed, scan.files.length);
});

test("1b: edits inside a package folder named `output` are noticed, and a workspace under /target/ is rescanned", () => {
  const dir = path.join(tempDir(), "target", "ws");
  copyTree(path.join(I18N, "Credit"), path.join(dir, "Credit"));
  const session = new Session(path.join(dir, "Credit"), {
    cacheFile: path.join(dir, "..", "c.sqlite"),
  });
  assert.ok(session.kb().findArtifact("montant eleve").artifact);
  const rule = path.join(dir, "Credit", "règles", "output", "montant eleve.brl");
  fs.writeFileSync(
    rule,
    fs
      .readFileSync(rule, "utf8")
      .replace("<name>montant eleve</name>", "<name>montant tres eleve</name>"),
  );
  (session as unknown as { lastStat: number }).lastStat = 0; // force the periodic stat scan
  assert.ok(session.kb().findArtifact("montant tres eleve").artifact, "the stat scan saw the edit");
  session.close();
});

test("1c: a failed rebuild keeps answering from the last index, marked stale, and retries", () => {
  const dir = tempDir();
  copyTree(MINILOAN, path.join(dir, "ws"));
  const session = new Session(path.join(dir, "ws"), { cacheFile: path.join(dir, "c.sqlite") });
  session.kb();
  const project = path.join(dir, "ws", ".ruleproject");
  const saved = fs.readFileSync(project);
  fs.rmSync(project);
  const result = session.rebuild();
  assert.match(result.kb.checked().stale ?? "", /could not be re-indexed/);
  fs.writeFileSync(project, saved);
  assert.equal(
    session.rebuild().kb.checked().stale,
    undefined,
    "recovers on the next successful rebuild",
  );
  session.close();
});

test("2a: a class name plus BAL keywords is not a valid phrase", () => {
  const { kb } = built(ACME);
  for (const phrase of [
    "the count of the borrower is more than 3",
    "the date of the loan is after today",
    "the value of the loan is 5",
    "the borrower",
  ]) {
    const result = kb.validatePhrases({ phrases: [phrase] }).results[0];
    assert.equal(result.ok, false, phrase);
  }
  assert.ok(
    kb.validatePhrases({ phrases: ["the credit score of the borrower is more than 3"] }).ok,
  );
});

test("2b: a BOM member without a verbalization needs a vocabulary entry, not a BOM change", () => {
  const { kb } = built(ACME);
  const result = kb.findChangeCandidates({
    terms: ["MAX_SCORE", "the max score of the borrower", "the shoe size of the borrower"],
  }) as {
    needsVerbalization?: { term: string; member: string }[];
    vocabularyGaps: { term: string }[];
  };
  assert.deepEqual(
    result.needsVerbalization?.map((item) => item.member),
    ["com.acme.loan.Borrower.MAX_SCORE", "com.acme.loan.Borrower.MAX_SCORE"],
  );
  assert.deepEqual(
    result.vocabularyGaps.map((gap) => gap.term),
    ["the shoe size of the borrower"],
  );
});

test("3a: a task naming a rule that exists in two packages is reported; a UUID is exact", () => {
  const dir = tempDir();
  copyTree(MINILOAN, path.join(dir, "ws"));
  const ws = path.join(dir, "ws");
  // a second rule called "maximum amount", in another package
  fs.writeFileSync(
    path.join(ws, "rules", "eligibility", "maximum amount.brl"),
    brl(
      "maximum amount",
      "dup-1",
      "if the amount of 'the loan' is more than 5 then reject 'the loan' ;",
    ),
  );
  const flow = path.join(ws, "rules", "miniloan.rfl");
  fs.writeFileSync(
    flow,
    fs
      .readFileSync(flow, "utf8")
      .replace('<Package Name="validation"/>', '<Rule Name="maximum amount"/>'),
  );
  const { kb } = buildWorkspace(ws);
  assert.ok(
    kb.warnings().some((warning) => /matches 2 rules in different packages/.test(warning.message)),
  );
  const edges = kb.model.edges.filter(
    (edge) => edge.type === "SELECTS" && edge.from.endsWith("#validation"),
  );
  assert.equal(edges.length, 2);
  assert.ok(edges.every((edge) => edge.resolved === false));

  fs.writeFileSync(
    flow,
    fs
      .readFileSync(flow, "utf8")
      .replace('<Rule Name="maximum amount"/>', '<Rule Name="maximum amount" Uuid="dup-1"/>'),
  );
  const exact = buildWorkspace(ws).kb.model.edges.filter(
    (edge) => edge.type === "SELECTS" && edge.from.endsWith("#validation"),
  );
  assert.deepEqual(
    exact.map((edge) => edge.to),
    ["dup-1"],
  );
});

test("3b: an operation without a ruleflow runs every rule, even when a ruleflow exists", () => {
  const dir = tempDir();
  copyTree(MINILOAN, path.join(dir, "ws"));
  const ws = path.join(dir, "ws");
  fs.mkdirSync(path.join(ws, "rules", "extra"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "rules", "extra", "lonely.brl"),
    brl(
      "lonely",
      "lonely-1",
      "if the amount of 'the loan' is more than 5 then reject 'the loan' ;",
    ),
  );
  const before = buildWorkspace(ws).kb;
  assert.equal(
    before.runsDescription(before.findArtifact("lonely").artifact!).runs,
    false,
    "selected by nothing, and every operation uses a ruleflow",
  );
  const op = fs.readFileSync(path.join(ws, "deployment", "Miniloan Service Operation.dop"), "utf8");
  const all = op
    .replace(/<name>[^<]*<\/name>/, "<name>run everything</name>")
    .replace(/<uuid>[^<]*<\/uuid>/, "<uuid>op-all</uuid>")
    .replace(/ ruleflowName="[^"]*"/, "")
    .replace(/ usingRuleflow="[^"]*"/, "")
    .replace(/<ruleflow href="[^"]*"\/>/, "");
  fs.writeFileSync(path.join(ws, "deployment", "all.dop"), all);
  const after = buildWorkspace(ws).kb;
  const runs = after.runsDescription(after.findArtifact("lonely").artifact!);
  assert.equal(runs.runs, true);
  assert.ok(runs.lines.some((line) => /run everything.*no ruleflow/.test(line)));
});

test("4: a term used in a ruleflow transition makes the ruleflow a change candidate", () => {
  const { kb } = built(ACME);
  const result = kb.findChangeCandidates({ terms: ["com.acme.loan.Loan.approved"] });
  const flow = result.modify.find((item) => item.type === "ruleflow") as
    { name: string; reasons: string[] } | undefined;
  assert.equal(flow?.name, "main");
  assert.match(flow?.reasons[0] ?? "", /transition t1/);
});

test("minor: every term that reaches a member gets credit; a package and a rule with the same name are ambiguous", () => {
  const { kb } = built(MINILOAN);
  const result = kb.findChangeCandidates({
    terms: ["the credit score of the borrower", "miniloan.Borrower.creditScore"],
  });
  assert.ok(result.modify.every((item) => item.coverage === "2/2 terms"));

  const dir = tempDir();
  copyTree(MINILOAN, path.join(dir, "ws"));
  fs.writeFileSync(
    path.join(dir, "ws", "rules", "eligibility", "validation.brl"),
    brl("validation", "v-1", "if the amount of 'the loan' is more than 5 then reject 'the loan' ;"),
  );
  const found = buildWorkspace(path.join(dir, "ws")).kb.findArtifact("validation");
  assert.equal(found.artifact, undefined);
  assert.deepEqual(found.ambiguous?.map((item) => item.type).sort(), ["actionRule", "package"]);
});

test("a sub-package is selected through its parent everywhere: run path, add suggestions, package impact", () => {
  const dir = tempDir();
  copyTree(ACME, path.join(dir, "ws"));
  const flow = path.join(dir, "ws", "LoanDS", "rules", "main.rfl");
  // the 'score' task now selects the parent package only
  fs.writeFileSync(
    flow,
    fs
      .readFileSync(flow, "utf8")
      .replace('<Package Name="eligibility.scoring"/>', '<Package Name="eligibility"/>'),
  );
  const { kb } = buildWorkspace(path.join(dir, "ws"));
  const rule = kb.findArtifact("minimum score").artifact!;
  assert.equal(rule.package, "eligibility.scoring");
  assert.ok(kb.runsDescription(rule).runs);
  const add = kb
    .findChangeCandidates({ terms: ["the debt ratio of the borrower"] })
    .add.find((item) => item.package === "eligibility.scoring");
  assert.ok(add && add.selectedBy.length > 0 && !("warning" in add), JSON.stringify(add));
  assert.match(add!.selectedBy[0], /selects parent package 'eligibility'/);
  const impact = kb.getImpact({ target: "eligibility.scoring" }) as {
    affected: { artifact: { type: string } }[];
  };
  assert.ok(impact.affected.some((item) => item.artifact.type === "ruleflow"));
});
