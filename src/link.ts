/**
 * Linking: parsed files in, one knowledge model out.
 *
 * Steps, in order:
 *   1. Collect BOM classes and members; apply B2X (virtual classes and members, derived-from).
 *   2. Choose one vocabulary locale; resolve each .voc entry to a class or member.
 *   3. Build phrases (navigation / action / concept / ruleset parameter) with typed slots.
 *   4. Match every rule body, table column, precondition and ruleflow condition against phrases.
 *   5. Build structural edges: package contains, ruleflow selects, operation runs, subflows.
 *
 * Every step that cannot place something writes a Warning. Nothing is dropped silently.
 */
import { BAL_WORDS, compilePattern, PhraseMatcher, stripArticles, tokenizeBal, type PatternItem, type PhraseMatch, type Token, type TypeEnv } from "./bal.ts";
import type { Artifact, BomClass, BomMember, Edge, GlossaryEntry, Phrase, ProjectInfo, Variable, Warning } from "./model.ts";
import { RULE_KINDS } from "./model.ts";
import type { B2xClass, ParsedB2x } from "./parse/b2x.ts";
import type { ParsedBom } from "./parse/bom.ts";
import type { ParsedVoc } from "./parse/voc.ts";
import { normalize, splitIdentifier } from "./text.ts";

export interface ParsedFile {
  path: string;
  hash: string;
  project: string;
  kind: "artifact" | "bom" | "voc" | "b2x";
  artifacts?: Artifact[];
  bom?: ParsedBom;
  voc?: ParsedVoc;
  b2x?: ParsedB2x;
  warnings: Warning[];
}

/** A place in an artifact where a vocabulary term is used. */
export interface Use {
  /** Member id, class fqn, or `var:<name>`. */
  target: string;
  phraseId?: string;
  /** conditions | actions | elseActions | definitions | preconditions | column:<id> | transition:<id> | task:<id> | irl */
  where: string;
  /** Exact text that matched. */
  text: string;
  resolved: boolean;
  /** For a setter or `make it true that`: the rule writes this member. */
  writes?: boolean;
}

export interface LinkInput {
  decisionService: string;
  projects: ProjectInfo[];
  files: ParsedFile[];
  locale?: string;
  glossary: GlossaryEntry[];
  /**
   * Uses of each artifact from the previous link, keyed by vocabulary signature,
   * artifact id and file hash. Unchanged artifacts against an unchanged
   * vocabulary are not matched again. The map is updated in place.
   */
  useCache?: Map<string, CachedUses>;
}

export interface CachedUses {
  list: Use[];
  /** Matching notes for this artifact (e.g. an untyped definition), replayed on reuse. */
  warnings: Warning[];
}

export interface Linked {
  artifacts: Map<string, Artifact>;
  classes: Map<string, BomClass>;
  members: Map<string, BomMember>;
  membersByClass: Map<string, BomMember[]>;
  phrases: Map<string, Phrase>;
  variables: Map<string, Variable>;
  uses: Map<string, Use[]>;
  usedBy: Map<string, { artifactId: string; use: Use }[]>;
  edges: Edge[];
  warnings: Warning[];
  locale?: string;
  matcher: PhraseMatcher;
  env: TypeEnv;
  glossary: GlossaryEntry[];
  /** Ancestors of each class (not including itself), nearest first. */
  ancestors: Map<string, string[]>;
}

