import type { Artifact, FlowTask, SourceFile, TableCell, TableColumn, TableRow, VocabTerm } from "./types.ts";
import { asArray, attr, child, rootElement, scalar, textOf, xmlParser } from "./xml.ts";

export interface RawExtract {
  artifacts: Artifact[];
  terms: VocabTerm[];
  warnings: string[];
  projectName: string;
  decisionService?: string;
}

function packageFromPath(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  const marker = "/rules/";
  const at = norm.toLowerCase().lastIndexOf(marker);
  const rel = at >= 0 ? norm.slice(at + marker.length) : norm.replace(/^rules\//i, "");
  const parts = rel.split("/");
  parts.pop();
  return parts.filter((part) => part && part !== ".").join(".");
}

function splitBal(bal: string): Pick<Artifact, "definitions" | "conditions" | "actions" | "elseActions"> {
  const text = bal.replace(/\r\n/g, "\n");
  const re = /(?:^|\n)[ \t]*(definitions|if|then|else)\b[ \t]*/gi;
  const marks: { key: string; index: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    marks.push({ key: match[1].toLowerCase(), index: match.index, end: re.lastIndex });
  }
  const keyMap: Record<string, "definitions" | "conditions" | "actions" | "elseActions"> = {
    definitions: "definitions",
    if: "conditions",
    then: "actions",
    else: "elseActions",
  };
  const out: Pick<Artifact, "definitions" | "conditions" | "actions" | "elseActions"> = {};
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].end;
    const stop = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const key = keyMap[marks[i].key];
    const body = text.slice(start, stop).trim();
    if (body) out[key] = body;
  }
  return out;
}

function fillTemplate(template: string, params: string[]): string {
  let index = 0;
  const filled = template.replace(/<[^>\n]+>/g, () => params[index++] ?? "…");
  return filled.replace(/\s+/g, " ").trim();
}

function baseArtifact(
  partial: Omit<Artifact, "vocabularyTermsUsed" | "objectsReferenced" | "decisionServices" | "package"> & {
    package?: string;
    decisionServices?: string[];
  },
): Artifact {
  return {
    ...partial,
    package: partial.package ?? "",
    vocabularyTermsUsed: [],
    objectsReferenced: [],
    decisionServices: partial.decisionServices ?? [],
  };
}

function parseBalArtifact(file: SourceFile, node: Record<string, unknown>, type: Artifact["type"]): Artifact {
  const bal = textOf(child(node, "definition")).trim();
  const priorityText = scalar(node, "priority") || attr(node, "priority");
  const priority = priorityText && Number.isFinite(Number(priorityText)) ? Number(priorityText) : undefined;
  return baseArtifact({
    id: scalar(node, "uuid") || `path:${file.path}`,
    type,
    name: scalar(node, "name") || file.path.split("/").pop() || file.path,
    package: packageFromPath(file.path),
    status: scalar(node, "status"),
    bal: bal || undefined,
    ...splitBal(bal),
    filePath: file.path,
    uuid: scalar(node, "uuid"),
    locale: scalar(node, "locale"),
    priority,
  });
}

function cell(columnId: string, expression: unknown, enabled = true): TableCell {
  const params = asArray(child(expression, "Param")).map((param) => textOf(param).trim()).filter((value) => value !== "");
  const override = textOf(child(expression, "Text")).trim();
  return { columnId, params, text: override, enabled };
}

function walkRows(
  partition: unknown,
  columns: Map<string, TableColumn>,
  prefix: TableCell[],
  rows: TableRow[],
): void {
  const defId = attr(partition, "DefId") ?? "";
  for (const condition of asArray(child(partition, "Condition"))) {
    const current = cell(defId, child(condition, "Expression"));
    const next = [...prefix, current];
    const nested = asArray(child(condition, "Partition"));
    if (nested.length) {
      for (const inner of nested) walkRows(inner, columns, next, rows);
    }
    const actionSet = child(condition, "ActionSet");
    if (!actionSet) continue;
    const actions = asArray(child(actionSet, "Action")).map((action) => {
      const parsed = cell(attr(action, "DefId") ?? "", child(action, "Expression"), attr(action, "Enabled") !== "false");
      return parsed;
    });
    const summary = [
      ...next.map((item) => renderCell(columns.get(item.columnId), item)),
      ...actions.filter((item) => item.enabled).map((item) => renderCell(columns.get(item.columnId), item)),
    ].join(" · ");
    rows.push({ index: rows.length + 1, conditions: next, actions, summary });
  }
}

