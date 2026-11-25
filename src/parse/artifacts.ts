/**
 * Parsers for Rule Designer artifact files. Each function is pure: one file in,
 * artifacts and warnings out. That is what lets reindex cache by content hash.
 */
import type { Artifact, FlowTask, FlowTransition, Provenance, TableCell, TableColumn, TableRow, Variable, Warning } from "../model.ts";
import { attr, child, children, parseXml, rootElement, scalar, textOf } from "./xml.ts";

export interface ArtifactFileResult {
  artifacts: Artifact[];
  warnings: Warning[];
}

/** Elements read explicitly; everything else that is a simple value becomes a property. */
const STRUCTURAL = new Set(["name", "uuid", "locale", "definition", "rfModel", "body", "documentation", "status", "priority"]);

export function parseArtifactFile(content: string, provenance: Provenance, packageName: string): ArtifactFileResult {
  const warnings: Warning[] = [];
  let doc: unknown;
  try {
    doc = parseXml(content);
  } catch (error) {
    warnings.push({ path: provenance.path, severity: "error", message: `not well-formed XML: ${errorText(error)}` });
    return { artifacts: [], warnings };
  }
  const root = rootElement(doc);
  if (!root) {
    warnings.push({ path: provenance.path, severity: "error", message: "no XML root element" });
    return { artifacts: [], warnings };
  }
  const ext = extensionOf(provenance.path);
  const ctx: Ctx = { node: root.node, provenance, packageName, warnings };
  switch (ext) {
    case ".brl":
      return { artifacts: [actionRule(ctx)], warnings };
    case ".dta":
      return { artifacts: [decisionTable(ctx)], warnings };
    case ".dtr":
      return { artifacts: [decisionTree(ctx)], warnings };
    case ".trl":
      return { artifacts: [codeArtifact(ctx, "technicalRule")], warnings };
    case ".fct":
      return { artifacts: [codeArtifact(ctx, "function")], warnings };
    case ".rfl":
      return { artifacts: [ruleflow(ctx)], warnings };
    case ".dop":
      return { artifacts: [operation(ctx)], warnings };
    case ".var":
      return { artifacts: [variableSet(ctx)], warnings };
    case ".rulepackage":
      return { artifacts: [rulePackage(ctx)], warnings };
    default:
      warnings.push({ path: provenance.path, severity: "error", message: `no parser for '${ext}' (root <${root.name}>)` });
      return { artifacts: [], warnings };
  }
}

interface Ctx {
  node: Record<string, unknown>;
  provenance: Provenance;
  packageName: string;
  warnings: Warning[];
}

function base(ctx: Ctx, type: Artifact["type"]): Artifact {
  const uuid = scalar(ctx.node, "uuid");
  const fileName = ctx.provenance.path.split("/").pop() ?? ctx.provenance.path;
  const name = scalar(ctx.node, "name") ?? fileName.replace(/\.[^.]+$/, "");
  const properties = simpleProperties(ctx.node);
  return {
    id: uuid ?? `path:${ctx.provenance.path}`,
    type,
    name,
    package: ctx.packageName,
    provenance: { ...ctx.provenance, uuid },
    status: scalar(ctx.node, "status"),
    locale: scalar(ctx.node, "locale"),
    priority: scalar(ctx.node, "priority"),
    documentation: scalar(ctx.node, "documentation"),
    properties: Object.keys(properties).length ? properties : undefined,
  };
}

/** Leaf elements such as `<effectiveDate>`, `<categories>`, `<expirationDate>`, and custom rule properties. */
function simpleProperties(node: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@") || key.startsWith("#")) continue;
    const local = key.slice(key.lastIndexOf(":") + 1);
    if (STRUCTURAL.has(local)) continue;
    const items = Array.isArray(value) ? value : [value];
    const texts: string[] = [];
    for (const item of items) {
      if (typeof item === "string") texts.push(item.trim());
      else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const keys = Object.keys(record).filter((k) => !k.startsWith("@"));
        if (keys.every((k) => k === "#text" || k === "#cdata")) texts.push(textOf(record).trim());
        else if (local === "properties" || local === "extensionProperties") {
          // `<properties key="..." value="..."/>` style extension properties
          const k = attr(record, "key") ?? attr(record, "name");
          const v = attr(record, "value") ?? textOf(record).trim();
          if (k) out[k] = v;
        }
      }
    }
    const joined = texts.filter(Boolean).join(", ");
    if (joined) out[local] = joined;
  }
  return out;
}

