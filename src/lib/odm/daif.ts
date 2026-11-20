import { indexExtracted } from "./kb.ts";
import type { Artifact, FlowTask, FlowTransition, TableColumn, TableRow, VocabTerm } from "./types.ts";

export interface DaifDocument {
  kind?: string;
  metadata?: { name?: string; display_name?: string; locale?: string };
  datamodel?: { name?: string; classes?: DaifClass[] };
  operation?: { name?: string; parameters?: DaifParameter[] };
  taskmodel?: { packages?: DaifPackage[]; ruleFlow?: DaifRuleFlow };
}

interface DaifClass {
  name: string;
  jsonname?: string;
  description?: string;
  Fields?: DaifField[];
  fields?: DaifField[];
}

interface DaifField {
  name: string;
  type?: string;
  description?: string;
  templates?: { getter?: string; setter?: string; action?: string };
}

interface DaifParameter {
  name: string;
  type?: string;
  verbalization?: string;
  direction?: string;
}

interface DaifPackage {
  name: string;
  artifacts?: DaifArtifact[];
}

interface DaifArtifact {
  type?: string;
  name: string;
  bal?: string;
  preconditions?: string;
  columns?: { kind?: string; template?: string; id?: string }[];
  rows?: { conditions?: string[]; actions?: string[]; summary?: string }[];
}

interface DaifRuleFlow {
  name?: string;
  ruleTasks?: {
    name: string;
    algorithm?: string;
    exitCriteria?: string;
    ordering?: string;
    select?: string[];
    requirements?: { from?: string; condition?: string }[];
  }[];
}

export function parseDaif(input: string | DaifDocument, source = "daif.json") {
  const doc = typeof input === "string" ? (JSON.parse(input) as DaifDocument) : input;
  if (doc.kind && doc.kind !== "DecisionService") {
    throw new Error(`DAIF kind '${doc.kind}' is not DecisionService`);
  }
  const warnings: string[] = [];
  const projectName = doc.metadata?.display_name || doc.metadata?.name || "decision service";
  const serviceName = doc.operation?.name || projectName;
  const artifacts: Artifact[] = [];
  const terms: VocabTerm[] = [];

  artifacts.push(blank("project", `project:${projectName}`, projectName, "", source, [serviceName]));

  for (const klass of doc.datamodel?.classes ?? []) {
    terms.push(term(`concept:${klass.name}`, "concept", klass.name, undefined, klass.description || klass.name, source));
    for (const field of klass.Fields ?? klass.fields ?? []) {
      const verbalization = field.templates?.getter || field.templates?.action || `the ${field.name} of {this}`;
      terms.push(term(`nav:${klass.name}.${field.name}`, "navigation", klass.name, field.name, verbalization, source));
    }
  }

  const parameters = doc.operation?.parameters ?? [];
  for (const parameter of parameters) {
    const phrase = parameter.verbalization || `the ${parameter.name}`;
    terms.push(term(`param:${parameter.name}`, "parameter", parameter.type, parameter.name, phrase, source));
  }

  const packages = doc.taskmodel?.packages ?? [];
  for (const pkg of packages) {
    artifacts.push(blank("package", `pkg:${pkg.name}`, pkg.name, pkg.name, source, [serviceName]));
    for (const item of pkg.artifacts ?? []) {
      artifacts.push(artifactFrom(item, pkg.name, source, serviceName, warnings));
    }
  }

  const flow = doc.taskmodel?.ruleFlow;
  if (flow) {
    const tasks: FlowTask[] = (flow.ruleTasks ?? []).map((task) => ({
      identifier: task.name,
      kind: "rule",
      packages: task.select ?? [],
      rules: [],
      algorithm: task.algorithm,
      ordering: task.ordering,
      exitCriteria: task.exitCriteria,
    }));
    const transitions: FlowTransition[] = [];
    for (const task of flow.ruleTasks ?? []) {
      for (const requirement of task.requirements ?? []) {
        if (!requirement.from) continue;
        transitions.push({
          id: `${requirement.from}->${task.name}`,
          source: requirement.from,
          target: task.name,
          condition: requirement.condition,
        });
      }
    }
    artifacts.push({
      ...blank("ruleflow", `flow:${flow.name || "ruleflow"}`, flow.name || "ruleflow", "", source, [serviceName]),
      tasks,
      transitions,
      nodes: tasks.map((task) => ({ id: task.identifier, task: task.identifier })),
    });
  }

  if (doc.operation) {
    artifacts.push({
      ...blank("decisionOperation", `op:${doc.operation.name}`, doc.operation.name, "", source, [serviceName]),
      inputs: parameters.map((parameter) => ({
        name: parameter.name,
        direction: parameter.direction || "in",
        type: parameter.type,
      })),
      ruleflowName: flow?.name,
    });
  }

  return {
    artifacts,
    terms,
    warnings,
    projectName,
    decisionService: serviceName,
  };
}