function renderCell(column: TableColumn | undefined, item: TableCell): string {
  if (item.text) return fillTemplate(item.text, item.params);
  if (column) return fillTemplate(column.template, item.params);
  return item.params.join(", ");
}

function parseDecisionTable(file: SourceFile, node: Record<string, unknown>): Artifact {
  const definition = child(node, "definition");
  const dt = child(definition, "DT") ?? definition;
  const body = child(dt, "Body");
  const structure = child(body, "Structure");
  const columns: TableColumn[] = [];
  for (const condition of asArray(child(child(structure, "ConditionDefinitions"), "ConditionDefinition"))) {
    columns.push({
      id: attr(condition, "Id") ?? `C${columns.length}`,
      kind: "condition",
      template: textOf(child(child(condition, "ExpressionDefinition"), "Text")).trim(),
    });
  }
  for (const action of asArray(child(child(structure, "ActionDefinitions"), "ActionDefinition"))) {
    columns.push({
      id: attr(action, "Id") ?? `A${columns.length}`,
      kind: "action",
      template: textOf(child(child(action, "ExpressionDefinition"), "Text")).trim(),
    });
  }
  const columnMap = new Map(columns.map((column) => [column.id, column]));
  const rows: TableRow[] = [];
  for (const partition of asArray(child(child(body, "Contents"), "Partition"))) {
    walkRows(partition, columnMap, [], rows);
  }
  const preconditions = textOf(child(child(body, "Preconditions"), "Text")).trim();
  const bal = [
    preconditions ? `preconditions\n${preconditions}` : "",
    ...columns.map((column) => `${column.kind} ${column.id}: ${column.template}`),
    ...rows.map((row) => `row ${row.index}: ${row.summary}`),
  ]
    .filter(Boolean)
    .join("\n");
  return baseArtifact({
    id: scalar(node, "uuid") || `path:${file.path}`,
    type: "decisionTable",
    name: scalar(node, "name") || file.path,
    package: packageFromPath(file.path),
    status: scalar(node, "status"),
    bal,
    preconditions: preconditions || undefined,
    filePath: file.path,
    uuid: scalar(node, "uuid"),
    locale: scalar(node, "locale"),
    columns,
    rows,
  });
}

