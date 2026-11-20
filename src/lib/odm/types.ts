export type ArtifactType =
  | "project"
  | "package"
  | "actionRule"
  | "decisionTable"
  | "decisionTree"
  | "function"
  | "technicalRule"
  | "ruleflow"
  | "decisionOperation"
  | "variableSet";

export interface SourceFile {
  path: string;
  content: string;
}

export interface TableColumn {
  id: string;
  kind: "condition" | "action";
  template: string;
}

export interface TableCell {
  columnId: string;
  params: string[];
  text: string;
  enabled: boolean;
}

export interface TableRow {
  index: number;
  conditions: TableCell[];
  actions: TableCell[];
  summary: string;
}

export interface FlowNode {
  id: string;
  task: string;
}

export interface FlowTask {
  identifier: string;
  kind: "start" | "rule" | "stop" | "action" | "subflow";
  packages: string[];
  rules: string[];
  algorithm?: string;
  ordering?: string;
  exitCriteria?: string;
  filter?: string;
  filterLanguage?: string;
  dynamic?: boolean;
  actions?: string;
}

export interface FlowTransition {
  id: string;
  source: string;
  target: string;
  condition?: string;
  language?: string;
}

export interface Artifact {
  id: string;
  type: ArtifactType;
  name: string;
  package: string;
  status?: string;
  bal?: string;
  definitions?: string;
  conditions?: string;
  actions?: string;
  elseActions?: string;
  preconditions?: string;
  vocabularyTermsUsed: string[];
  objectsReferenced: string[];
  filePath: string;
  uuid?: string;
  locale?: string;
  commit?: string;
  decisionServices: string[];
  priority?: number;
  columns?: TableColumn[];
  rows?: TableRow[];
  tasks?: FlowTask[];
  transitions?: FlowTransition[];
  nodes?: FlowNode[];
  inputs?: { name: string; direction: string; type?: string }[];
  rulesetName?: string;
  ruleflowName?: string;
  ruleflowUuid?: string;
}

export type TermKind = "concept" | "navigation" | "action" | "parameter" | "member";

export interface VocabTerm {
  id: string;
  kind: TermKind;
  className?: string;
  member?: string;
  verbalization: string;
  example: string;
  /** Normalized phrase. `*` is a wildcard slot (method arguments). */
  pattern: string;
  filePath: string;
  uuid?: string;
}

export interface Edge {
  id: string;
  type:
    | "CONTAINS"
    | "SELECTS_FROM"
    | "USES_TERM"
    | "EXTRACTS"
    | "BINDS_PARAMETER"
    | "OVERRIDES"
    | "COVERS"
    | "SHARES_BOM";
  from: string;
  to: string;
  detail?: string;
}

export interface GlossaryEntry {
  phrase: string;
  mapsTo: string[];
  source: "curated" | "session";
}

export interface SearchFilters {
  package?: string;
  type?: ArtifactType | ArtifactType[];
  decisionService?: string;
}

export interface SearchHit {
  artifact: Artifact;
  score: number;
  lexical: number;
  semantic: number;
}

export interface MappedTerm {
  surface: string;
  term: VocabTerm;
  score: number;
}

export interface Grounding {
  requirement: string;
  mapped: MappedTerm[];
  unknown: string[];
  accepted: boolean;
  hits: SearchHit[];
  impact: ImpactResult | null;
  draft: string | null;
  rejection: string | null;
  tools: { name: string; detail: string }[];
}

export interface ImpactResult {
  seed: string;
  artifacts: Artifact[];
  reasons: { id: string; reason: string }[];
}

export interface QualityGate {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface FeedbackRecord {
  id: string;
  requirement: string;
  accepted: boolean;
  unknown: string[];
  mapped: string[];
  at: string;
}

export interface DriftChange {
  id: string;
  name: string;
  kind: "added" | "removed" | "changed";
  detail: string;
}

export interface DriftReport {
  fromCommit?: string;
  toCommit?: string;
  added: DriftChange[];
  removed: DriftChange[];
  changed: DriftChange[];
  vocabularyAdded: string[];
  vocabularyRemoved: string[];
}

export interface SnapshotVersion {
  id: string;
  savedAt: string;
  label: string;
  artifactCount: number;
  termCount: number;
  commit?: string;
}
