/**
 * The knowledge model. Everything here is plain data so it can be cached as
 * JSON and compared across reindexes.
 */

/** Where a fact came from. `path` is workspace-relative with `/` separators. */
export interface Provenance {
  project: string;
  path: string;
  uuid?: string;
}

export type RuleKind = "actionRule" | "decisionTable" | "decisionTree" | "function" | "technicalRule";

export type ArtifactType =
  | RuleKind
  | "ruleflow"
  | "decisionOperation"
  | "variableSet"
  | "package";

export const RULE_KINDS: readonly RuleKind[] = [
  "actionRule",
  "decisionTable",
  "decisionTree",
  "function",
  "technicalRule",
];

export interface TableColumn {
  id: string;
  kind: "condition" | "action";
  template: string;
  /** Column title shown in Rule Designer, when the file has one. */
  title?: string;
}

/**
 * A decision-table cell keeps its values only. The readable text is the column
 * template filled with them (`renderCell`), computed when asked for: storing it
 * for every cell of every row doubled the memory of large tables.
 */
export interface TableCell {
  columnId: string;
  params: string[];
  /** Cell-specific template, when the file overrides the column's. */
  template?: string;
  enabled: boolean;
  otherwise?: boolean;
}

export interface TableRow {
  /** 1-based, in document order, matches Rule Designer's row numbering. */
  index: number;
  conditions: TableCell[];
  actions: TableCell[];
}

export interface FlowTask {
  id: string;
  kind: "start" | "rule" | "action" | "subflow" | "stop" | "fork" | "join" | "branch";
  /** Package names selected by a rule task, as written. */
  packages: string[];
  /** Rule names selected individually by a rule task, as written. */
  rules: string[];
  algorithm?: string;
  ordering?: string;
  exitCriteria?: string;
  /** Runtime selection or filter text. Kept verbatim, it is part of the impact reason. */
  filter?: string;
  dynamic?: boolean;
  /** BAL or IRL of initial / final actions. */
  actions?: string;
  /** Target ruleflow for a subflow task. */
  subflow?: string;
}

export interface FlowTransition {
  id: string;
  /** Task ids (node ids are resolved to tasks). */
  source: string;
  target: string;
  condition?: string;
}

export interface Artifact {
  /** Stable id: the UUID when the file has one, otherwise `path:<path>`. */
  id: string;
  type: ArtifactType;
  name: string;
  /** Dotted package path under the project's rules folder. Empty for top-level files. */
  package: string;
  provenance: Provenance;
  status?: string;
  locale?: string;
  priority?: string;
  /** Effective/expiration dates, categories, and any other `<properties>`. */
  properties?: Record<string, string>;
  documentation?: string;

  // Rule bodies
  bal?: string;
  definitions?: string;
  conditions?: string;
  actions?: string;
  elseActions?: string;
  preconditions?: string;
  columns?: TableColumn[];
  rows?: TableRow[];
  /** IRL for technical rules and functions. */
  irl?: string;

  // Ruleflow
  tasks?: FlowTask[];
  transitions?: FlowTransition[];

  // Decision operation
  operation?: {
    rulesetName?: string;
    ruleflowName?: string;
    ruleflowUuid?: string;
    targetProject?: string;
    signature: { name: string; direction: "IN" | "OUT" | "IN_OUT"; variableSet?: string }[];
  };

  // Variable set
  variables?: Variable[];
}

export interface Variable {
  name: string;
  type: string;
  verbalization: string;
  initialValue?: string;
  provenance: Provenance;
}

export interface BomClass {
  /** Fully qualified business name, e.g. `com.acme.loan.Borrower`. */
  fqn: string;
  name: string;
  packageName: string;
  kind: "class" | "interface";
  modifiers: string[];
  superTypes: string[];
  /** Static values when the class has an enumerated domain. */
  domain?: string[];
  properties: Record<string, string>;
  /** Concept label from the vocabulary, e.g. "borrower". */
  label?: string;
  /** True when the class is not backed by a XOM class (B2X maps it, or the BOM entry has no XOM origin). */
  virtual: boolean;
  /** XOM class a virtual class executes as, from B2X. */
  executionName?: string;
  documentation?: string;
  provenance: Provenance;
  bomEntry: string;
}

export interface BomMember {
  /** `<classFqn>.<name>` for attributes, `<classFqn>.<name>(<paramTypes>)` for methods and constructors. */
  id: string;
  owner: string;
  name: string;
  kind: "attribute" | "method" | "constructor";
  type: string;
  params: { type: string; name?: string }[];
  static: boolean;
  final: boolean;
  readonly: boolean;
  /** Raw domain text, e.g. `0,* class string` or `{static A, static B}`. */
  domain?: string;
  properties: Record<string, string>;
  /** True when B2X supplies the implementation (getter, setter or body). */
  virtual: boolean;
  /** B2X implementation text, verbatim. */
  b2x?: string;
  /** Member ids this virtual member is computed from (best effort scan of the B2X text). */
  derivedFrom: string[];
  documentation?: string;
  provenance: Provenance;
}

export type PhraseKind = "navigation" | "action" | "concept" | "parameter";

/** One verbalization, ready to match against BAL. */
export interface Phrase {
  id: string;
  kind: PhraseKind;
  /** Verbalization as written in the .voc, e.g. `{credit score} of {this}`. */
  template: string;
  /** Readable form with the subject filled in, e.g. `the credit score of <borrower>`. */
  text: string;
  /** Class that owns the member (or the concept's class, or the parameter's type). */
  owner: string;
  memberId?: string;
  /** Value type of the phrase: the member type for navigations, the class for concepts and parameters. */
  type?: string;
  /** Slot types for `{this}` and `{0}`, `{1}`… in order of appearance. */
  slots: { name: string; type?: string }[];
  virtual: boolean;
  provenance: Provenance;
}

export interface GlossaryEntry {
  /** Business words, e.g. "debt-to-income". */
  phrase: string;
  /** Phrase texts or member ids it stands for. */
  means: string[];
  note?: string;
}

export interface Edge {
  type:
    | "CONTAINS"
    | "SELECTS"
    | "USES"
    | "RUNS"
    | "BINDS"
    | "DERIVES_FROM"
    | "EXTENDS"
    | "SUBFLOW"
    | "REFERENCES";
  from: string;
  to: string;
  /** Why the edge exists, in words, for impact reasons. */
  detail?: string;
  /** False when the edge was kept because the subject could not be typed (complete, not precise). */
  resolved?: boolean;
}

export interface Warning {
  path: string;
  message: string;
  /** "error": a file or construct could not be read and may hide a rule. "info": noted, no effect on answers. */
  severity: "error" | "info";
}

export interface ProjectInfo {
  name: string;
  /** Workspace-relative folder. */
  folder: string;
  isDecisionService: boolean;
  references: string[];
  sourceFolders: string[];
  bomFolders: string[];
  uuid?: string;
  /** Classic rule projects declare ruleset parameters in the .ruleproject instead of a .var file. */
  parameters?: { name: string; type: string; verbalization: string; direction?: string }[];
}