function parseRuleflow(file: SourceFile, node: Record<string, unknown>): Artifact {
  const model = child(child(node, "rfModel"), "Ruleflow") ?? child(node, "Ruleflow");
  const body = child(model, "Body");
  const taskList = child(body, "TaskList");
  const tasks: FlowTask[] = [];

  const pushTask = (kind: FlowTask["kind"], raw: unknown) => {
    const ruleList = child(raw, "RuleList");
    const packages = asArray(child(ruleList, "Package")).map((item) => attr(item, "Name") || textOf(item)).filter(Boolean);
    const rules = asArray(child(ruleList, "Rule")).map((item) => attr(item, "Name") || textOf(item)).filter(Boolean);
    const filterNode = child(raw, "Filter") ?? child(raw, "Select") ?? child(raw, "RuntimeSelection");
    const filter = textOf(filterNode).trim();
    tasks.push({
      identifier: attr(raw, "Identifier") || attr(raw, "Name") || kind,
      kind,
      packages,
      rules,
      algorithm: attr(raw, "ExecutionMode"),
      ordering: attr(raw, "Ordering"),
      exitCriteria: attr(raw, "ExitCriteria"),
      filter: filter || undefined,
      filterLanguage: attr(filterNode, "Language"),
      dynamic: attr(filterNode, "Dynamic") === "true" ? true : filter ? false : undefined,
      actions: textOf(child(raw, "Actions")).trim() || undefined,
    });
  };

  for (const task of asArray(child(taskList, "StartTask"))) pushTask("start", task);
  for (const task of asArray(child(taskList, "RuleTask"))) pushTask("rule", task);
  for (const task of asArray(child(taskList, "ActionTask"))) pushTask("action", task);
  for (const task of asArray(child(taskList, "SubflowTask"))) pushTask("subflow", task);
  for (const task of asArray(child(taskList, "StopTask"))) pushTask("stop", task);

  const nodes = asArray(child(child(body, "NodeList"), "TaskNode")).map((item) => ({
    id: attr(item, "Identifier") || "",
    task: attr(item, "Task") || "",
  }));
  const transitions = asArray(child(child(body, "TransitionList"), "Transition")).map((item) => ({
    id: attr(item, "Identifier") || "",
    source: attr(item, "Source") || "",
    target: attr(item, "Target") || "",
    condition: textOf(child(item, "Conditions")).trim() || undefined,
    language: attr(child(item, "Conditions"), "Language"),
  }));
  const bal = [
    ...tasks
      .filter((task) => task.kind === "rule")
      .map((task) => {
        const scope = [...task.packages.map((name) => `package ${name}`), ...task.rules.map((name) => `rule ${name}`)].join(", ");
        return `task ${task.identifier} [${task.algorithm ?? "default"}] selects ${scope || "nothing"}${task.filter ? ` where ${task.filter}` : ""}`;
      }),
    ...transitions.filter((item) => item.condition).map((item) => `transition ${item.id}: ${item.condition}`),
    ...tasks.filter((task) => task.actions).map((task) => `final: ${task.actions}`),
  ].join("\n");
  return baseArtifact({
    id: scalar(node, "uuid") || `path:${file.path}`,
    type: "ruleflow",
    name: scalar(node, "name") || file.path,
    package: packageFromPath(file.path),
    bal,
    filePath: file.path,
    uuid: scalar(node, "uuid"),
    locale: scalar(node, "locale"),
    tasks,
    transitions,
    nodes,
  });
}

function parseOperation(file: SourceFile, node: Record<string, unknown>): Artifact {
  const inputs = asArray(node.referencedVariables).map((item) => ({
    name: attr(item, "variableName") || "",
    direction: attr(item, "direction") || "IN",
  }));
  const href = attr(child(node, "ruleflow"), "href") || "";
  const uuid = href.includes("#") ? decodeURIComponent(href.split("#")[1] ?? "") : undefined;
  return baseArtifact({
    id: scalar(node, "uuid") || `path:${file.path}`,
    type: "decisionOperation",
    name: scalar(node, "name") || attr(node, "rulesetName") || file.path,
    package: "",
    filePath: file.path,
    uuid: scalar(node, "uuid"),
    inputs,
    rulesetName: attr(node, "rulesetName"),
    ruleflowName: attr(node, "ruleflowName"),
    ruleflowUuid: uuid,
  });
}

function parseVariableSet(file: SourceFile, node: Record<string, unknown>): { artifact: Artifact; terms: VocabTerm[] } {
  const terms: VocabTerm[] = [];
  for (const variable of asArray(node.variables)) {
    const verbalization = attr(variable, "verbalization") || attr(variable, "name") || "";
    const name = attr(variable, "name") || verbalization;
    const type = attr(variable, "type");
    terms.push({
      id: `term:parameter:${verbalization}`,
      kind: "parameter",
      className: type,
      member: name,
      verbalization,
      example: verbalization,
      pattern: "",
      filePath: file.path,
    });
  }
  return {
    artifact: baseArtifact({
      id: scalar(node, "uuid") || `path:${file.path}`,
      type: "variableSet",
      name: scalar(node, "name") || file.path,
      package: "",
      filePath: file.path,
      uuid: scalar(node, "uuid"),
      inputs: terms.map((term) => ({ name: term.member || term.verbalization, direction: "IN", type: term.className })),
    }),
    terms,
  };
}