export function link(input: LinkInput): Linked {
  const warnings: Warning[] = [];
  for (const file of input.files) warnings.push(...file.warnings);

  // ---- 1. BOM ---------------------------------------------------------------
  const classes = new Map<string, BomClass>();
  const members = new Map<string, BomMember>();
  for (const file of input.files) {
    if (!file.bom) continue;
    const xomBacked = Boolean(file.bom.properties.origin);
    for (const klass of file.bom.classes) {
      if (classes.has(klass.fqn)) {
        warnings.push({ path: file.path, severity: "error", message: `class ${klass.fqn} is also defined in ${classes.get(klass.fqn)?.provenance.path}; keeping the first` });
        continue;
      }
      classes.set(klass.fqn, { ...klass, virtual: !xomBacked, provenance: { ...klass.provenance, project: file.project } });
    }
    for (const member of file.bom.members) {
      if (members.has(member.id)) {
        warnings.push({ path: file.path, severity: "error", message: `member ${member.id} is defined twice` });
        continue;
      }
      members.set(member.id, { ...member, provenance: { ...member.provenance, project: file.project } });
    }
  }
  const membersByClass = new Map<string, BomMember[]>();
  for (const member of members.values()) {
    const list = membersByClass.get(member.owner) ?? [];
    list.push(member);
    membersByClass.set(member.owner, list);
  }

  const ancestors = new Map<string, string[]>();
  const resolveTypeName = (name: string, from: BomClass): string => {
    if (classes.has(name)) return name;
    const sibling = from.packageName ? `${from.packageName}.${name}` : name;
    if (classes.has(sibling)) return sibling;
    return name;
  };
  for (const klass of classes.values()) {
    klass.superTypes = klass.superTypes.map((name) => resolveTypeName(name, klass));
    for (const member of membersByClass.get(klass.fqn) ?? []) {
      member.type = resolveTypeName(member.type, klass);
      member.params = member.params.map((param) => ({ ...param, type: resolveTypeName(param.type, klass) }));
    }
  }
  for (const klass of classes.values()) {
    const out: string[] = [];
    const seen = new Set<string>([klass.fqn]);
    const queue = [...klass.superTypes];
    while (queue.length) {
      const next = queue.shift() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      out.push(next);
      queue.push(...(classes.get(next)?.superTypes ?? []));
    }
    ancestors.set(klass.fqn, out);
  }

  // B2X: virtual classes and members, and what virtual members are computed from.
  for (const file of input.files) {
    if (!file.b2x) continue;
    for (const b2xClass of file.b2x.classes) applyB2x(b2xClass, file, classes, membersByClass, ancestors, warnings);
  }

  // ---- 2. Vocabulary --------------------------------------------------------
  const vocs = input.files.filter((file) => file.voc).map((file) => file.voc as ParsedVoc);
  const locale = chooseLocale(input, vocs, warnings);
  const labels = new Map<string, string>();
  const verbalizations: { owner: string; memberId?: string; kind: "navigation" | "action"; template: string; path: string; project: string }[] = [];
  for (const voc of vocs) {
    if (!localeMatches(voc.locale, locale)) continue;
    for (const entry of voc.entries) {
      const resolved = resolveOwner(entry.owner, classes, membersByClass);
      if (!resolved) {
        warnings.push({ path: voc.provenance.path, severity: "error", message: `line ${entry.line}: '${entry.owner}' is not a BOM class or member` });
        continue;
      }
      if (entry.key === "concept.label") {
        if (resolved.memberId) {
          warnings.push({ path: voc.provenance.path, severity: "info", message: `line ${entry.line}: concept label on a member is ignored` });
          continue;
        }
        labels.set(resolved.classFqn, entry.value);
        continue;
      }
      if (entry.key !== "phrase.navigation" && entry.key !== "phrase.action") continue;
      if (!resolved.memberId) {
        warnings.push({ path: voc.provenance.path, severity: "info", message: `line ${entry.line}: phrase on a class (no member) is ignored` });
        continue;
      }
      verbalizations.push({
        owner: resolved.classFqn,
        memberId: resolved.memberId,
        kind: entry.key === "phrase.navigation" ? "navigation" : "action",
        // `{0, <country>}` is slot 0 with an editor hint; the hint is not part of the text.
        template: entry.value.replace(/\{\s*(\d+)\s*,[^}]*\}/g, "{$1}"),
        path: voc.provenance.path,
        project: voc.provenance.project,
      });
    }
  }
  for (const [fqn, label] of labels) {
    const klass = classes.get(fqn);
    if (klass) klass.label = label;
  }

  // ---- 3. Phrases -----------------------------------------------------------
  const phrases = new Map<string, Phrase>();
  const patterns: { phrase: Phrase; items: PatternItem[] }[] = [];
  const labelOf = (fqn: string | undefined) => (fqn ? (classes.get(fqn)?.label ?? classes.get(fqn)?.name ?? fqn) : "?");
  for (const klass of classes.values()) {
    const label = klass.label ?? splitIdentifier(klass.name);
    const phrase: Phrase = {
      id: `concept:${klass.fqn}`,
      kind: "concept",
      template: label,
      text: label,
      owner: klass.fqn,
      type: klass.fqn,
      slots: [],
      virtual: klass.virtual,
      provenance: klass.provenance,
    };
    phrases.set(phrase.id, phrase);
    patterns.push({ phrase, items: compilePattern(label).items });
  }
  for (const verbalization of verbalizations) {
    const member = members.get(verbalization.memberId as string) as BomMember;
    const valueTerm = verbalization.kind === "action" && member.kind === "attribute" ? lastBraceTerm(verbalization.template) : undefined;
    const { items, slotNames } = compilePattern(verbalization.template, valueTerm);
    const slots = slotNames.map((name) => {
      if (name === "this") return { name, type: member.owner };
      if (/^\d+$/.test(name)) return { name, type: member.params[Number(name)]?.type };
      return { name, type: member.type };
    });
    const text = renderTemplate(verbalization.template, slots, labelOf, valueTerm);
    const phrase: Phrase = {
      id: `${verbalization.kind}:${member.id}${phrases.has(`${verbalization.kind}:${member.id}`) ? `#${phrases.size}` : ""}`,
      kind: verbalization.kind,
      template: verbalization.template,
      text,
      owner: member.owner,
      memberId: member.id,
      type: verbalization.kind === "navigation" ? member.type : undefined,
      slots,
      virtual: member.virtual,
      provenance: { project: verbalization.project, path: verbalization.path },
    };
    if (!items.some((item) => "lit" in item)) {
      warnings.push({
        path: verbalization.path,
        severity: "info",
        message: `verbalization '${verbalization.template}' of ${member.id} has no words, so its uses in rules are not detected`,
      });
      continue;
    }
    phrases.set(phrase.id, phrase);
    patterns.push({ phrase, items });
  }

  // Ruleset parameters (variable sets) become variables and parameter phrases.
  const variables = new Map<string, Variable>();
  const artifacts = new Map<string, Artifact>();
  for (const file of input.files) {
    for (const artifact of file.artifacts ?? []) {
      if (artifacts.has(artifact.id)) {
        const prior = artifacts.get(artifact.id) as Artifact;
        if (artifact.type === "package" && prior.type === "package") continue; // same package in two projects
        warnings.push({ path: artifact.provenance.path, severity: "error", message: `id ${artifact.id} is also used by ${prior.provenance.path}` });
        continue;
      }
      artifacts.set(artifact.id, artifact);
    }
  }
  for (const project of input.projects) {
    if (!project.parameters?.length) continue;
    const path = `${project.folder === "." ? "" : `${project.folder}/`}.ruleproject`;
    const id = `params:${project.name}`;
    artifacts.set(id, {
      id,
      type: "variableSet",
      name: `${project.name} ruleset parameters`,
      package: "",
      provenance: { project: project.name, path },
      variables: project.parameters.map((item) => ({
        name: item.name,
        type: item.type,
        verbalization: item.verbalization,
        provenance: { project: project.name, path },
      })),
    });
  }
  for (const artifact of artifacts.values()) {
    if (artifact.type !== "variableSet") continue;
    for (const variable of artifact.variables ?? []) {
      const key = stripArticles(normalize(variable.verbalization));
      if (!classes.has(variable.type) && !isPrimitive(variable.type)) {
        warnings.push({ path: artifact.provenance.path, severity: "error", message: `variable '${variable.name}' has type ${variable.type}, which is not in the BOM` });
      }
      variables.set(key, variable);
      const nameKey = normalize(variable.name);
      if (!variables.has(nameKey)) variables.set(nameKey, variable);
      const phrase: Phrase = {
        id: `parameter:${variable.name}`,
        kind: "parameter",
        template: variable.verbalization,
        text: variable.verbalization,
        owner: variable.type,
        type: variable.type,
        slots: [],
        virtual: false,
        provenance: variable.provenance,
      };
      phrases.set(phrase.id, phrase);
    }
  }

  const concepts = new Map<string, string>();
  for (const klass of classes.values()) {
    const label = stripArticles(normalize(klass.label ?? splitIdentifier(klass.name)));
    if (!label) continue;
    concepts.set(label, klass.fqn);
    concepts.set(`${label}s`, klass.fqn);
  }
  const isAssignable = (type: string, to: string) => {
    if (type === to) return true;
    if (ancestors.get(type)?.includes(to)) return true;
    // `java.lang.Object` accepts anything; primitives only match their category.
    return to === "java.lang.Object";
  };
  const env: TypeEnv = {
    variables: new Map([...variables].map(([key, variable]) => [key, variable.type])),
    concepts,
    isAssignable,
  };
  const matcher = new PhraseMatcher(patterns);

  // ---- 4. Uses --------------------------------------------------------------
  const uses = new Map<string, Use[]>();
  // Everything matching depends on besides the artifact itself.
  const vocabularyKey = input.files
    .filter((file) => file.kind !== "artifact" || (file.artifacts ?? []).some((artifact) => artifact.type === "variableSet"))
    .map((file) => `${file.path}:${file.hash}`)
    .sort()
    .join("|") + `|${locale ?? ""}|${JSON.stringify(input.projects.map((project) => project.parameters ?? []))}`;
  const fileHash = new Map<string, string>();
  for (const file of input.files) for (const artifact of file.artifacts ?? []) fileHash.set(artifact.id, file.hash);
  const useCache = input.useCache;
  const liveKeys = new Set<string>();
  const memberNames = new Map<string, string[]>();
  for (const member of members.values()) {
    const list = memberNames.get(member.name) ?? [];
    list.push(member.id);
    memberNames.set(member.name, list);
  }
  for (const artifact of artifacts.values()) {
    const cacheKey = useCache ? `${vocabularyKey}\u0000${artifact.id}\u0000${fileHash.get(artifact.id) ?? ""}` : "";
    const cached = useCache?.get(cacheKey);
    if (cached) {
      uses.set(artifact.id, cached.list);
      warnings.push(...cached.warnings);
      liveKeys.add(cacheKey);
      continue;
    }
    const list: Use[] = [];
    const warningsBefore = warnings.length;
    const localEnv = withDefinitions(env, artifact, matcher, warnings);
    const scan = (text: string | undefined, where: string) => {
      if (!text) return;
      const tokens = tokenizeBal(text);
      for (const match of matcher.match(tokens, localEnv)) list.push(...usesFromMatch(match, where, text, tokens));
      for (const token of tokens) {
        if (token.kind !== "var") continue;
        const variable = localEnv.variables.get(token.value);
        const global = variables.get(token.value);
        if (global) list.push({ target: `var:${global.name}`, where, text: `'${token.raw}'`, resolved: true });
        else if (!variable) {
          warnings.push({ path: artifact.provenance.path, severity: "info", message: `'${token.raw}' in ${where} is not a ruleset or rule variable` });
        }
      }
    };
    if (RULE_KINDS.includes(artifact.type as never)) {
      scan(artifact.definitions, "definitions");
      scan(artifact.conditions, "conditions");
      scan(artifact.actions, "actions");
      scan(artifact.elseActions, "elseActions");
      scan(artifact.preconditions, "preconditions");
      if (artifact.type === "decisionTree") scan(artifact.bal, "tree");
      for (const column of artifact.columns ?? []) scan(column.template, `column:${column.id}`);
      if (artifact.irl) list.push(...irlUses(artifact.irl, memberNames, members, classes));
    }
    if (artifact.type === "ruleflow") {
      for (const transition of artifact.transitions ?? []) scan(transition.condition, `transition:${transition.id}`);
      for (const task of artifact.tasks ?? []) {
        scan(task.filter, `task:${task.id}`);
        scan(task.actions, `task:${task.id}`);
      }
    }
    const final = dedupeUses(list);
    uses.set(artifact.id, final);
    if (useCache) {
      useCache.set(cacheKey, { list: final, warnings: warnings.slice(warningsBefore) });
      liveKeys.add(cacheKey);
    }
  }
  if (useCache) for (const key of [...useCache.keys()]) if (!liveKeys.has(key)) useCache.delete(key);
  const usedBy = new Map<string, { artifactId: string; use: Use }[]>();
  for (const [artifactId, list] of uses) {
    for (const use of list) {
      const entry = usedBy.get(use.target) ?? [];
      entry.push({ artifactId, use });
      usedBy.set(use.target, entry);
    }
  }

  // ---- 5. Structure ---------------------------------------------------------
  const edges: Edge[] = [];
  const packages = new Set<string>();
  for (const artifact of artifacts.values()) if (artifact.type === "package") packages.add(artifact.name);
  for (const artifact of artifacts.values()) {
    if (!RULE_KINDS.includes(artifact.type as never) || !artifact.package) continue;
    if (!packages.has(artifact.package)) {
      packages.add(artifact.package);
      artifacts.set(`pkg:${artifact.package}`, {
        id: `pkg:${artifact.package}`,
        type: "package",
        name: artifact.package,
        package: artifact.package,
        provenance: { project: artifact.provenance.project, path: artifact.provenance.path.replace(/\/[^/]+$/, "") },
      });
    }
  }
  // Parent packages: a.b is inside a.
  for (const name of [...packages]) {
    const parts = name.split(".");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join(".");
      if (packages.has(parent)) edges.push({ type: "CONTAINS", from: `pkg:${parent}`, to: `pkg:${parts.slice(0, i + 1).join(".")}` });
    }
  }
  const rulesByName = new Map<string, string[]>();
  for (const artifact of artifacts.values()) {
    if (!RULE_KINDS.includes(artifact.type as never)) continue;
    if (artifact.package) edges.push({ type: "CONTAINS", from: `pkg:${artifact.package}`, to: artifact.id });
    for (const key of [artifact.name, artifact.package ? `${artifact.package}.${artifact.name}` : artifact.name]) {
      const list = rulesByName.get(key) ?? [];
      if (!list.includes(artifact.id)) list.push(artifact.id);
      rulesByName.set(key, list);
    }
  }
  const flowsByName = new Map<string, Artifact>();
  for (const artifact of artifacts.values()) {
    if (artifact.type !== "ruleflow") continue;
    flowsByName.set(artifact.name, artifact);
    if (artifact.package) flowsByName.set(`${artifact.package}.${artifact.name}`, artifact);
  }
  for (const flow of artifacts.values()) {
    if (flow.type !== "ruleflow") continue;
    for (const task of flow.tasks ?? []) {
      const reason = taskReason(flow, task.id);
      for (const name of task.packages) {
        if (!packages.has(name)) {
          warnings.push({ path: flow.provenance.path, severity: "error", message: `task '${task.id}' selects package '${name}', which is not in the decision service` });
          continue;
        }
        edges.push({ type: "SELECTS", from: `${flow.id}#${task.id}`, to: `pkg:${name}`, detail: reason });
      }
      for (const name of task.rules) {
        const ids = rulesByName.get(name) ?? (artifacts.has(name) ? [name] : []);
        if (!ids.length) {
          warnings.push({ path: flow.provenance.path, severity: "error", message: `task '${task.id}' selects rule '${name}', which is not in the decision service` });
          continue;
        }
        for (const id of ids) edges.push({ type: "SELECTS", from: `${flow.id}#${task.id}`, to: id, detail: reason });
      }
      if (task.kind === "subflow" && task.subflow) {
        const target = flowsByName.get(task.subflow) ?? [...artifacts.values()].find((item) => item.type === "ruleflow" && item.id === task.subflow);
        if (target) edges.push({ type: "SUBFLOW", from: `${flow.id}#${task.id}`, to: target.id, detail: reason });
        else warnings.push({ path: flow.provenance.path, severity: "error", message: `subflow task '${task.id}' runs '${task.subflow}', which is not found` });
      }
    }
  }
  for (const op of artifacts.values()) {
    if (op.type !== "decisionOperation" || !op.operation) continue;
    const info = op.operation;
    const flow =
      (info.ruleflowUuid ? artifacts.get(info.ruleflowUuid) : undefined) ??
      (info.ruleflowName ? flowsByName.get(info.ruleflowName) : undefined);
    if (flow) edges.push({ type: "RUNS", from: op.id, to: flow.id, detail: info.rulesetName });
    else if (info.ruleflowName || info.ruleflowUuid) {
      warnings.push({ path: op.provenance.path, severity: "error", message: `operation runs ruleflow '${info.ruleflowName ?? info.ruleflowUuid}', which is not found` });
    }
    for (const input of info.signature) {
      const variable = [...variables.values()].find((item) => item.name === input.name);
      if (variable) edges.push({ type: "BINDS", from: op.id, to: `var:${variable.name}`, detail: input.direction });
      else warnings.push({ path: op.provenance.path, severity: "error", message: `signature names '${input.name}', which is not a ruleset parameter` });
    }
  }
  for (const klass of classes.values()) {
    for (const parent of klass.superTypes) edges.push({ type: "EXTENDS", from: klass.fqn, to: parent });
  }
  for (const member of members.values()) {
    for (const source of member.derivedFrom) edges.push({ type: "DERIVES_FROM", from: member.id, to: source, detail: "B2X" });
  }

  // Glossary entries must point at real terms; a stale entry is an error, not a silent miss.
  for (const entry of input.glossary) {
    for (const target of entry.means) {
      if (members.has(target) || classes.has(target) || phrases.has(target)) continue;
      const tokens = tokenizeBal(target);
      const found = matcher.match(tokens, env).some((match) => match.from === 0 && match.to === tokens.length);
      if (!found) {
        warnings.push({ path: "rulebase.glossary.yaml", severity: "error", message: `'${entry.phrase}' means '${target}', which is not a vocabulary term` });
      }
    }
  }

  return {
    artifacts,
    classes,
    members,
    membersByClass,
    phrases,
    variables,
    uses,
    usedBy,
    edges,
    warnings,
    locale,
    matcher,
    env,
    glossary: input.glossary,
    ancestors,
  };

  function taskReason(flow: Artifact, taskId: string): string {
    const incoming = (flow.transitions ?? []).filter((transition) => transition.target === taskId && transition.condition);
    const task = flow.tasks?.find((item) => item.id === taskId);
    const parts = [`ruleflow '${flow.name}' task '${taskId}'`];
    if (task?.filter) parts.push(`filter: ${task.filter}`);
    if (incoming.length) parts.push(`reached when: ${incoming.map((item) => item.condition).join(" | ")}`);
    return parts.join("; ");
  }
}

