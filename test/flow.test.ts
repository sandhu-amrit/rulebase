import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { analyzeFlow, describePaths } from "../src/flow.ts";
import { buildWorkspace } from "../src/indexer.ts";
import type { Artifact, FlowTask } from "../src/model.ts";
import { ACME, built, CLASSIC, copyTree, I18N, MINILOAN, tempDir } from "./helpers.ts";

const task = (id: string, kind: FlowTask["kind"] = "rule"): FlowTask => ({
  id,
  kind,
  packages: [],
  rules: [],
});
const flow = (tasks: FlowTask[], transitions: [string, string, string?][]): Artifact => ({
  id: "f",
  type: "ruleflow",
  name: "f",
  package: "",
  provenance: { project: "p", path: "f.rfl" },
  tasks,
  transitions: transitions.map(([source, target, condition], i) => ({
    id: `t${i}`,
    source,
    target,
    ...(condition ? { condition } : {}),
  })),
});

test("conditions accumulate along a path; the unconditioned sibling is 'otherwise'", () => {
  const analysis = analyzeFlow(
    flow(
      [task("s", "start"), task("a"), task("b"), task("c"), task("e", "stop")],
      [
        ["s", "a"],
        ["a", "b", "x is valid"],
        ["a", "e"],
        ["b", "c", "y is approved"],
        ["b", "e"],
        ["c", "e"],
      ],
    ),
  );
  assert.equal(describePaths(analysis.tasks.get("a")!), "always");
  assert.equal(describePaths(analysis.tasks.get("b")!), "x is valid");
  assert.equal(describePaths(analysis.tasks.get("c")!), "x is valid and y is approved");
  assert.equal(
    describePaths(analysis.tasks.get("e")!),
    "always",
    "every branch rejoins at the stop",
  );
  assert.deepEqual(
    [...analysis.tasks.values()].map((item) => [item.id, item.order]),
    [
      ["s", 0],
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["e", 4],
    ],
  );
  assert.deepEqual(analysis.tasks.get("c")!.before, ["s", "a", "b"]);
});

test("a task only reached on the 'otherwise' branch says so", () => {
  const analysis = analyzeFlow(
    flow(
      [task("s", "start"), task("ok"), task("ko")],
      [
        ["s", "ok", "x is valid"],
        ["s", "ko"],
      ],
    ),
  );
  assert.equal(describePaths(analysis.tasks.get("ko")!), "otherwise (none of: x is valid)");
});

test("unreachable tasks and loops are reported", () => {
  const analysis = analyzeFlow(
    flow(
      [task("s", "start"), task("a"), task("b"), task("orphan")],
      [
        ["s", "a"],
        ["a", "b"],
        ["b", "a", "retry"],
      ],
    ),
  );
  assert.deepEqual(analysis.unreachable, ["orphan"]);
  assert.equal(
    describePaths(analysis.tasks.get("orphan")!),
    "never: no path from the start reaches this task",
  );
  assert.equal(analysis.hasCycle, true);
  assert.equal(analysis.tasks.get("b")!.order, 2);
});

test("Miniloan: eligibility runs only for approved loans, and the reason says so", () => {
  const { kb } = built(MINILOAN);
  const [miniloan] = (
    kb.getRuleflowPaths({ ruleflow: "miniloan" }) as {
      ruleflows: {
        tasks: { task: string; order: number; reachedWhen: string; rules?: number }[];
      }[];
    }
  ).ruleflows;
  const eligibility = miniloan.tasks.find((item) => item.task === "eligibility")!;
  assert.equal(eligibility.reachedWhen, "'the loan' is approved");
  assert.equal(eligibility.rules, 3);
  assert.equal(miniloan.tasks.find((item) => item.task === "task_2")!.reachedWhen, "always");
  const rule = kb.findArtifact("minimum income").artifact!;
  assert.match(kb.runsDescription(rule).lines[0], /reached when: 'the loan' is approved/);
});

test("fork branches run at the same order; a subflow shows who calls it", () => {
  const { kb: classic } = built(CLASSIC);
  const [shop] = (
    classic.getRuleflowPaths({}) as { ruleflows: { tasks: { task: string; order: number }[] }[] }
  ).ruleflows;
  const order = Object.fromEntries(shop.tasks.map((item) => [item.task, item.order]));
  assert.equal(order.Tiers, order.Offers);
  assert.ok(order.n4 > order.Tiers, "join after both branches");

  const { kb } = buildWorkspace(path.join(I18N, "Credit"));
  const sub = (
    kb.getRuleflowPaths({ ruleflow: "sorties" }) as {
      ruleflows: { calledFrom?: { ruleflow: string; task: string }[] }[];
    }
  ).ruleflows[0];
  assert.deepEqual(
    sub.calledFrom?.map((item) => `${item.ruleflow}#${item.task}`),
    ["principal#sorties"],
  );
});

test("acme: notes explain the algorithm; operations that run the flow are listed", () => {
  const { kb } = built(ACME);
  const [main] = (
    kb.getRuleflowPaths({ ruleflow: "main" }) as {
      ruleflows: {
        runBy: string[];
        tasks: { task: string; notes?: string[]; reachedWhen: string }[];
      }[];
    }
  ).ruleflows;
  assert.deepEqual(main.runBy, ["operation 'Loan Operation'"]);
  const score = main.tasks.find((item) => item.task === "score")!;
  assert.equal(score.reachedWhen, "'the loan' is approved");
  assert.match(score.notes?.[0] ?? "", /RetePlus/);
});

test("a rule selected only by an unreachable task does not run", () => {
  const dir = tempDir();
  copyTree(MINILOAN, path.join(dir, "ws"));
  const file = path.join(dir, "ws", "rules", "miniloan.rfl");
  // cut the validation task off from the start: the start now goes straight to the stop task
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace('Source="node_0" Target="node_2"', 'Source="node_0" Target="node_1"'),
  );
  const { kb } = buildWorkspace(path.join(dir, "ws"));
  const rule = kb.findArtifact("maximum amount").artifact!;
  const runs = kb.runsDescription(rule);
  assert.equal(runs.runs, false);
  assert.match(runs.lines.join("\n"), /no path from the start reaches/);
});
