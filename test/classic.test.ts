/**
 * Patterns found in real public ODM samples (DecisionsDev repositories), kept as a
 * hand-written fixture: classic projects without a decision-service flag,
 * ruleset parameters in the .ruleproject, fork/join ruleflows, .b2xa files,
 * nested classes, unquoted definitions, slot hints and punctuation in verbalizations.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runGates } from "../src/check.ts";
import { built, CLASSIC } from "./helpers.ts";

const { kb } = built(CLASSIC);
const uses = (name: string) => {
  const rule = kb.findArtifact(name).artifact!;
  return kb.model.uses.get(rule.id)!.filter((use) => !use.target.startsWith("var:"));
};

test("classic workspace: the only top-level project is the main one", () => {
  assert.equal(kb.meta.decisionService, "ShopRules");
  assert.ok(kb.warnings().some((warning) => /only top-level project/.test(warning.message)));
  assert.deepEqual(kb.warnings().filter((warning) => warning.severity === "error"), []);
  for (const gate of runGates(kb)) assert.ok(gate.pass, `${gate.id}: ${gate.detail}`);
});

test("ruleset parameters declared in the .ruleproject are variables", () => {
  assert.deepEqual([...new Set([...kb.model.variables.values()].map((variable) => variable.name))].sort(), ["cart", "customer", "friend"]);
});

test("fork and join nodes are part of the ruleflow", () => {
  const flow = kb.findArtifact("flow").artifact!;
  assert.deepEqual(flow.tasks!.filter((task) => task.kind === "fork" || task.kind === "join").map((task) => task.kind), ["fork", "join"]);
  assert.equal(flow.transitions!.length, 6);
});

test(".b2xa: constructors written as methods, conversion operators, derived members", () => {
  const ctor = kb.model.members.get("shop.Customer.Customer(string)")!;
  assert.equal(ctor.virtual, true);
  assert.equal(kb.model.members.get("shop.Customer.operator java.util.Date(shop.Customer)")?.virtual, true);
  assert.deepEqual(kb.model.members.get("shop.Customer.isOlderThan(int)")?.derivedFrom, ["shop.Customer.age"]);
});

test("nested class with a body-level domain is vocabulary", () => {
  assert.deepEqual(kb.model.classes.get("shop.Customer.Tier")?.domain, ["GOLD", "SILVER"]);
  const targets = new Set(uses("upgrade").map((use) => use.target));
  for (const id of ["shop.Customer.tier", "shop.Customer.Tier.SILVER", "shop.Customer.Tier.GOLD", "shop.Cart.total"]) assert.ok(targets.has(id), `${id} in ${[...targets].join(", ")}`);
});

test("verbalizations with punctuation and slot hints: {this}.isOlderThan({0}), {0, <country>}", () => {
  const found = uses("seniors");
  assert.ok(found.some((use) => use.target === "shop.Customer.isOlderThan(int)" && use.resolved));
  assert.ok(found.some((use) => use.target === "shop.Customer.livesIn(string)" && use.resolved));
});

test("unquoted definitions variables and `this <concept>` are typed", () => {
  const found = uses("cheap items");
  assert.ok(found.some((use) => use.target === "shop.Item.price" && use.resolved));
  assert.ok(found.some((use) => use.target === "shop.Item.kind" && use.resolved));
  assert.ok(found.some((use) => use.target === "shop.Customer.tier" && use.writes && use.resolved));
});

test("bracketed arguments are typed", () => {
  const found = uses("nearby friend");
  assert.ok(found.some((use) => use.target === "shop.Geo.distanceKm(shop.Customer,shop.Customer)" && use.resolved));
  const result = kb.validatePhrases({ phrases: ["distance in km from ('the customer') to ('the friend') is less than 10"] }).results[0];
  assert.ok(result.ok, JSON.stringify(result));
});

test("a near-miss term is a vocabulary gap with the reason, not a silent match", () => {
  const result = kb.findChangeCandidates({ terms: ["the loyal tier of the shopping cart", "the age of the customer"] });
  assert.deepEqual(result.requested.map((item) => item.term), ["the age of the customer"]);
  assert.equal(result.vocabularyGaps.length, 1);
  assert.match(result.vocabularyGaps[0].why ?? "", /unknown words: loyal/);
  assert.match(result.vocabularyGaps[0].why ?? "", /belongs to customer/);
});

test("a bare term without its subject resolves by its words", () => {
  const result = kb.findChangeCandidates({ terms: ["price"] });
  assert.deepEqual(result.requested[0].resolvedTo, ["shop.Item.price"]);
  assert.deepEqual(result.modify.map((item) => item.name), ["cheap items"]);
});