function applyB2x(
  b2xClass: B2xClass,
  file: ParsedFile,
  classes: Map<string, BomClass>,
  membersByClass: Map<string, BomMember[]>,
  ancestors: Map<string, string[]>,
  warnings: Warning[],
) {
  const klass = classes.get(b2xClass.businessName);
  if (!klass) {
    warnings.push({ path: file.path, severity: "error", message: `B2X maps ${b2xClass.businessName}, which is not a BOM class` });
    return;
  }
  if (b2xClass.executionName && b2xClass.executionName !== b2xClass.businessName) {
    klass.virtual = true;
    klass.executionName = b2xClass.executionName;
  }
  const own = membersByClass.get(klass.fqn) ?? [];
  const reachable = [klass.fqn, ...(ancestors.get(klass.fqn) ?? [])].flatMap((fqn) => membersByClass.get(fqn) ?? []);
  for (const b2xMember of b2xClass.members) {
    const candidates = own.filter(
      (member) =>
        member.name === b2xMember.name &&
        (b2xMember.kind === "attribute" ? member.kind === "attribute" : member.kind !== "attribute" && member.params.length === b2xMember.paramTypes.length),
    );
    if (!candidates.length && b2xMember.name.includes(".")) {
      // `.b2xa` writes a conversion operator as a method named after its target type.
      const target = b2xMember.name;
      candidates.push(
        ...own.filter((member) => member.name === "operator" && (member.type === target || member.type.split(".").pop() === target.split(".").pop()) && member.params.length === b2xMember.paramTypes.length),
      );
    }
    if (!candidates.length) {
      warnings.push({ path: file.path, severity: "error", message: `B2X implements ${klass.fqn}.${b2xMember.name}, which is not a BOM member` });
      continue;
    }
    for (const member of candidates) {
      member.virtual = true;
      member.b2x = b2xMember.implementation;
      member.derivedFrom = derivedFrom(b2xMember.implementation, member, reachable);
    }
  }
}

