/**
 * Quality gates. These are the expensive, thorough checks: `rulebase check`
 * and CI run them. Indexing never skips a check to go faster; it simply does
 * not run these on every keystroke.
 */
import type { KnowledgeBase } from "./kb.ts";
import { RULE_KINDS } from "./model.ts";

export interface Gate {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
  failures?: string[];
}

export function runGates(kb: KnowledgeBase): Gate[] {
  const gates: Gate[] = [];
  const rules = kb.rules();
  const errors = kb.warnings().filter((warning) => warning.severity === "error");
  const add = (id: string, label: string, failures: string[], ok: string) =>
    gates.push({ id, label, pass: failures.length === 0, detail: failures.length ? `${failures.length} problem(s)` : ok, ...(failures.length ? { failures: failures.slice(0, 50) } : {}) });

  add("parse", "Every file parses, or is reported", errors.map((warning) => `${warning.path}: ${warning.message}`), `${kb.meta.files} files, no errors`);

  add(
    "provenance",
    "Every rule has a UUID and a path",
    rules.filter((rule) => !rule.provenance.uuid || !rule.provenance.path).map((rule) => rule.provenance.path),
    `${rules.length} rules`,
  );

  const flows = [...kb.model.artifacts.values()].filter((item) => item.type === "ruleflow");
  const unselected = flows.length
    ? rules.filter((rule) => !kb.runPath(rule).selectedBy.length).map((rule) => `${rule.package}.${rule.name}`)
    : [];
  gates.push({
    id: "selection",
    label: "Every rule is selected by a ruleflow task",
    pass: true,
    detail: unselected.length ? `${unselected.length} rule(s) are never selected (reported, not a failure)` : flows.length ? "all rules selected" : "no ruleflow: all rules run",
    ...(unselected.length ? { failures: unselected.slice(0, 50) } : {}),
  });

  add(
    "tables",
    "Every decision table has rows",
    rules.filter((rule) => rule.type === "decisionTable" && !(rule.rows?.length)).map((rule) => rule.provenance.path),
    `${rules.filter((rule) => rule.type === "decisionTable").reduce((sum, rule) => sum + (rule.rows?.length ?? 0), 0)} rows`,
  );

  const verbalized = new Set([...kb.model.phrases.values()].map((phrase) => phrase.memberId));
  const unverbalized = [...kb.model.members.values()].filter((member) => member.kind !== "constructor" && !verbalized.has(member.id));
  gates.push({
    id: "vocabulary",
    label: "Vocabulary resolves to the BOM",
    pass: !errors.some((warning) => warning.path.endsWith(".voc")),
    detail: `${kb.model.phrases.size} phrases, ${unverbalized.length} members without a verbalization (allowed)`,
  });

  const virtualClassesWithoutB2x = [...kb.model.classes.values()].filter(
    (klass) => klass.virtual && !klass.executionName && (kb.model.membersByClass.get(klass.fqn) ?? []).some((member) => !member.virtual && member.kind !== "constructor"),
  );
  gates.push({
    id: "virtual",
    label: "Virtual members have B2X",
    pass: true,
    detail: virtualClassesWithoutB2x.length
      ? `${virtualClassesWithoutB2x.length} class(es) are in a BOM entry with no XOM origin and have members without B2X (reported)`
      : `${[...kb.model.members.values()].filter((member) => member.virtual).length} virtual members`,
    ...(virtualClassesWithoutB2x.length ? { failures: virtualClassesWithoutB2x.map((klass) => klass.fqn).slice(0, 50) } : {}),
  });

  let unresolved = 0;
  let total = 0;
  for (const rule of rules) {
    for (const use of kb.model.uses.get(rule.id) ?? []) {
      if (use.target.startsWith("var:")) continue;
      total++;
      if (!use.resolved) unresolved++;
    }
  }
  gates.push({
    id: "typing",
    label: "Term uses have a typed subject",
    pass: true,
    detail: total ? `${total - unresolved}/${total} typed (${Math.round(((total - unresolved) / total) * 100)}%); untyped uses are kept for every candidate owner` : "no term uses",
  });

  const misses: string[] = [];
  for (const rule of rules.filter((item) => RULE_KINDS.includes(item.type as never))) {
    const top = kb.searchRules(rule.name, 5);
    if (!top.some((hit) => hit.id === rule.id)) misses.push(`${rule.package}.${rule.name}`);
  }
  const recall = rules.length ? (rules.length - misses.length) / rules.length : 1;
  gates.push({
    id: "recall",
    label: "Name search recall@5 ≥ 95%",
    pass: recall >= 0.95,
    detail: `${Math.round(recall * 1000) / 10}% of ${rules.length} rules are in the top 5 for their own name`,
    ...(misses.length ? { failures: misses.slice(0, 50) } : {}),
  });
  return gates;
}
