/**
 * Patterns found in public ODM workspaces on GitHub: French (and Portuguese) BAL,
 * {this,PARTITIVE_ARTICLE} slots, @term grammar entries, a package folder named
 * `output`, subflows referenced by UUID, draft rules, and projects from other IBM
 * decision products that must be reported rather than read as empty.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { runGates } from "../src/check.ts";
import { buildWorkspace } from "../src/indexer.ts";
import { built, I18N } from "./helpers.ts";

const { kb } = built(path.join(I18N, "Credit"));
const uses = (name: string) => kb.model.uses.get(kb.findArtifact(name).artifact!.id)!.filter((use) => !use.target.startsWith("var:"));

test("French workspace: all gates pass, no errors", () => {
  assert.deepEqual(kb.warnings().filter((warning) => warning.severity === "error"), []);
  for (const gate of runGates(kb)) assert.ok(gate.pass, `${gate.id}: ${gate.detail}`);
  assert.equal(kb.model.locale, "fr_FR");
});

test("si / alors / sinon sections and {this,PARTITIVE_ARTICLE} slots", () => {
  const rule = kb.findArtifact("duree trop longue").artifact!;
  assert.match(rule.conditions ?? "", /duree mois/);
  assert.match(rule.actions ?? "", /ajouter/);
  assert.match(rule.elseActions ?? "", /assigner/);
  const found = uses("duree trop longue");
  for (const id of ["banque.Demande.dureeMois", "banque.Rapport.ajouterMotif(string)", "banque.Client.age", "banque.Demande.client"]) {
    assert.ok(found.some((use) => use.target === id && use.resolved), `${id}: ${JSON.stringify(found.map((use) => use.target))}`);
  }
  assert.ok(found.some((use) => use.target === "banque.Client.age" && use.writes), "assigner ... à is a write");
});

test("définitions, and a subject followed by a comma", () => {
  const found = uses("client mineur");
  assert.ok(found.some((use) => use.target === "banque.Client.age" && use.resolved));
  assert.ok(found.some((use) => use.target === "banque.Rapport.rejeter(string)" && use.resolved));
});

test("@term grammar entries are not errors; drafts are notes", () => {
  assert.ok(!kb.warnings().some((warning) => warning.message.includes("@")));
  const draft = kb.warnings().find((warning) => warning.path.endsWith("brouillon.brl"));
  assert.equal(draft?.severity, "info");
  assert.match(draft?.message ?? "", /empty definition/);
});

test("a package folder named `output` is a package, and a subflow by UUID is followed", () => {
  const rule = kb.findArtifact("montant eleve").artifact!;
  assert.equal(rule.package, "output");
  const run = kb.runPath(rule);
  assert.ok(run.selectedBy.some((item) => item.flow === "rfl-sub"));
  assert.ok(kb.model.edges.some((edge) => edge.type === "SUBFLOW" && edge.to === "rfl-sub"));
});

test("French validation: articles and keywords are understood, unknown words are not", () => {
  const [ok, bad] = kb.validatePhrases({ phrases: ["la duree mois de la demande est plus grand que 300", "le salaire de la demande est plus grand que 3"] }).results;
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(bad.ok, false);
  assert.deepEqual((bad as { unknownWords?: string[] }).unknownWords, ["salaire"]);
});

test("ADS and DSI projects are reported as other products, not read as empty", () => {
  const ads = buildWorkspace(path.join(I18N, "other", "AdsProject")).kb;
  assert.ok(ads.warnings().some((warning) => warning.severity === "error" && /Automation Decision Services/.test(warning.message)));
  const agent = buildWorkspace(path.join(I18N, "other", "AgentProject")).kb;
  assert.ok(agent.warnings().some((warning) => warning.severity === "error" && /Decision Server Insights/.test(warning.message)));
});
