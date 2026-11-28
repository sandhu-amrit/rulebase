/**
 * Rules inside subflows: their "runs" answer must carry the conditions of every calling task, and a
 * subflow called only from an unreachable task does not run.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildWorkspace } from "../src/indexer.ts";
import { copyTree, I18N, tempDir } from "./helpers.ts";

const flowXml = (name: string, uuid: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<ilog.rules.studio.model.ruleflow:RuleFlow xmlns:ilog.rules.studio.model.ruleflow="http://ilog.rules.studio/model/ruleflow.ecore"><name>${name}</name><uuid>${uuid}</uuid><locale>fr_FR</locale><rfModel><Ruleflow xmlns="http://schemas.ilog.com/Rules/7.0/Ruleflow"><Body>${body}</Body></Ruleflow></rfModel></ilog.rules.studio.model.ruleflow:RuleFlow>\n`;

/** principal --(montant > 5000)--> sorties --(durée > 12)--> profond (selects package `output`) */
function nested(unreachableCaller = false): string {
  const dir = tempDir();
  copyTree(path.join(I18N, "Credit"), path.join(dir, "Credit"));
  const rules = path.join(dir, "Credit", "règles");
  const principal = fs
    .readFileSync(path.join(rules, "principal.rfl"), "utf8")
    .replace(
      '<Transition Identifier="t1" Source="n1" Target="n2"/>',
      unreachableCaller
        ? '<Transition Identifier="t1" Source="n1" Target="n3"/>'
        : '<Transition Identifier="t1" Source="n1" Target="n2"><Conditions Language="bal"><![CDATA[le montant de \'la demande\' est plus grand que 5000]]></Conditions></Transition><Transition Identifier="t1b" Source="n1" Target="n3"/>',
    );
  fs.writeFileSync(path.join(rules, "principal.rfl"), principal);
  fs.writeFileSync(
    path.join(rules, "sorties.rfl"),
    flowXml(
      "sorties",
      "rfl-sub",
      `<TaskList><StartTask Identifier="s"/><SubflowTask Identifier="plus loin" Uuid="rfl-deep"/><StopTask Identifier="e"/></TaskList>
       <NodeList><TaskNode Identifier="m0" Task="s"/><TaskNode Identifier="m1" Task="plus loin"/><TaskNode Identifier="m2" Task="e"/></NodeList>
       <TransitionList><Transition Identifier="u0" Source="m0" Target="m1"><Conditions Language="bal"><![CDATA[la duree mois de 'la demande' est plus grand que 12]]></Conditions></Transition><Transition Identifier="u0b" Source="m0" Target="m2"/><Transition Identifier="u1" Source="m1" Target="m2"/></TransitionList>`,
    ),
  );
  fs.writeFileSync(
    path.join(rules, "profond.rfl"),
    flowXml(
      "profond",
      "rfl-deep",
      `<TaskList><StartTask Identifier="a"/><RuleTask ExecutionMode="Fastpath" Identifier="output"><RuleList><Package Name="output"/></RuleList></RuleTask><StopTask Identifier="z"/></TaskList>
       <NodeList><TaskNode Identifier="k0" Task="a"/><TaskNode Identifier="k1" Task="output"/><TaskNode Identifier="k2" Task="z"/></NodeList>
       <TransitionList><Transition Identifier="v0" Source="k0" Target="k1"/><Transition Identifier="v1" Source="k1" Target="k2"/></TransitionList>`,
    ),
  );
  // an operation that runs the top ruleflow
  fs.mkdirSync(path.join(dir, "Credit", "deployment"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "Credit", "deployment", "decider.dop"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<com.ibm.rules.studio.model.decisionservice:Operation xmlns:com.ibm.rules.studio.model.decisionservice="http://com.ibm.rules.studio/model/decisionservice.ecore" rulesetName="credit" usingRuleflow="true" ruleflowName="principal"><name>decider</name><uuid>op-1</uuid><referencedVariables variableName="demande"/><ruleflow href="../règles/principal.rfl#rfl-main"/></com.ibm.rules.studio.model.decisionservice:Operation>\n`,
  );
  return path.join(dir, "Credit");
}

test("a rule two subflows deep carries every caller's condition, and the operation at the top", () => {
  const { kb } = buildWorkspace(nested());
  const rule = kb.findArtifact("montant eleve").artifact!;
  const runs = kb.runsDescription(rule);
  assert.equal(runs.runs, true);
  const line = runs.lines.join("\n");
  assert.match(line, /ruleflow 'principal' task 'sorties' → ruleflow 'sorties' task 'plus loin'/);
  assert.match(
    line,
    /le montant de 'la demande' est plus grand que 5000 and la duree mois de 'la demande' est plus grand que 12/,
  );
  const { operations } = kb.runPath(rule);
  assert.deepEqual(
    operations.map((id) => kb.model.artifacts.get(id)?.name),
    ["decider"],
  );

  const deep = (
    kb.getRuleflowPaths({ ruleflow: "profond" }) as {
      ruleflows: { runsAsSubflow?: { via: string[]; when: string; operations: string[] }[] }[];
    }
  ).ruleflows[0];
  assert.deepEqual(deep.runsAsSubflow?.[0].operations, ["decider"]);
  assert.match(deep.runsAsSubflow?.[0].when ?? "", /plus grand que 5000 and .*plus grand que 12/);
});

test("a subflow called only from an unreachable task does not run", () => {
  const { kb } = buildWorkspace(nested(true));
  const rule = kb.findArtifact("montant eleve").artifact!;
  const runs = kb.runsDescription(rule);
  assert.equal(runs.runs, false, runs.lines.join("\n"));
  assert.match(runs.lines.join("\n"), /no path from its start reaches/);
});
