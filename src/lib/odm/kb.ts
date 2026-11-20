import { CURATED_GLOSSARY } from "./glossary.ts";
import { parseSources } from "./parse.ts";
import type {
  Artifact,
  ArtifactType,
  DriftReport,
  Edge,
  FeedbackRecord,
  GlossaryEntry,
  Grounding,
  ImpactResult,
  MappedTerm,
  QualityGate,
  SearchFilters,
  SearchHit,
  SourceFile,
  VocabTerm,
} from "./types.ts";
import { driftReport } from "./drift.ts";

const STOP = new Set(
  "a an the of to is in on for and or if then else with than less more be when should must not from by at as that this into are was were will can may".split(
    " ",
  ),
);

const SEARCHABLE: ArtifactType[] = [
  "actionRule",
  "decisionTable",
  "decisionTree",
  "function",
  "technicalRule",
  "ruleflow",
];

const DIM = 128;

export interface KnowledgeSnapshot {
  projectName: string;
  commit?: string;
  decisionService?: string;
  artifacts: Artifact[];
  terms: VocabTerm[];
  edges: Edge[];
  glossary: GlossaryEntry[];
  warnings: string[];
  gates: QualityGate[];
}

interface Doc {
  artifact: Artifact;
  tokens: string[];
  vector: Float64Array;
  length: number;
}

export class KnowledgeBase {
  readonly projectName: string;
  readonly commit?: string;
  readonly decisionService?: string;
  readonly artifacts: Artifact[];
  readonly terms: VocabTerm[];
  readonly edges: Edge[];
  readonly glossary: GlossaryEntry[];
  readonly warnings: string[];
  readonly gates: QualityGate[];
  readonly feedback: FeedbackRecord[] = [];
  private readonly docs: Doc[];
  private readonly df = new Map<string, number>();
  private readonly avgdl: number;

  constructor(snapshot: Omit<KnowledgeSnapshot, "gates"> & { gates?: QualityGate[] }) {
    this.projectName = snapshot.projectName;
    this.commit = snapshot.commit;
    this.decisionService = snapshot.decisionService;
    this.artifacts = snapshot.artifacts;
    this.terms = snapshot.terms;
    this.edges = snapshot.edges;
    this.glossary = snapshot.glossary;
    this.warnings = snapshot.warnings;
    this.docs = this.artifacts.filter((artifact) => SEARCHABLE.includes(artifact.type)).map((artifact) => {
      const tokens = tokenize(documentText(artifact));
      return { artifact, tokens, vector: embed(tokens), length: tokens.length || 1 };
    });
    for (const doc of this.docs) {
      for (const token of new Set(doc.tokens)) this.df.set(token, (this.df.get(token) ?? 0) + 1);
    }
    this.avgdl = this.docs.reduce((sum, doc) => sum + doc.length, 0) / (this.docs.length || 1);
    this.gates = snapshot.gates ?? this.evaluate();
  }

  getArtifact(id: string): Artifact | undefined {
    return this.artifacts.find((artifact) => artifact.id === id || artifact.uuid === id || artifact.name === id);
  }

  vocabulary(classOrPackage?: string): VocabTerm[] {
    if (!classOrPackage) return this.terms;
    const needle = classOrPackage.toLowerCase();
    return this.terms.filter(
      (term) =>
        term.className?.toLowerCase() === needle ||
        term.example.toLowerCase().includes(needle) ||
        term.verbalization.toLowerCase().includes(needle),
    );
  }