/** Members of the same class (or its ancestors) mentioned in B2X code: `this.x`, `x`, `getX()`, `isX()`. */
function derivedFrom(code: string, self: BomMember, reachable: BomMember[]): string[] {
  const identifiers = new Set<string>();
  const stripped = code.replace(/"(?:[^"\\]|\\.)*"/g, " ");
  for (const match of stripped.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) identifiers.add(match[1]);
  const out = new Set<string>();
  for (const member of reachable) {
    if (member.id === self.id) continue;
    const getter = `get${member.name[0]?.toUpperCase()}${member.name.slice(1)}`;
    const isser = `is${member.name[0]?.toUpperCase()}${member.name.slice(1)}`;
    if (identifiers.has(member.name) || identifiers.has(getter) || identifiers.has(isser)) out.add(member.id);
  }
  return [...out].sort();
}

function chooseLocale(input: LinkInput, vocs: ParsedVoc[], warnings: Warning[]): string | undefined {
  const available = [...new Set(vocs.map((voc) => voc.locale).filter((item): item is string => Boolean(item)))];
  if (input.locale) {
    if (vocs.length && !vocs.some((voc) => localeMatches(voc.locale, input.locale))) {
      warnings.push({ path: "rulebase.yaml", severity: "error", message: `locale '${input.locale}' has no vocabulary file (found: ${available.join(", ") || "none"})` });
    }
    return input.locale;
  }
  const counts = new Map<string, number>();
  for (const file of input.files) {
    for (const artifact of file.artifacts ?? []) {
      if (artifact.locale) counts.set(artifact.locale, (counts.get(artifact.locale) ?? 0) + 1);
    }
  }
  const ruleLocale = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (ruleLocale && vocs.some((voc) => localeMatches(voc.locale, ruleLocale))) {
    if (available.length > 1) {
      warnings.push({ path: "rulebase.yaml", severity: "info", message: `vocabulary has locales ${available.join(", ")}; using ${ruleLocale}, the locale most rules use` });
    }
    return ruleLocale;
  }
  if (available.length > 1) {
    warnings.push({ path: "rulebase.yaml", severity: "error", message: `vocabulary has locales ${available.join(", ")} and none matches the rules; set 'locale:' in rulebase.yaml` });
  }
  return available[0];
}