/** Split BAL into its parts. Keywords must start a line, as Rule Designer writes them. */
export function splitBal(bal: string): Pick<Artifact, "definitions" | "conditions" | "actions" | "elseActions"> {
  const text = bal.replace(/\r\n?/g, "\n");
  const re = /(?:^|\n)[ \t]*(definitions|if|then|else)(?=\s|$)/gi;
  const marks: { key: string; index: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    marks.push({ key: match[1].toLowerCase(), index: match.index, end: re.lastIndex });
  }
  const keyMap = { definitions: "definitions", if: "conditions", then: "actions", else: "elseActions" } as const;
  const out: Pick<Artifact, "definitions" | "conditions" | "actions" | "elseActions"> = {};
  for (let i = 0; i < marks.length; i++) {
    const body = text.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].index : text.length).trim();
    const key = keyMap[marks[i].key as keyof typeof keyMap];
    if (body) out[key] = out[key] ? `${out[key]}\n${body}` : body;
  }
  return out;
}

function actionRule(ctx: Ctx): Artifact {
  const artifact = base(ctx, "actionRule");
  const bal = textOf(child(ctx.node, "definition")).trim();
  if (!bal) ctx.warnings.push({ path: ctx.provenance.path, severity: "error", message: "action rule has no <definition>" });
  return { ...artifact, bal, ...splitBal(bal) };
}

function codeArtifact(ctx: Ctx, type: "technicalRule" | "function"): Artifact {
  const artifact = base(ctx, type);
  const irl = (textOf(child(ctx.node, "definition")) || textOf(child(ctx.node, "body"))).trim();
  if (!irl) ctx.warnings.push({ path: ctx.provenance.path, severity: "error", message: `${type} has no <definition> or <body>` });
  return { ...artifact, irl };
}

function decisionTree(ctx: Ctx): Artifact {
  const artifact = base(ctx, "decisionTree");
  const definition = child(ctx.node, "definition");
  // Decision tree structure is not modelled yet: every expression in it is kept as text,
  // so vocabulary use and search still see the whole tree.
  const texts: string[] = [];
  collectText(definition, texts);
  const bal = texts.map((item) => item.trim()).filter(Boolean).join("\n");
  ctx.warnings.push({
    path: ctx.provenance.path,
    severity: "info",
    message: "decision tree branches are indexed as text; node structure is not modelled",
  });
  if (!bal) ctx.warnings.push({ path: ctx.provenance.path, severity: "error", message: "decision tree has no readable content" });
  return { ...artifact, bal };
}

function collectText(node: unknown, out: string[]): void {
  if (node == null) return;
  if (typeof node === "string") {
    if (node.trim()) out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out);
    return;
  }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.startsWith("@")) continue;
      if (key === "Properties" || key.endsWith(":Properties") || key === "Resources") continue;
      collectText(value, out);
    }
  }
}

function fillTemplate(template: string, params: string[]): string {
  let index = 0;
  const filled = template.replace(/<[^<>\n]+>/g, () => params[index++] ?? "…");
  return filled.replace(/\s+/g, " ").trim();
}

function tableCell(columnId: string, expression: unknown, column: TableColumn | undefined, enabled: boolean): TableCell {
  const params = children(expression, "Param").map((param) => textOf(param).trim());
  const override = textOf(child(expression, "Text")).trim();
  const otherwise = /^otherwise$/i.test(override) || attr(expression, "Otherwise") === "true";
  const template = override || column?.template || "";
  const text = params.length || override ? fillTemplate(template, params) : "";
  return { columnId, params, text, enabled, ...(otherwise ? { otherwise } : {}) };
}