function parseBom(file: SourceFile, content: string): VocabTerm[] {
  const terms: VocabTerm[] = [];
  const classRe = /public\s+class\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(content))) {
    const className = match[1];
    terms.push({
      id: `term:concept:${className}`,
      kind: "concept",
      className,
      verbalization: className,
      example: className,
      pattern: "",
      filePath: file.path,
    });
    const body = match[2];
    const memberRe = /public\s+(?:readonly\s+)?([\w.]+)\s+(\w+)\s*(\([^)]*\))?/g;
    let member: RegExpExecArray | null;
    while ((member = memberRe.exec(body))) {
      const typeName = member[1];
      const memberName = member[2];
      if (memberName === className) continue;
      terms.push({
        id: `term:member:${className}.${memberName}`,
        kind: "member",
        className,
        member: memberName,
        verbalization: memberName,
        example: memberName,
        pattern: "",
        filePath: file.path,
      });
      void typeName;
    }
  }
  return terms;
}

function parseVocabulary(file: SourceFile, content: string): { terms: VocabTerm[]; uuid?: string } {
  const terms: VocabTerm[] = [];
  let uuid: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === "uuid") {
      uuid = value;
      continue;
    }
    const hash = key.indexOf("#");
    if (hash < 0) continue;
    const owner = key.slice(0, hash);
    const kindKey = key.slice(hash + 1);
    const parts = owner.split(".");
    const className = parts.length >= 2 ? parts[1] : parts[0];
    const member = parts.length >= 3 ? parts.slice(2).join(".") : undefined;
    if (kindKey === "concept.label") {
      const existing = terms.find((term) => term.kind === "concept" && term.className === className);
      if (existing) {
        existing.verbalization = value;
        existing.example = value;
      } else {
        terms.push({
          id: `term:concept:${className}`,
          kind: "concept",
          className,
          verbalization: value,
          example: value,
          pattern: "",
          filePath: file.path,
          uuid,
        });
      }
      continue;
    }
    const kind = kindKey === "phrase.action" ? "action" : kindKey === "phrase.navigation" ? "navigation" : null;
    if (!kind) continue;
    terms.push({
      id: `term:${kind}:${className}.${member ?? "class"}:${value}`,
      kind,
      className,
      member,
      verbalization: value,
      example: value,
      pattern: "",
      filePath: file.path,
      uuid,
    });
  }
  return { terms, uuid };
}