/** `en` matches `en_US`; a .voc without a locale suffix matches anything. */
export function localeMatches(vocLocale: string | undefined, wanted: string | undefined): boolean {
  if (!vocLocale || !wanted) return true;
  const a = vocLocale.toLowerCase();
  const b = wanted.toLowerCase();
  return a === b || b.startsWith(`${a}_`) || a.startsWith(`${b}_`);
}

/** Longest prefix that is a class wins: `a.b.C.d` -> class `a.b.C`, member `d`. */
function resolveOwner(
  owner: string,
  classes: Map<string, BomClass>,
  membersByClass: Map<string, BomMember[]>,
): { classFqn: string; memberId?: string } | null {
  const paren = owner.indexOf("(");
  const head = paren >= 0 ? owner.slice(0, paren) : owner;
  const args = paren >= 0 ? owner.slice(paren + 1, owner.lastIndexOf(")")) : null;
  if (classes.has(head) && args === null) return { classFqn: head };
  const dot = head.lastIndexOf(".");
  if (dot < 0) return null;
  const classFqn = head.slice(0, dot);
  const name = head.slice(dot + 1);
  if (!classes.has(classFqn)) return null;
  const candidates = (membersByClass.get(classFqn) ?? []).filter((member) => member.name === name);
  if (!candidates.length) return null;
  if (args === null) {
    const attribute = candidates.find((member) => member.kind === "attribute");
    return { classFqn, memberId: (attribute ?? candidates[0]).id };
  }
  const argTypes = args ? args.split(",").map((item) => item.trim()) : [];
  const exact = candidates.find(
    (member) => member.kind !== "attribute" && member.params.length === argTypes.length && member.params.every((param, i) => sameType(param.type, argTypes[i])),
  );
  const byCount = candidates.find((member) => member.kind !== "attribute" && member.params.length === argTypes.length);
  const chosen = exact ?? byCount;
  return chosen ? { classFqn, memberId: chosen.id } : null;
}