function decisionTable(ctx: Ctx): Artifact {
  const artifact = base(ctx, "decisionTable");
  const definition = child(ctx.node, "definition");
  const dt = child(definition, "DT") ?? definition;
  const body = child(dt, "Body");
  const structure = child(body, "Structure");
  const columns: TableColumn[] = [];
  for (const kind of ["condition", "action"] as const) {
    const group = kind === "condition" ? "ConditionDefinitions" : "ActionDefinitions";
    const item = kind === "condition" ? "ConditionDefinition" : "ActionDefinition";
    for (const def of children(child(structure, group), item)) {
      columns.push({
        id: attr(def, "Id") ?? `${kind === "condition" ? "C" : "A"}${columns.length}`,
        kind,
        template: textOf(child(child(def, "ExpressionDefinition"), "Text")).trim(),
        title: attr(def, "Title") ?? undefined,
      });
    }
  }
  const byId = new Map(columns.map((column) => [column.id, column]));
  const rows: TableRow[] = [];
  const walk = (partition: unknown, prefix: TableCell[]) => {
    const defId = attr(partition, "DefId") ?? "";
    for (const condition of children(partition, "Condition")) {
      const current = tableCell(defId, child(condition, "Expression"), byId.get(defId), true);
      const path = [...prefix, current];
      for (const nested of children(condition, "Partition")) walk(nested, path);
      for (const actionSet of children(condition, "ActionSet")) {
        const actions = children(actionSet, "Action").map((action) => {
          const id = attr(action, "DefId") ?? "";
          return tableCell(id, child(action, "Expression"), byId.get(id), attr(action, "Enabled") !== "false");
        });
        const summary = [
          ...path.filter((cell) => cell.text).map((cell) => cell.text),
          ...actions.filter((cell) => cell.enabled && cell.text).map((cell) => cell.text),
        ].join(" · ");
        rows.push({ index: rows.length + 1, conditions: path, actions, summary });
      }
    }
  };
  const contents = child(body, "Contents");
  for (const partition of children(contents, "Partition")) walk(partition, []);
  // Tables with only action columns keep their rows as bare ActionSets.
  for (const actionSet of children(contents, "ActionSet")) {
    const actions = children(actionSet, "Action").map((action) => {
      const id = attr(action, "DefId") ?? "";
      return tableCell(id, child(action, "Expression"), byId.get(id), attr(action, "Enabled") !== "false");
    });
    rows.push({ index: rows.length + 1, conditions: [], actions, summary: actions.map((cell) => cell.text).join(" · ") });
  }
  const preconditions = textOf(child(child(body, "Preconditions"), "Text")).trim() || undefined;
  if (!columns.length) ctx.warnings.push({ path: ctx.provenance.path, severity: "error", message: "decision table has no column definitions" });
  if (!rows.length) ctx.warnings.push({ path: ctx.provenance.path, severity: "error", message: "decision table has no rows" });
  const expected = countActionSets(contents);
  if (expected !== rows.length) {
    ctx.warnings.push({
      path: ctx.provenance.path,
      severity: "error",
      message: `decision table row count mismatch: ${rows.length} rows read, ${expected} action sets in the file`,
    });
  }
  return { ...artifact, columns, rows, preconditions };
}

/** Independent count used to cross-check the row walk. */
function countActionSets(node: unknown): number {
  if (node == null || typeof node !== "object") return 0;
  if (Array.isArray(node)) return node.reduce((sum: number, item) => sum + countActionSets(item), 0);
  let total = 0;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith("@") || key.startsWith("#")) continue;
    const local = key.slice(key.lastIndexOf(":") + 1);
    if (local === "ActionSet") total += Array.isArray(value) ? value.length : 1;
    else total += countActionSets(value);
  }
  return total;
}

const TASK_KINDS: Record<string, FlowTask["kind"]> = {
  StartTask: "start",
  RuleTask: "rule",
  ActionTask: "action",
  SubflowTask: "subflow",
  StopTask: "stop",
  ForkTask: "fork",
  JoinTask: "join",
  BranchTask: "branch",
};

function ruleflow(ctx: Ctx): Artifact {
  const artifact = base(ctx, "ruleflow");
  const model = child(child(ctx.node, "rfModel"), "Ruleflow") ?? child(ctx.node, "Ruleflow");
  if (!model) {
    ctx.warnings.push({ path: ctx.provenance.path, severity: "error", message: "ruleflow has no <Ruleflow> model" });
    return { ...artifact, tasks: [], transitions: [] };
  }
  const body = child(model, "Body");
  const taskList = child(body, "TaskList");
  const tasks: FlowTask[] = [];
  for (const [key, value] of Object.entries(taskList ?? {})) {
    if (key.startsWith("@") || key.startsWith("#")) continue;
    const local = key.slice(key.lastIndexOf(":") + 1);
    const kind = TASK_KINDS[local];
    if (!kind) {
      ctx.warnings.push({ path: ctx.provenance.path, severity: "error", message: `ruleflow task type <${local}> is not understood` });
      continue;
    }
    for (const raw of Array.isArray(value) ? value : [value]) tasks.push(flowTask(kind, raw, ctx));
  }
  const nodeToTask = new Map<string, string>();
  for (const node of children(child(body, "NodeList"), "TaskNode")) {
    const id = attr(node, "Identifier");
    const task = attr(node, "Task");
    if (id && task) nodeToTask.set(id, task);
  }
  const transitions: FlowTransition[] = children(child(body, "TransitionList"), "Transition").map((item) => {
    const source = attr(item, "Source") ?? "";
    const target = attr(item, "Target") ?? "";
    const condition = textOf(child(item, "Conditions")).trim();
    return {
      id: attr(item, "Identifier") ?? "",
      source: nodeToTask.get(source) ?? source,
      target: nodeToTask.get(target) ?? target,
      ...(condition ? { condition } : {}),
    };
  });
  const known = new Set(tasks.map((task) => task.id));
  for (const transition of transitions) {
    for (const end of [transition.source, transition.target]) {
      if (end && !known.has(end)) {
        ctx.warnings.push({ path: ctx.provenance.path, severity: "error", message: `transition ${transition.id} points at unknown task '${end}'` });
      }
    }
  }
  return { ...artifact, tasks, transitions };
}