  search(query: string, filters: SearchFilters = {}): SearchHit[] {
    const expanded = expandQuery(query, this.glossary);
    const tokens = tokenize(expanded);
    const queryVector = embed(tokens);
    const types = filters.type ? (Array.isArray(filters.type) ? filters.type : [filters.type]) : SEARCHABLE;
    const hits: SearchHit[] = [];
    let maxLexical = 0;
    for (const doc of this.docs) {
      if (!types.includes(doc.artifact.type)) continue;
      if (filters.package && doc.artifact.package !== filters.package) continue;
      if (filters.decisionService && !doc.artifact.decisionServices.includes(filters.decisionService)) continue;
      const lexical = bm25(tokens, doc, this.df, this.docs.length, this.avgdl);
      const semantic = dot(queryVector, doc.vector);
      if (lexical > maxLexical) maxLexical = lexical;
      hits.push({ artifact: doc.artifact, score: 0, lexical, semantic });
    }
    for (const hit of hits) {
      const lexicalNorm = maxLexical > 0 ? hit.lexical / maxLexical : 0;
      const phrase = query.toLowerCase();
      const bonus = (hit.artifact.bal ?? hit.artifact.name).toLowerCase().includes(phrase) ? 0.15 : 0;
      hit.score = 0.62 * lexicalNorm + 0.38 * Math.max(0, hit.semantic) + bonus;
    }
    return hits
      .filter((hit) => hit.score > 0 || tokens.length === 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  }

  impact(seed: string): ImpactResult {
    const artifact = this.getArtifact(seed);
    const packageName = artifact?.type === "package" ? artifact.name : artifact?.package || seed;
    const reasons = new Map<string, string>();
    const consider = (item: Artifact | undefined, reason: string) => {
      if (!item || reasons.has(item.id)) return;
      reasons.set(item.id, reason);
    };
    if (artifact) consider(artifact, "Matched the requested artifact");
    const pkg = this.artifacts.find((item) => item.type === "package" && item.name === packageName);
    consider(pkg, `Package ${packageName} contains the change`);
    for (const item of this.artifacts) {
      if (item.package === packageName && item.type !== "package") {
        consider(item, `Same package '${packageName}' is selected together at runtime`);
      }
    }
    for (const flow of this.artifacts.filter((item) => item.type === "ruleflow")) {
      for (const task of flow.tasks ?? []) {
        const selected =
          task.packages.includes(packageName) ||
          (artifact ? task.rules.includes(artifact.name) : false);
        if (!selected) continue;
        consider(flow, `Rule task '${task.identifier}' selects ${packageName}${task.filter ? ` with filter: ${task.filter}` : ""}`);
        for (const operation of this.artifacts.filter((item) => item.type === "decisionOperation")) {
          if (operation.ruleflowUuid === flow.uuid || operation.ruleflowName === flow.name) {
            consider(operation, `Decision operation '${operation.name}' runs ruleflow '${flow.name}'`);
          }
        }
      }
    }
    const artifacts = [...reasons.keys()]
      .map((id) => this.artifacts.find((item) => item.id === id))
      .filter((item): item is Artifact => Boolean(item));
    return {
      seed,
      artifacts,
      reasons: artifacts.map((item) => ({ id: item.id, reason: reasons.get(item.id) || "" })),
    };
  }

  validateTerms(phrases: string[]): { ok: boolean; missing: string[]; found: VocabTerm[] } {
    const found: VocabTerm[] = [];
    const missing: string[] = [];
    for (const phrase of phrases) {
      const term = bestTerm(phrase, this.terms);
      if (!term || term.score < 0.72) missing.push(phrase);
      else found.push(term.term);
    }
    return { ok: missing.length === 0, missing, found };
  }

  signature(operationName?: string): Artifact | undefined {
    if (!operationName) return this.artifacts.find((item) => item.type === "decisionOperation");
    return this.artifacts.find(
      (item) => item.type === "decisionOperation" && (item.name === operationName || item.id === operationName),
    );
  }

  ground(requirement: string): Grounding {
    const tools: Grounding["tools"] = [];
    const mapped = mapRequirement(requirement, this.terms, this.glossary);
    tools.push({
      name: "map_vocabulary",
      detail: mapped.mapped.length
        ? mapped.mapped.map((item) => `${item.surface} → ${item.term.example}`).join("; ")
        : "no vocabulary terms matched",
    });
    const query = [...mapped.mapped.map((item) => item.term.example), requirement].join(" ");
    const hits = this.search(query);
    tools.push({
      name: "search_rules",
      detail: hits.slice(0, 5).map((hit) => `${hit.artifact.package || "—"}.${hit.artifact.name}`).join(", ") || "none",
    });
    const top = hits[0]?.artifact;
    const impact = top ? this.impact(top.package || top.id) : null;
    if (impact) {
      tools.push({
        name: "get_ruleflow_impact",
        detail: impact.artifacts.map((item) => item.name).join(", "),
      });
    }
    const signature = this.signature();
    if (signature) {
      tools.push({
        name: "get_decision_operation_signature",
        detail: `${signature.name}: ${(signature.inputs ?? []).map((input) => `${input.name} ${input.direction}`).join(", ")}`,
      });
    }
    const unknown = mapped.unknown;
    const validation = this.validateTerms(mapped.mapped.map((item) => item.term.example));
    tools.push({
      name: "validate_terms",
      detail: unknown.length ? `rejected unknown: ${unknown.join(", ")}` : "all mapped terms exist in the BOM",
    });
    const accepted = unknown.length === 0 && mapped.mapped.length > 0;
    const draft = accepted ? draftFrom(requirement, mapped.mapped, top) : null;
    return {
      requirement,
      mapped: mapped.mapped,
      unknown,
      accepted,
      hits,
      impact,
      draft,
      rejection: accepted
        ? null
        : unknown.length
          ? `Rejected. These words are not in the vocabulary: ${unknown.join(", ")}.`
          : "Rejected. The requirement did not map onto any BOM term.",
      tools,
    };
  }

  snapshot(): KnowledgeSnapshot {
    return {
      projectName: this.projectName,
      commit: this.commit,
      decisionService: this.decisionService,
      artifacts: this.artifacts,
      terms: this.terms,
      edges: this.edges,
      glossary: this.glossary,
      warnings: this.warnings,
      gates: this.gates,
    };
  }

  recordFeedback(requirement: string, accepted: boolean): FeedbackRecord {
    const grounding = this.ground(requirement);
    const record: FeedbackRecord = {
      id: `fb:${this.feedback.length + 1}`,
      requirement,
      accepted,
      unknown: grounding.unknown,
      mapped: grounding.mapped.map((item) => item.term.example),
      at: new Date().toISOString(),
    };
    this.feedback.push(record);
    if (accepted) {
      for (const item of grounding.mapped) {
        const exists = this.glossary.some((entry) => entry.phrase.toLowerCase() === item.surface.toLowerCase());
        if (!exists) {
          this.glossary.push({ phrase: item.surface, mapsTo: [item.term.example], source: "session" });
        }
      }
    }
    return record;
  }

  driftAgainst(previous: Pick<KnowledgeSnapshot, "commit" | "artifacts" | "terms">): DriftReport {
    return driftReport(this.snapshot(), previous);
  }

  projects(): { name: string; decisionService?: string; artifacts: Artifact[] }[] {
    const groups = new Map<string, Artifact[]>();
    for (const artifact of this.artifacts) {
      const key = artifact.decisionServices[0] || this.projectName;
      const list = groups.get(key) ?? [];
      list.push(artifact);
      groups.set(key, list);
    }
    return [...groups.entries()].map(([name, artifacts]) => ({
      name,
      decisionService: artifacts.find((item) => item.decisionServices[0])?.decisionServices[0],
      artifacts,
    }));
  }

  private evaluate(): QualityGate[] {
    const rules = this.artifacts.filter((item) =>
      ["actionRule", "decisionTable", "decisionTree", "function", "technicalRule"].includes(item.type),
    );
    const withProvenance = rules.filter((item) => item.uuid && item.filePath);
    const flows = this.artifacts.filter((item) => item.type === "ruleflow");
    const packages = new Set(this.artifacts.filter((item) => item.type === "package").map((item) => item.name));
    const dangling = flows.flatMap((flow) =>
      (flow.tasks ?? []).flatMap((task) => task.packages.filter((name) => !packages.has(name)).map((name) => `${flow.name}:${name}`)),
    );
    const tables = this.artifacts.filter((item) => item.type === "decisionTable");
    const emptyTables = tables.filter((item) => (item.rows?.length ?? 0) === 0);
    const operations = this.artifacts.filter((item) => item.type === "decisionOperation");
    const parameterNames = new Set(this.terms.filter((term) => term.kind === "parameter").map((term) => term.member));
    const badParams = operations.flatMap((operation) =>
      (operation.inputs ?? []).filter((input) => input.name && !parameterNames.has(input.name)).map((input) => input.name),
    );
    let recallHits = 0;
    for (const rule of rules) {
      const found = this.search(rule.name).slice(0, 5).some((hit) => hit.artifact.id === rule.id);
      if (found) recallHits += 1;
    }
    const recall = rules.length ? recallHits / rules.length : 1;
    return [
      {
        id: "coverage",
        label: "Artifacts parsed",
        pass: rules.length > 0 && this.terms.length > 0,
        detail: `${rules.length} rules or tables, ${this.terms.length} vocabulary terms`,
      },
      {
        id: "provenance",
        label: "Provenance on every rule",
        pass: withProvenance.length === rules.length,
        detail: `${withProvenance.length}/${rules.length} have a UUID and file path`,
      },
      {
        id: "selection",
        label: "Ruleflow selection resolves",
        pass: dangling.length === 0 && flows.length > 0,
        detail: dangling.length ? `Missing packages: ${dangling.join(", ")}` : `${flows.length} ruleflow, selection packages exist`,
      },
      {
        id: "tables",
        label: "Decision tables have rows",
        pass: emptyTables.length === 0,
        detail: tables.length ? `${tables.reduce((sum, item) => sum + (item.rows?.length ?? 0), 0)} rows` : "no decision tables",
      },
      {
        id: "signature",
        label: "Operation signature binds known parameters",
        pass: operations.length > 0 && badParams.length === 0,
        detail: badParams.length ? `Unknown parameters: ${badParams.join(", ")}` : operations[0]?.name ?? "no operation",
      },
      {
        id: "recall",
        label: "Name search recall@5",
        pass: recall >= 0.95,
        detail: `${Math.round(recall * 100)}% of rules are in the top 5 for their own name`,
      },
    ];
  }
}

export function buildKnowledgeBase(
  files: SourceFile[],
  options: { commit?: string; glossary?: GlossaryEntry[] } = {},
): KnowledgeBase {
  const extracted = parseSources(files);
  const glossary = options.glossary ?? CURATED_GLOSSARY;
  const commit = options.commit;
  for (const artifact of extracted.artifacts) artifact.commit = commit;
  instantiateTerms(extracted.terms);
  const edges = linkGraph(extracted.artifacts, extracted.terms);
  return new KnowledgeBase({
    projectName: extracted.projectName,
    commit,
    decisionService: extracted.decisionService,
    artifacts: extracted.artifacts,
    terms: extracted.terms,
    edges,
    glossary,
    warnings: extracted.warnings,
  });
}

function instantiateTerms(terms: VocabTerm[]): void {
  const parameters = terms.filter((term) => term.kind === "parameter");
  const concepts = new Map(terms.filter((term) => term.kind === "concept").map((term) => [term.className, term.verbalization]));
  for (const term of terms) {
    if (term.kind === "parameter") {
      term.pattern = normalize(term.example);
      continue;
    }
    if (term.kind !== "navigation" && term.kind !== "action") {
      term.pattern = normalize(term.example);
      continue;
    }
    const parameter = parameters.find(
      (item) => item.className === term.className || item.className?.endsWith(`.${term.className}`),
    );
    const standIn = parameter?.example || (concepts.get(term.className) ? `the ${concepts.get(term.className)}` : "this");
    const shaped = term.verbalization
      .replaceAll("{this}", standIn)
      .replace(/\{\d+\}/g, " WILDCARD ")
      .replace(/\{([^}]+)\}/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    term.example = shaped.replaceAll("WILDCARD", "…");
    term.pattern = normalize(shaped).replace(/\bwildcard\b/g, "*");
  }
}

function linkGraph(artifacts: Artifact[], terms: VocabTerm[]): Edge[] {
  const edges: Edge[] = [];
  const push = (type: Edge["type"], from: string, to: string, detail?: string) => {
    edges.push({ id: `${type}:${from}:${to}:${edges.length}`, type, from, to, detail });
  };
  const phrases = terms
    .filter((term) => term.kind === "navigation" || term.kind === "action" || term.kind === "parameter")
    .map((term) => ({ term, pattern: term.pattern || normalize(term.example) }))
    .filter((item) => item.pattern.replace(/\*/g, "").trim().length > 3)
    .sort((a, b) => b.pattern.length - a.pattern.length);

  for (const artifact of artifacts) {
    if (artifact.package && artifact.type !== "package" && artifact.type !== "project") {
      push("CONTAINS", `pkg:${artifact.package}`, artifact.id, artifact.package);
    }
    const haystack = normalize(`${artifact.bal ?? ""}\n${artifact.preconditions ?? ""}`);
    if (!haystack) continue;
    const used: VocabTerm[] = [];
    for (const phrase of phrases) {
      if (matchesPattern(haystack, phrase.pattern)) used.push(phrase.term);
    }
    artifact.vocabularyTermsUsed = [...new Set(used.map((term) => term.example))];
    artifact.objectsReferenced = [
      ...new Set(used.filter((term) => term.kind === "parameter").map((term) => term.member || term.example)),
    ];
    for (const term of used) push("USES_TERM", artifact.id, term.id, term.example);
  }

  for (const flow of artifacts.filter((item) => item.type === "ruleflow")) {
    for (const task of flow.tasks ?? []) {
      for (const packageName of task.packages) {
        push(
          "SELECTS_FROM",
          flow.id,
          `pkg:${packageName}`,
          `${task.identifier} ${task.algorithm ?? ""} ${task.filter ?? ""}`.trim(),
        );
      }
    }
  }
  for (const operation of artifacts.filter((item) => item.type === "decisionOperation")) {
    const flow = artifacts.find(
      (item) => item.type === "ruleflow" && (item.uuid === operation.ruleflowUuid || item.name === operation.ruleflowName),
    );
    if (flow) push("EXTRACTS", operation.id, flow.id, operation.rulesetName);
    for (const input of operation.inputs ?? []) {
      const term = terms.find((item) => item.kind === "parameter" && item.member === input.name);
      if (term) {
        input.type = term.className;
        push("BINDS_PARAMETER", operation.id, term.id, input.direction);
      }
    }
  }
  const ranked = artifacts.filter((item) => typeof item.priority === "number");
  for (const higher of ranked) {
    for (const lower of ranked) {
      if (higher.id === lower.id || higher.package !== lower.package) continue;
      if ((higher.priority ?? 0) > (lower.priority ?? 0)) {
        push("OVERRIDES", higher.id, lower.id, `priority ${higher.priority} over ${lower.priority}`);
      }
    }
  }
  for (const artifact of artifacts) {
    const looksLikeTest = /(?:^|\/)tests?\//i.test(artifact.filePath) || /\btest\b/i.test(artifact.name);
    if (!looksLikeTest) continue;
    const haystack = (artifact.bal ?? artifact.name).toLowerCase();
    for (const rule of artifacts) {
      if (rule.id === artifact.id || !["actionRule", "decisionTable"].includes(rule.type)) continue;
      if (haystack.includes(rule.name.toLowerCase())) push("COVERS", artifact.id, rule.id, rule.name);
    }
  }
  const bomOwners = new Map<string, string[]>();
  for (const term of terms) {
    if (!term.filePath.endsWith(".bom") && !term.filePath.endsWith(".voc")) continue;
    const owners = bomOwners.get(term.filePath) ?? [];
    if (!owners.includes(term.id)) owners.push(term.id);
    bomOwners.set(term.filePath, owners);
  }
  const projects = artifacts.filter((item) => item.type === "project");
  if (projects.length > 1) {
    for (const [bomPath, owners] of bomOwners) {
      for (const project of projects) push("SHARES_BOM", project.id, owners[0], bomPath);
    }
  }
  return edges;
}

function documentText(artifact: Artifact): string {
  return [
    artifact.name,
    artifact.package,
    artifact.bal,
    artifact.preconditions,
    ...(artifact.columns ?? []).map((column) => column.template),
    ...(artifact.rows ?? []).map((row) => row.summary),
    ...(artifact.vocabularyTermsUsed ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(" ")
    .map(stem)
    .filter((token) => token && !STOP.has(token) && token.length > 1);
}

function stem(token: string): string {
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function embed(tokens: string[]): Float64Array {
  const vector = new Float64Array(DIM);
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) hash = Math.imul(hash ^ token.charCodeAt(i), 16777619);
    const index = Math.abs(hash) % DIM;
    vector[index] += hash & 1 ? 1 : -1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function bm25(query: string[], doc: Doc, df: Map<string, number>, n: number, avgdl: number): number {
  const tf = new Map<string, number>();
  for (const token of doc.tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const token of query) {
    const freq = tf.get(token) ?? 0;
    if (!freq) continue;
    const docs = df.get(token) ?? 0;
    const idf = Math.log(1 + (n - docs + 0.5) / (docs + 0.5));
    score += (idf * (freq * (k1 + 1))) / (freq + k1 * (1 - b + b * (doc.length / avgdl)));
  }
  return score;
}

function expandQuery(query: string, glossary: GlossaryEntry[]): string {
  const norm = normalize(query);
  const extra: string[] = [];
  for (const entry of glossary) {
    if (norm.includes(normalize(entry.phrase))) extra.push(...entry.mapsTo);
  }
  return `${query} ${extra.join(" ")}`.trim();
}

function bestTerm(phrase: string, terms: VocabTerm[]): { term: VocabTerm; score: number } | null {
  const needle = tokenize(phrase);
  if (!needle.length) return null;
  let best: { term: VocabTerm; score: number } | null = null;
  const raw = normalize(phrase);
  for (const term of terms) {
    if (term.kind === "member" || term.kind === "concept") continue;
    const example = normalize(term.example);
    if (example && (raw.includes(example) || example.includes(raw))) {
      const score = example === raw ? 1 : 0.86;
      if (!best || score > best.score) best = { term, score };
      continue;
    }
    const hay = tokenize(term.example);
    if (!hay.length) continue;
    const overlap = needle.filter((token) => hay.includes(token)).length;
    const score = overlap / Math.max(needle.length, hay.length);
    if (!best || score > best.score) best = { term, score };
  }
  return best;
}

function matchesPattern(haystack: string, pattern: string): boolean {
  if (!pattern.includes("*")) return haystack.includes(pattern);
  const parts = pattern
    .split("*")
    .map((part) => part.trim())
    .filter(Boolean);
  let from = 0;
  for (const part of parts) {
    const at = haystack.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

function mapRequirement(
  requirement: string,
  terms: VocabTerm[],
  glossary: GlossaryEntry[],
): { mapped: MappedTerm[]; unknown: string[] } {
  const norm = normalize(requirement);
  const surfaces = new Map<string, MappedTerm>();
  for (const entry of glossary) {
    if (!norm.includes(normalize(entry.phrase))) continue;
    for (const target of entry.mapsTo) {
      const match = bestTerm(target, terms);
      if (!match || match.score < 0.45) continue;
      const key = match.term.id;
      const prev = surfaces.get(key);
      if (!prev || match.score > prev.score) {
        surfaces.set(key, { surface: entry.phrase, term: match.term, score: match.score });
      }
    }
  }
  for (const term of terms) {
    if (term.kind !== "navigation" && term.kind !== "action" && term.kind !== "parameter") continue;
    const example = normalize(term.example);
    if (example.length < 4 || !norm.includes(example)) continue;
    surfaces.set(term.id, { surface: term.example, term, score: 0.95 });
  }
  const content = tokenize(requirement);
  const lexicon = new Set(terms.flatMap((term) => tokenize(`${term.example} ${term.verbalization} ${term.member ?? ""}`)));
  const covered = new Set<string>();
  for (const entry of glossary) {
    if (norm.includes(normalize(entry.phrase))) {
      for (const token of tokenize(entry.phrase)) covered.add(token);
      for (const target of entry.mapsTo) {
        for (const token of tokenize(target)) covered.add(token);
      }
    }
  }
  const unknown = content.filter((token) => !lexicon.has(token) && !covered.has(token));
  return { mapped: [...surfaces.values()].sort((a, b) => b.score - a.score), unknown };
}

function draftFrom(requirement: string, mapped: MappedTerm[], exemplar?: Artifact): string {
  const conditions = mapped.filter((item) => item.term.kind === "navigation" || item.term.kind === "parameter");
  const actions = mapped.filter((item) => item.term.kind === "action");
  const reject = actions.find((item) => normalize(item.term.example).includes("reject")) ?? actions[0];
  const lines = [
    "if",
    conditions.length
      ? `    ${conditions
          .slice(0, 3)
          .map((item) => item.term.example)
          .join("\n    and ")}`
      : "    <condition using only the mapped navigation phrases>",
    "then",
    reject ? `    ${reject.term.example.endsWith(";") ? reject.term.example : `${reject.term.example};`}` : "    <action using only an existing action phrase>;",
    "",
    `-- grounded from requirement: ${requirement}`,
  ];
  if (exemplar) lines.push(`-- nearest existing artifact: ${exemplar.package ? `${exemplar.package}.` : ""}${exemplar.name}`);
  return lines.join("\n");
}