/** BOM writes `string`, the .voc writes `java.lang.String`. */
function sameType(a: string, b: string): boolean {
  const canon = (t: string) => {
    const x = t.trim();
    const map: Record<string, string> = { "java.lang.String": "string", "java.lang.Boolean": "boolean", "java.lang.Integer": "int", "java.lang.Double": "double" };
    return map[x] ?? x;
  };
  return canon(a) === canon(b) || canon(a).split(".").pop() === canon(b).split(".").pop();
}

function isPrimitive(type: string): boolean {
  return /^(int|long|short|byte|double|float|boolean|char|string|java\.lang\.\w+|java\.util\.\w+|java\.math\.\w+)$/.test(type);
}

function lastBraceTerm(template: string): string | undefined {
  const braces = [...template.matchAll(/\{([^}]*)\}/g)].map((match) => match[1].trim()).filter((name) => name !== "this" && !/^\d+$/.test(name));
  return braces[braces.length - 1];
}

function renderTemplate(
  template: string,
  slots: { name: string; type?: string }[],
  labelOf: (fqn: string | undefined) => string,
  valueTerm?: string,
): string {
  let valueDone = false;
  const lastValue = valueTerm
    ? [...template.matchAll(/\{([^}]*)\}/g)].map((match) => match.index ?? 0).filter((_, i, all) => i === all.length - 1)[0]
    : -1;
  return template
    .replace(/\{([^}]*)\}/g, (whole, name: string, offset: number) => {
      const trimmed = name.trim();
      if (trimmed === "this") return `<${labelOf(slots.find((slot) => slot.name === "this")?.type)}>`;
      if (/^\d+$/.test(trimmed)) return `<${shortType(slots.find((slot) => slot.name === trimmed)?.type)}>`;
      if (valueTerm && !valueDone && offset === lastValue) {
        valueDone = true;
        return `<${trimmed}>`;
      }
      return trimmed;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function shortType(type: string | undefined): string {
  if (!type) return "value";
  return type.split(".").pop() ?? type;
}

function withDefinitions(env: TypeEnv, artifact: Artifact, matcher: PhraseMatcher, warnings: Warning[]): TypeEnv {
  if (!artifact.definitions) return env;
  const variables = new Map(env.variables);
  const local: TypeEnv = { ...env, variables };
  for (const statement of artifact.definitions.split(";")) {
    // `set 'the applicant' to ...` or, unquoted, `set smartfolder to an ilr smart view in elements`
    const match = /^\s*set\s+(?:'([^']+)'|([A-Za-z_][\w]*))\s+to\s+([\s\S]+)$/i.exec(statement);
    if (!match) continue;
    const raw = match[1] ?? match[2];
    const name = stripArticles(normalize(raw));
    const tokens = tokenizeBal(match[3]);
    const type = expressionType(tokens, local, matcher);
    if (type) variables.set(name, type);
    else {
      variables.set(name, "?");
      warnings.push({ path: artifact.provenance.path, severity: "info", message: `definition '${raw}' could not be typed; uses through it are unresolved` });
    }
  }
  return local;
}

