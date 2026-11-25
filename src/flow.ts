/**
 * Ruleflow analysis: order, reachability and the conditions on every path to a task.
 *
 * A ruleflow is a graph of tasks joined by transitions. A transition may carry a
 * condition. When some of a task's outgoing transitions have conditions and one
 * does not, the unconditioned one is the "otherwise" branch: it is taken only when
 * none of the others apply. Fork nodes start all their branches; a join waits for
 * them. Conditions are kept as BAL text, not evaluated.
 */
import type { Artifact, FlowTask } from "./model.ts";

export interface TaskAnalysis {
  id: string;
  kind: FlowTask["kind"];
  /** Position in running order: the longest number of steps from a start task (0 = start). Null when unreachable. */
  order: number | null;
  predecessors: string[];
  successors: string[];
  /** Every task that can run before this one / after it (transitively). */
  before: string[];
  after: string[];
  /** Each path from a start task, as the conditions taken along it. An empty path means "always reached". */
  paths: string[][];
  /** True when there were more paths than could be listed. */
  pathsTruncated: boolean;
  reachable: boolean;
  /** Reached on at least one path with no condition at all. */
  always: boolean;
}

export interface FlowAnalysis {
  starts: string[];
  stops: string[];
  tasks: Map<string, TaskAnalysis>;
  unreachable: string[];
  /** A transition goes back to an earlier task (a loop). */
  hasCycle: boolean;
}

const MAX_PATHS = 25;
const MAX_DEPTH = 200;

export function analyzeFlow(flow: Artifact): FlowAnalysis {
  const tasks = flow.tasks ?? [];
  const transitions = flow.transitions ?? [];
  const ids = new Set(tasks.map((task) => task.id));
  const kindOf = new Map(tasks.map((task) => [task.id, task.kind]));
  const out = new Map<string, { target: string; guard?: string }[]>();
  const inn = new Map<string, string[]>();
  for (const id of ids) {
    out.set(id, []);
    inn.set(id, []);
  }
  // Guards per source: a conditioned transition is its condition; an unconditioned one beside conditioned
  // siblings is "otherwise". Fork outputs are never guarded.
  const bySource = new Map<string, typeof transitions>();
  for (const transition of transitions) {
    if (!ids.has(transition.source) || !ids.has(transition.target)) continue;
    bySource.set(transition.source, [...(bySource.get(transition.source) ?? []), transition]);
  }
  for (const [source, list] of bySource) {
    const conditioned = list.filter((item) => item.condition).map((item) => (item.condition as string).replace(/\s+/g, " ").trim());
    for (const transition of list) {
      let guard: string | undefined;
      if (kindOf.get(source) !== "fork") {
        if (transition.condition) guard = transition.condition.replace(/\s+/g, " ").trim();
        else if (conditioned.length) guard = `otherwise (none of: ${conditioned.join("; ")})`;
      }
      out.get(source)?.push({ target: transition.target, ...(guard ? { guard } : {}) });
      inn.get(transition.target)?.push(source);
    }
  }

  const declaredStarts = tasks.filter((task) => task.kind === "start").map((task) => task.id);
  const starts = declaredStarts.length ? declaredStarts : [...ids].filter((id) => !(inn.get(id) ?? []).length);
  const stops = tasks.filter((task) => task.kind === "stop").map((task) => task.id);

  // Paths with their guards (depth-first, no task twice on one path).
  const paths = new Map<string, Map<string, string[]>>();
  const truncated = new Set<string>();
  let hasCycle = false;
  const walk = (node: string, guards: string[], seen: Set<string>, depth: number) => {
    const list = paths.get(node) ?? new Map<string, string[]>();
    const key = guards.join("\u0001");
    if (!list.has(key)) {
      if (list.size >= MAX_PATHS) truncated.add(node);
      else list.set(key, guards);
    }
    paths.set(node, list);
    if (depth > MAX_DEPTH) return;
    for (const edge of out.get(node) ?? []) {
      if (seen.has(edge.target)) {
        hasCycle = true;
        continue;
      }
      // Once a node has its maximum number of paths, don't explode further through it.
      if (truncated.has(edge.target) && (paths.get(edge.target)?.size ?? 0) >= MAX_PATHS) continue;
      seen.add(edge.target);
      walk(edge.target, edge.guard ? [...guards, edge.guard] : guards, seen, depth + 1);
      seen.delete(edge.target);
    }
  };
  for (const start of starts) walk(start, [], new Set([start]), 0);

  // Running order: longest distance from a start, along edges that don't close a loop.
  const order = new Map<string, number>();
  const visiting = new Set<string>();
  const doneDfs = new Set<string>();
  const backEdge = new Set<string>();
  const dfs = (node: string) => {
    visiting.add(node);
    for (const edge of out.get(node) ?? []) {
      if (visiting.has(edge.target)) backEdge.add(`${node}->${edge.target}`);
      else if (!doneDfs.has(edge.target)) dfs(edge.target);
    }
    visiting.delete(node);
    doneDfs.add(node);
  };
  for (const start of starts) if (!doneDfs.has(start)) dfs(start);
  const reachable = new Set(paths.keys());
  const indegree = new Map<string, number>();
  for (const id of reachable) indegree.set(id, 0);
  for (const id of reachable) for (const edge of out.get(id) ?? []) if (!backEdge.has(`${id}->${edge.target}`) && reachable.has(edge.target)) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  const queue = [...reachable].filter((id) => (indegree.get(id) ?? 0) === 0);
  for (const id of queue) order.set(id, 0);
  while (queue.length) {
    const node = queue.shift() as string;
    for (const edge of out.get(node) ?? []) {
      if (backEdge.has(`${node}->${edge.target}`) || !reachable.has(edge.target)) continue;
      order.set(edge.target, Math.max(order.get(edge.target) ?? 0, (order.get(node) ?? 0) + 1));
      indegree.set(edge.target, (indegree.get(edge.target) ?? 1) - 1);
      if (indegree.get(edge.target) === 0) queue.push(edge.target);
    }
  }

  const closure = (start: string, next: (id: string) => string[]) => {
    const seen = new Set<string>();
    const stack = [...next(start)];
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id) || id === start) continue;
      seen.add(id);
      stack.push(...next(id));
    }
    return [...seen].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0) || a.localeCompare(b));
  };

  const result = new Map<string, TaskAnalysis>();
  for (const task of tasks) {
    const taskPaths = simplify([...(paths.get(task.id)?.values() ?? [])]);
    result.set(task.id, {
      id: task.id,
      kind: task.kind,
      order: order.has(task.id) ? (order.get(task.id) as number) : null,
      predecessors: [...new Set(inn.get(task.id) ?? [])],
      successors: [...new Set((out.get(task.id) ?? []).map((edge) => edge.target))],
      before: closure(task.id, (id) => inn.get(id) ?? []),
      after: closure(task.id, (id) => (out.get(id) ?? []).map((edge) => edge.target)),
      paths: taskPaths,
      pathsTruncated: truncated.has(task.id),
      reachable: reachable.has(task.id),
      always: taskPaths.some((path) => path.length === 0),
    });
  }
  return {
    starts,
    stops,
    tasks: result,
    unreachable: tasks.filter((task) => !reachable.has(task.id)).map((task) => task.id),
    hasCycle,
  };
}