export function buildFromDaif(input: string | DaifDocument, options: { commit?: string; source?: string } = {}) {
  return indexExtracted(parseDaif(input, options.source ?? "daif.json"), options);
}

function artifactFrom(
  item: DaifArtifact,
  packageName: string,
  source: string,
  serviceName: string,
  warnings: string[],
): Artifact {
  const kind = (item.type ?? "rule").toLowerCase().replace(/\s+/g, "");
  const type = kind === "decisiontable" ? "decisionTable" : kind === "function" ? "function" : kind === "technicalrule" ? "technicalRule" : "actionRule";
  const id = `${packageName}/${item.name}`;
  const base = blank(type, id, item.name, packageName, source, [serviceName]);
  if (type === "decisionTable") {
    const columns: TableColumn[] = (item.columns ?? []).map((column, index) => ({
      id: column.id || `${column.kind === "action" ? "A" : "C"}${index}`,
      kind: column.kind === "action" ? "action" : "condition",
      template: column.template || "",
    }));
    const rows: TableRow[] = (item.rows ?? []).map((row, index) => {
      const conditions = (row.conditions ?? []).map((text, column) => ({
        columnId: columns[column]?.id ?? `C${column}`,
        params: [text],
        text,
        enabled: true,
      }));
      const actions = (row.actions ?? []).map((text, column) => ({
        columnId: columns.find((item) => item.kind === "action")?.id ?? `A${column}`,
        params: [text],
        text,
        enabled: true,
      }));
      return {
        index: index + 1,
        conditions,
        actions,
        summary: row.summary || [...(row.conditions ?? []), ...(row.actions ?? [])].join(" · "),
      };
    });
    if (!rows.length) warnings.push(`${item.name}: decision table has no rows`);
    return {
      ...base,
      preconditions: item.preconditions,
      columns,
      rows,
      bal: [item.preconditions, ...rows.map((row) => `row ${row.index}: ${row.summary}`)].filter(Boolean).join("\n"),
    };
  }
  if (!item.bal) warnings.push(`${item.name}: rule has no BAL`);
  return { ...base, bal: item.bal };
}

function blank(
  type: Artifact["type"],
  id: string,
  name: string,
  packageName: string,
  source: string,
  decisionServices: string[],
): Artifact {
  return {
    id,
    type,
    name,
    package: packageName,
    vocabularyTermsUsed: [],
    objectsReferenced: [],
    filePath: source,
    uuid: id,
    decisionServices,
  };
}

function term(
  id: string,
  kind: VocabTerm["kind"],
  className: string | undefined,
  member: string | undefined,
  verbalization: string,
  source: string,
): VocabTerm {
  return {
    id,
    kind,
    className,
    member,
    verbalization,
    example: verbalization,
    pattern: "",
    filePath: source.endsWith(".json") ? source : `${source}.json`,
  };
}