/** Type of `a borrower`, `a borrower where ...`, `an item in the items of 'x'`, or a navigation. */
function expressionType(tokens: Token[], env: TypeEnv, matcher: PhraseMatcher): string | undefined {
  const words: string[] = [];
  for (const token of tokens) {
    if (token.kind !== "word" || ["where", "in", "from", "with"].includes(token.value)) break;
    words.push(token.value);
  }
  for (let n = words.length; n > 0; n--) {
    const concept = env.concepts.get(words.slice(0, n).join(" "));
    if (concept) return concept;
  }
  const matches = matcher.match(tokens, env);
  const nav = matches.find((match) => match.from === 0 && match.compiled.phrase.kind === "navigation");
  return nav?.compiled.phrase.type;
}

function usesFromMatch(match: PhraseMatch, where: string, text: string, tokens: Token[]): Use[] {
  const phrase = match.compiled.phrase;
  const target = phrase.memberId ?? phrase.owner;
  const start = tokens[match.from]?.at ?? 0;
  const end = tokens[match.to - 1]?.end ?? text.length;
  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  const writes = phrase.kind === "action" && /^\s*(set|make it)\b/i.test(phrase.template);
  return [{ target, phraseId: phrase.id, where, text: snippet, resolved: match.resolved, ...(writes ? { writes } : {}) }];
}