function extensionOf(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

function parseXmlArtifact(file: SourceFile, warnings: string[]): { artifacts: Artifact[]; terms: VocabTerm[] } {
  let doc: unknown;
  try {
    doc = xmlParser.parse(file.content);
  } catch (error) {
    warnings.push(`${file.path}: XML parse failed (${error instanceof Error ? error.message : "unknown"})`);
    return { artifacts: [], terms: [] };
  }
  const root = rootElement(doc);
  if (!root) {
    warnings.push(`${file.path}: no XML root`);
    return { artifacts: [], terms: [] };
  }
  const ext = extensionOf(file.path);
  const name = root.name;
  if (name === "ActionRule" || ext === ".brl") {
    return { artifacts: [parseBalArtifact(file, root.node, "actionRule")], terms: [] };
  }
  if (name === "DecisionTable" || ext === ".dta") {
    return { artifacts: [parseDecisionTable(file, root.node)], terms: [] };
  }
  if (name === "DecisionTree" || ext === ".dtr") {
    return { artifacts: [parseBalArtifact(file, root.node, "decisionTree")], terms: [] };
  }
  if (name === "Function" || ext === ".fct") {
    return { artifacts: [parseBalArtifact(file, root.node, "function")], terms: [] };
  }
  if (name === "TechnicalRule" || ext === ".trl") {
    return { artifacts: [parseBalArtifact(file, root.node, "technicalRule")], terms: [] };
  }
  if (name === "RuleFlow" || ext === ".rfl") {
    return { artifacts: [parseRuleflow(file, root.node)], terms: [] };
  }
  if (name === "Operation" || ext === ".dop") {
    return { artifacts: [parseOperation(file, root.node)], terms: [] };
  }
  if (name === "VariableSet" || ext === ".var") {
    const parsed = parseVariableSet(file, root.node);
    return { artifacts: [parsed.artifact], terms: parsed.terms };
  }
  if (name === "RulePackage" || ext === ".rulepackage") {
    const packageName = scalar(root.node, "name") || packageFromPath(file.path);
    return {
      artifacts: [
        baseArtifact({
          id: `pkg:${packageName}`,
          type: "package",
          name: packageName,
          package: packageName,
          filePath: file.path,
          uuid: scalar(root.node, "uuid"),
        }),
      ],
      terms: [],
    };
  }
  if (name === "RuleProject" || ext === ".ruleproject") {
    const projectName = scalar(root.node, "name") || "rule project";
    const decision = attr(root.node, "isADecisionService") === "true";
    return {
      artifacts: [
        baseArtifact({
          id: scalar(root.node, "uuid") || `project:${projectName}`,
          type: "project",
          name: projectName,
          package: "",
          filePath: file.path,
          uuid: scalar(root.node, "uuid"),
          decisionServices: decision ? [projectName] : [],
        }),
      ],
      terms: [],
    };
  }
  return { artifacts: [], terms: [] };
}

export function parseSources(files: SourceFile[]): RawExtract {
  const artifacts: Artifact[] = [];
  const terms: VocabTerm[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    const ext = extensionOf(file.path);
    if (ext === ".bom") {
      terms.push(...parseBom(file, file.content));
      continue;
    }
    if (ext === ".voc") {
      terms.push(...parseVocabulary(file, file.content).terms);
      continue;
    }
    if (![".brl", ".dta", ".dtr", ".fct", ".trl", ".rfl", ".dop", ".var", ".rulepackage", ".ruleproject"].includes(ext)) {
      continue;
    }
    const parsed = parseXmlArtifact(file, warnings);
    artifacts.push(...parsed.artifacts);
    terms.push(...parsed.terms);
  }

  const project = artifacts.find((artifact) => artifact.type === "project");
  const projectName = project?.name ?? "rule project";
  const decisionService = project?.decisionServices[0];
  for (const artifact of artifacts) {
    if (decisionService && artifact.type !== "project") artifact.decisionServices = [decisionService];
  }

  const packageNames = new Set(artifacts.filter((artifact) => artifact.type === "package").map((artifact) => artifact.name));
  for (const artifact of artifacts) {
    if (!artifact.package || packageNames.has(artifact.package)) continue;
    if (!["actionRule", "decisionTable", "decisionTree", "function", "technicalRule"].includes(artifact.type)) continue;
    packageNames.add(artifact.package);
    artifacts.push(
      baseArtifact({
        id: `pkg:${artifact.package}`,
        type: "package",
        name: artifact.package,
        package: artifact.package,
        filePath: artifact.filePath,
        decisionServices: artifact.decisionServices,
      }),
    );
  }

  return { artifacts, terms: dedupeTerms(terms), warnings, projectName, decisionService };
}

function dedupeTerms(terms: VocabTerm[]): VocabTerm[] {
  const byId = new Map<string, VocabTerm>();
  for (const term of terms) {
    const prev = byId.get(term.id);
    if (!prev) {
      byId.set(term.id, term);
      continue;
    }
    if (prev.kind === "concept" && term.verbalization && term.verbalization !== prev.className) {
      prev.verbalization = term.verbalization;
      prev.example = term.example || term.verbalization;
    }
    if (prev.kind === "member" && (term.kind === "navigation" || term.kind === "action")) {
      byId.set(term.id, term);
    }
  }
  return [...byId.values()];
}

export function renderCellText(column: TableColumn | undefined, item: TableCell): string {
  return renderCell(column, item);
}