/**
 * Where branches rejoin, `P and c` plus `P and otherwise (none of: c)` together mean just `P`.
 * Repeated until nothing changes, so nested branches collapse too.
 */
function simplify(input: string[][]): string[][] {
  let list = input.map((path) => [...path]);
  for (let changed = true; changed; ) {
    changed = false;
    const groups = new Map<string, string[][]>();
    for (const path of list) {
      if (!path.length) continue;
      const key = path.slice(0, -1).join("\u0001");
      groups.set(key, [...(groups.get(key) ?? []), path]);
    }
    for (const [key, group] of groups) {
      const lasts = new Set(group.map((path) => path[path.length - 1]));
      for (const last of lasts) {
        const match = /^otherwise \(none of: (.*)\)$/.exec(last);
        if (!match) continue;
        const siblings = match[1].split("; ");
        if (!siblings.every((condition) => lasts.has(condition))) continue;
        const prefix = key ? key.split("\u0001") : [];
        const covered = new Set([last, ...siblings]);
        list = list.filter((path) => !(path.length === prefix.length + 1 && path.slice(0, -1).join("\u0001") === key && covered.has(path[path.length - 1])));
        list.push(prefix);
        changed = true;
        break;
      }
      if (changed) break;
    }
  }
  const seen = new Set<string>();
  return list.filter((path) => {
    const id = path.join("\u0001");
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** "always", or "A", or "(A) or (B and C)". */
export function describePaths(analysis: TaskAnalysis): string {
  if (!analysis.reachable) return "never: no path from the start reaches this task";
  if (analysis.always) return "always";
  const parts = analysis.paths.map((path) => path.join(" and "));
  const text = parts.length === 1 ? parts[0] : parts.map((part) => `(${part})`).join(" or ");
  return analysis.pathsTruncated ? `${text} or … (more paths)` : text;
}

/** What ODM's task settings mean, in words, for someone changing the flow. */
export function describeTaskSettings(task: FlowTask): string[] {
  const notes: string[] = [];
  const algorithm = (task.algorithm ?? "").toLowerCase();
  if (algorithm === "reteplus" || algorithm === "default") {
    notes.push("RetePlus: inference. An action that changes data can make other rules in this task eligible again; rule priority decides the order.");
  } else if (algorithm === "fastpath") {
    notes.push("Fastpath: rules are matched once against the data; changes made by actions do not re-trigger rules in this task.");
  } else if (algorithm === "sequential") {
    notes.push("Sequential: each rule is tried once, in order; changes made by actions do not re-trigger rules.");
  }
  const exit = (task.exitCriteria ?? "").toLowerCase();
  if (exit === "rule" || exit === "ruleinstance") {
    notes.push(`Exit criteria ${task.exitCriteria}: the task stops after the first rule (or rule instance) fires, so the order of rules matters.`);
  }
  if (task.filter) notes.push(`Runtime selection filter: ${task.filter}. Which rules run is decided at run time; Rulebase lists every rule of the selected packages.`);
  return notes;
}