function flowTask(kind: FlowTask["kind"], raw: unknown, ctx: Ctx): FlowTask {
  const ruleList = child(raw, "RuleList");
  const packages = children(ruleList, "Package").map((item) => attr(item, "Name") ?? textOf(item).trim()).filter(Boolean);
  const rules = children(ruleList, "Rule").map((item) => attr(item, "Name") ?? attr(item, "Uuid") ?? textOf(item).trim()).filter(Boolean);
  const filterNode = child(raw, "Filter") ?? child(raw, "Select") ?? child(raw, "RuntimeSelection") ?? child(raw, "Selection");
  const filter = textOf(filterNode).trim();
  const actions = ["InitialActions", "FinalActions", "Actions"]
    .map((name) => {
      const text = textOf(child(raw, name)).trim();
      return text ? `${name === "Actions" ? "" : `${name}: `}${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
  const subflow = kind === "subflow" ? (attr(raw, "Ruleflow") ?? attr(raw, "FlowName") ?? attr(raw, "Flow") ?? scalar(raw, "Ruleflow")) : undefined;
  if (kind === "subflow" && !subflow) {
    ctx.warnings.push({ path: ctx.provenance.path, severity: "error", message: `subflow task '${attr(raw, "Identifier") ?? "?"}' has no readable target` });
  }
  if (kind === "rule" && !packages.length && !rules.length && !filter) {
    ctx.warnings.push({ path: ctx.provenance.path, severity: "info", message: `rule task '${attr(raw, "Identifier") ?? "?"}' selects nothing` });
  }
  return {
    id: attr(raw, "Identifier") ?? attr(raw, "Name") ?? kind,
    kind,
    packages,
    rules,
    algorithm: attr(raw, "ExecutionMode") ?? attr(raw, "Algorithm"),
    ordering: attr(raw, "Ordering"),
    exitCriteria: attr(raw, "ExitCriteria"),
    ...(filter ? { filter } : {}),
    ...(filterNode ? { dynamic: attr(filterNode, "Dynamic") === "true" } : {}),
    ...(actions ? { actions } : {}),
    ...(subflow ? { subflow } : {}),
  };
}

function operation(ctx: Ctx): Artifact {
  const artifact = base(ctx, "decisionOperation");
  const href = attr(child(ctx.node, "ruleflow"), "href") ?? "";
  const signature = children(ctx.node, "referencedVariables").map((item) => {
    const direction = (attr(item, "direction") ?? "IN").toUpperCase();
    return {
      name: attr(item, "variableName") ?? "",
      direction: (direction === "OUT" || direction === "IN_OUT" ? direction : "IN") as "IN" | "OUT" | "IN_OUT",
      variableSet: attr(item, "variableSetName"),
    };
  });
  const usesRuleflow = attr(ctx.node, "usingRuleflow") !== "false";
  if (usesRuleflow && !href && !attr(ctx.node, "ruleflowName")) {
    ctx.warnings.push({ path: ctx.provenance.path, severity: "error", message: "decision operation names no ruleflow" });
  }
  return {
    ...artifact,
    operation: {
      rulesetName: attr(ctx.node, "rulesetName"),
      ruleflowName: attr(ctx.node, "ruleflowName"),
      ruleflowUuid: href.includes("#") ? decodeURIComponent(href.slice(href.indexOf("#") + 1)) : undefined,
      targetProject: attr(ctx.node, "targetRuleProjectName"),
      signature,
    },
  };
}

function variableSet(ctx: Ctx): Artifact {
  const artifact = base(ctx, "variableSet");
  const variables: Variable[] = children(ctx.node, "variables").map((item) => {
    const name = attr(item, "name") ?? "";
    return {
      name,
      type: attr(item, "type") ?? "",
      verbalization: attr(item, "verbalization") ?? name,
      initialValue: attr(item, "initialValue") || undefined,
      provenance: { ...ctx.provenance, uuid: artifact.provenance.uuid },
    };
  });
  for (const variable of variables) {
    if (!variable.type) ctx.warnings.push({ path: ctx.provenance.path, severity: "error", message: `variable '${variable.name}' has no type` });
  }
  return { ...artifact, variables };
}

function rulePackage(ctx: Ctx): Artifact {
  const artifact = base(ctx, "package");
  // The package's qualified name comes from its folder, not its <name> (which is the last segment).
  return { ...artifact, id: `pkg:${ctx.packageName}`, name: ctx.packageName || artifact.name };
}

export function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