/**
 * IRL (technical rules, functions): best effort, never silent.
 *   ?b: com.acme.Borrower(creditScore < 300)   -> creditScore on Borrower (resolved)
 *   ?b.setFrozen(true)                          -> frozen on ?b's class, a write (resolved)
 *   x.amount, x.getAmount()                     -> every member with that name (unresolved if ambiguous)
 */
function irlUses(irl: string, memberNames: Map<string, string[]>, members: Map<string, BomMember>, classes: Map<string, BomClass>): Use[] {
  const out: Use[] = [];
  const code = irl.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const classOf = (name: string) => {
    if (classes.has(name)) return name;
    const matches = [...classes.keys()].filter((fqn) => fqn.endsWith(`.${name}`));
    return matches.length === 1 ? matches[0] : undefined;
  };
  const memberOn = (fqn: string, name: string) => {
    const owners = [fqn];
    for (let i = 0; i < owners.length; i++) owners.push(...(classes.get(owners[i])?.superTypes ?? []));
    for (const owner of owners) {
      const id = (memberNames.get(name) ?? []).find((item) => members.get(item)?.owner === owner);
      if (id) return id;
    }
    return undefined;
  };
  const push = (target: string, text: string, resolved: boolean, writes = false) => {
    if (out.some((use) => use.target === target && use.text === text)) return;
    out.push({ target, where: "irl", text, resolved, ...(writes ? { writes } : {}) });
  };
  const accessor = (name: string): { name: string; writes: boolean } => {
    const m = /^(get|is|set)([A-Z][\w$]*)$/.exec(name);
    if (!m) return { name, writes: false };
    return { name: m[2][0].toLowerCase() + m[2].slice(1), writes: m[1] === "set" };
  };
  const bindings = new Map<string, string>();
  const classSpans: [number, number][] = [];
  // Class patterns: `?b: Class(...)` or `Class(...)` at the start of a condition.
  for (const match of code.matchAll(/(?:\?(\w+)\s*:\s*)?([A-Za-z_][\w.$]*)\s*\(/g)) {
    const fqn = classOf(match[2]);
    if (!fqn) continue;
    if (match[1]) bindings.set(match[1], fqn);
    const open = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let i = open;
    while (i < code.length && depth > 0) {
      if (code[i] === "(") depth++;
      if (code[i] === ")") depth--;
      i++;
    }
    classSpans.push([match.index ?? 0, i]);
    const body = code.slice(open, i - 1);
    for (const field of body.matchAll(/(?<![.\w?$])([a-z_$][\w$]*)\b(?!\s*\()/g)) {
      const id = memberOn(fqn, field[1]);
      if (id) push(id, `${match[2]}(${field[1]} ...)`, true);
    }
  }
  // Member access: `?b.x`, `?b.setX(`, `obj.x`.
  for (const match of code.matchAll(/(\?\w+|[A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    const at = match.index ?? 0;
    if (classSpans.some(([from, to]) => at >= from && at < to && /^[A-Za-z_]/.test(match[1]) && classOf(`${match[1]}.${match[2]}`))) continue;
    if (classOf(`${match[1]}.${match[2]}`) || /^[a-z]+$/.test(match[1]) && [...classes.keys()].some((fqn) => fqn.startsWith(`${match[1]}.`))) continue;
    const { name, writes } = accessor(match[2]);
    const bound = match[1].startsWith("?") ? bindings.get(match[1].slice(1)) : undefined;
    if (bound) {
      const id = memberOn(bound, name);
      if (id) push(id, `${match[1]}.${match[2]}`, true, writes);
      continue;
    }
    const candidates = (memberNames.get(name) ?? []).filter((id) => members.get(id)?.kind !== "constructor");
    for (const id of candidates) push(id, `${match[1]}.${match[2]}`, candidates.length === 1, writes);
  }
  return out;
}

function dedupeUses(list: Use[]): Use[] {
  const seen = new Set<string>();
  return list.filter((use) => {
    const key = `${use.target}|${use.where}|${use.text}|${use.resolved}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export { BAL_WORDS };
