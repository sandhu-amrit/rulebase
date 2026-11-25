/**
 * The queries behind the MCP tools. Read-only over a linked model.
 * Every answer is small: summaries and ids, with `get_artifact` for detail.
 */
import { BAL_WORDS, stripArticles, tokenizeBal } from "./bal.js";
import { RULE_KINDS } from "./model.js";
import { renderCell } from "./parse/artifacts.js";
import { typeCategory } from "./parse/bom.js";
import { analyzeFlow, describePaths, describeTaskSettings } from "./flow.js";
import { SearchIndex } from "./search.js";
import { editDistance, normalize, splitIdentifier, stem } from "./text.js";
const COMPARISON = ["less than", "more than", "greater than", "at least", "at most", "between", "below", "above", "under", "over"];
export class KnowledgeBase {
    model;
    meta;
    /** Set when a later rebuild failed: these answers are from an older index. */
    stale;
    ruleSearch;
    termSearch;
    selectionByPackage = new Map();
    selectionByRule = new Map();
    flowsRunBy = new Map();
    subflowParents = new Map();
    derivedTo = new Map();
    phrasesByMember = new Map();
    rulesByNormalizedName = new Map();
    flows = new Map();
    constructor(model, meta) {
        this.model = model;
        this.meta = meta;
        const rules = [...model.artifacts.values()].filter((item) => RULE_KINDS.includes(item.type) || item.type === "ruleflow");
        this.ruleSearch = new SearchIndex(rules.map((item) => ({
            key: item.id,
            fields: [
                { text: item.name, weight: 3 },
                { text: item.package.replace(/\./g, " "), weight: 1 },
                { text: item.documentation ?? "", weight: 1 },
                { text: bodyText(item), weight: 1 },
            ],
        })));
        const termDocs = [];
        for (const phrase of model.phrases.values()) {
            const member = phrase.memberId ? model.members.get(phrase.memberId) : undefined;
            const klass = model.classes.get(phrase.owner);
            termDocs.push({
                key: `phrase:${phrase.id}`,
                fields: [
                    { text: phrase.text.replace(/<[^>]*>/g, " "), weight: 3 },
                    { text: member ? splitIdentifier(member.name) : "", weight: 2 },
                    { text: klass?.label ?? "", weight: 1 },
                    { text: member?.documentation ?? klass?.documentation ?? "", weight: 1 },
                ],
            });
        }
        // Members with no verbalization exist in the BOM but cannot be used in BAL yet.
        const verbalized = new Set([...model.phrases.values()].map((phrase) => phrase.memberId).filter(Boolean));
        for (const member of model.members.values()) {
            if (verbalized.has(member.id) || member.kind === "constructor")
                continue;
            termDocs.push({
                key: `member:${member.id}`,
                fields: [
                    { text: splitIdentifier(member.name), weight: 2 },
                    { text: model.classes.get(member.owner)?.label ?? "", weight: 1 },
                    { text: member.documentation ?? "", weight: 1 },
                ],
            });
        }
        for (const [index, entry] of model.glossary.entries()) {
            termDocs.push({ key: `glossary:${index}`, fields: [{ text: entry.phrase, weight: 3 }, { text: entry.note ?? "", weight: 1 }] });
        }
        this.termSearch = new SearchIndex(termDocs);
        for (const item of rules) {
            for (const key of new Set([normalize(item.name), normalize(`${item.package} ${item.name}`)])) {
                const list = this.rulesByNormalizedName.get(key) ?? [];
                list.push(item.id);
                this.rulesByNormalizedName.set(key, list);
            }
        }
        for (const phrase of model.phrases.values()) {
            if (!phrase.memberId)
                continue;
            const list = this.phrasesByMember.get(phrase.memberId) ?? [];
            list.push(phrase);
            this.phrasesByMember.set(phrase.memberId, list);
        }
        for (const artifact of model.artifacts.values()) {
            if (artifact.type === "ruleflow")
                this.flows.set(artifact.id, analyzeFlow(artifact));
        }
        for (const edge of model.edges) {
            if (edge.type === "SELECTS") {
                const [flow, task] = edge.from.split("#");
                const map = edge.to.startsWith("pkg:") ? this.selectionByPackage : this.selectionByRule;
                const key = edge.to.startsWith("pkg:") ? edge.to.slice(4) : edge.to;
                const list = map.get(key) ?? [];
                // The reason states the full path condition (every path from the start), not just the last transition.
                const ambiguous = edge.detail?.includes("ambiguous rule name") ? `; ${edge.detail.slice(edge.detail.indexOf("ambiguous rule name"))}` : "";
                list.push({ flow, task, reason: `${this.taskReason(flow, task)}${ambiguous}` });
                map.set(key, list);
            }
            if (edge.type === "RUNS") {
                const list = this.flowsRunBy.get(edge.to) ?? [];
                list.push(edge.from);
                this.flowsRunBy.set(edge.to, list);
            }
            if (edge.type === "SUBFLOW") {
                const list = this.subflowParents.get(edge.to) ?? [];
                list.push(edge.from.split("#")[0]);
                this.subflowParents.set(edge.to, list);
            }
            if (edge.type === "DERIVES_FROM") {
                const list = this.derivedTo.get(edge.to) ?? [];
                list.push(edge.from);
                this.derivedTo.set(edge.to, list);
            }
        }
    }
    // ---------------------------------------------------------------- helpers
    taskReason(flowId, taskId) {
        const flow = this.model.artifacts.get(flowId);
        const analysis = this.flows.get(flowId)?.tasks.get(taskId);
        const task = flow?.tasks?.find((item) => item.id === taskId);
        const parts = [`ruleflow '${flow?.name ?? flowId}' task '${taskId}'`];
        if (task?.filter)
            parts.push(`filter: ${task.filter}`);
        if (analysis && !analysis.always)
            parts.push(`reached when: ${describePaths(analysis)}`);
        return parts.join("; ");
    }
    /** Tasks that select a package: directly, or through a parent package (a task selecting `a` runs `a.b` too). */
    tasksSelectingPackage(pkg) {
        const out = [];
        let current = pkg;
        while (current) {
            out.push(...(this.selectionByPackage.get(current) ?? []).map((item) => (current === pkg ? item : { ...item, reason: `${item.reason} (selects parent package '${current}')` })));
            current = current.includes(".") ? current.slice(0, current.lastIndexOf(".")) : "";
        }
        return out;
    }
    /** Whether a task can be reached from its ruleflow's start. */
    taskReachable(flowId, taskId) {
        return this.flows.get(flowId)?.tasks.get(taskId)?.reachable ?? true;
    }
    rules() {
        return [...this.model.artifacts.values()].filter((item) => RULE_KINDS.includes(item.type));
    }
    summary(artifact) {
        return {
            id: artifact.id,
            type: artifact.type,
            name: artifact.name,
            package: artifact.package,
            project: artifact.provenance.project,
            path: artifact.provenance.path,
        };
    }
    checked(extra = {}) {
        const errors = this.model.warnings.filter((warning) => warning.severity === "error");
        return {
            decisionService: this.meta.decisionService,
            indexedAt: this.meta.indexedAt,
            ...(this.meta.branch ? { branch: this.meta.branch } : {}),
            files: this.meta.files,
            rules: this.rules().length,
            projects: this.meta.projects.map((project) => project.name),
            errors: errors.length,
            errorSample: errors.slice(0, 5).map((warning) => `${warning.path}: ${warning.message}`),
            ...(this.stale ? { stale: this.stale } : {}),
            ...extra,
        };
    }
    /** Find an artifact by id, UUID, `package.name`, or a unique name. */
    findArtifact(ref) {
        const direct = this.model.artifacts.get(ref);
        if (direct)
            return { artifact: direct };
        const all = [...this.model.artifacts.values()];
        const pkg = this.model.artifacts.get(`pkg:${ref}`);
        if (pkg) {
            // `eligibility` may be a package and also a rule's name: say so instead of picking one.
            const sameName = all.filter((item) => item.type !== "package" && item.name === ref);
            if (sameName.length)
                return { ambiguous: [pkg, ...sameName].map((item) => this.summary(item)) };
            return { artifact: pkg };
        }
        const qualified = all.filter((item) => item.package && `${item.package}.${item.name}` === ref);
        if (qualified.length === 1)
            return { artifact: qualified[0] };
        const named = all.filter((item) => item.name === ref || item.provenance.path === ref);
        if (named.length === 1)
            return { artifact: named[0] };
        if (named.length > 1)
            return { ambiguous: named.map((item) => this.summary(item)) };
        const lower = ref.toLowerCase();
        const loose = all.filter((item) => item.name.toLowerCase() === lower);
        if (loose.length === 1)
            return { artifact: loose[0] };
        if (loose.length > 1)
            return { ambiguous: loose.map((item) => this.summary(item)) };
        return {};
    }
    labelOf(fqn) {
        if (!fqn)
            return "?";
        const klass = this.model.classes.get(fqn);
        return klass?.label ?? klass?.name ?? fqn;
    }
    membersOf(fqn) {
        const out = [];
        const seen = new Set();
        for (const owner of [fqn, ...(this.model.ancestors.get(fqn) ?? [])]) {
            for (const member of this.model.membersByClass.get(owner) ?? []) {
                const signature = `${member.name}(${member.params.map((param) => param.type).join(",")})${member.kind}`;
                if (seen.has(signature))
                    continue;
                seen.add(signature);
                out.push({ member, ...(owner !== fqn ? { inheritedFrom: owner } : {}) });
            }
        }
        return out;
    }
    phrasesOfMember(memberId) {
        return this.phrasesByMember.get(memberId) ?? [];
    }
    // ---------------------------------------------------------------- tools
    listDecisionServices() {
        const warnings = this.model.warnings;
        const counts = {};
        for (const artifact of this.model.artifacts.values())
            counts[artifact.type] = (counts[artifact.type] ?? 0) + 1;
        return {
            decisionService: this.meta.decisionService,
            workspace: this.meta.workspace,
            projects: this.meta.projects.map((project) => ({
                name: project.name,
                folder: project.folder,
                decisionService: project.isDecisionService,
                references: project.references,
            })),
            counts: {
                ...counts,
                classes: this.model.classes.size,
                members: this.model.members.size,
                virtualMembers: [...this.model.members.values()].filter((member) => member.virtual).length,
                phrases: this.model.phrases.size,
                rulesetParameters: new Set([...this.model.variables.values()].map((variable) => variable.name)).size,
                glossaryEntries: this.model.glossary.length,
            },
            locale: this.model.locale,
            notIndexed: this.meta.skipped,
            warnings: {
                errors: warnings.filter((warning) => warning.severity === "error").map((warning) => `${warning.path}: ${warning.message}`).slice(0, 50),
                infoCount: warnings.filter((warning) => warning.severity === "info").length,
            },
            checked: this.checked(),
        };
    }
    listTerms(input) {
        if (!input.class) {
            const all = [...this.model.classes.values()].sort((a, b) => a.fqn.localeCompare(b.fqn));
            const offset = input.offset ?? 0;
            const limit = input.limit ?? 200;
            return {
                total: all.length,
                offset,
                classes: all.slice(offset, offset + limit).map((klass) => ({
                    class: klass.fqn,
                    label: klass.label ?? null,
                    kind: klass.kind,
                    virtual: klass.virtual,
                    extends: klass.superTypes,
                    members: this.membersOf(klass.fqn).length,
                    ...(klass.domain ? { domain: klass.domain } : {}),
                    ...(klass.documentation ? { documentation: klass.documentation } : {}),
                })),
                hint: "Call list_terms with class=<fqn> to see its members and phrases.",
                checked: this.checked(),
            };
        }
        const klass = this.resolveClass(input.class);
        if (!klass) {
            return { error: `No class '${input.class}'.`, suggestions: this.classSuggestions(input.class), checked: this.checked() };
        }
        return {
            class: klass.fqn,
            label: klass.label ?? null,
            virtual: klass.virtual,
            extends: this.model.ancestors.get(klass.fqn) ?? [],
            ...(klass.domain ? { domain: klass.domain } : {}),
            ...(klass.documentation ? { documentation: klass.documentation } : {}),
            members: this.membersOf(klass.fqn).map(({ member, inheritedFrom }) => ({
                id: member.id,
                kind: member.kind,
                type: member.type,
                ...(member.params.length ? { params: member.params.map((param) => param.type) } : {}),
                ...(member.static ? { static: true } : {}),
                ...(member.readonly ? { readonly: true } : {}),
                ...(member.virtual ? { virtual: true, derivedFrom: member.derivedFrom } : {}),
                ...(member.domain ? { domain: member.domain } : {}),
                ...(inheritedFrom ? { inheritedFrom } : {}),
                ...(member.documentation ? { documentation: member.documentation } : {}),
                phrases: this.phrasesOfMember(member.id).map((phrase) => ({ kind: phrase.kind, text: phrase.text })),
                ...(this.phrasesOfMember(member.id).length ? {} : { verbalized: false }),
            })),
            checked: this.checked(),
        };
    }
    resolveClass(ref) {
        const direct = this.model.classes.get(ref);
        if (direct)
            return direct;
        const lower = ref.toLowerCase();
        const matches = [...this.model.classes.values()].filter((klass) => klass.name.toLowerCase() === lower || (klass.label ?? "").toLowerCase() === lower);
        return matches.length === 1 ? matches[0] : undefined;
    }
    classSuggestions(ref) {
        const lower = ref.toLowerCase();
        return [...this.model.classes.values()]
            .map((klass) => ({ fqn: klass.fqn, d: Math.min(editDistance(lower, klass.name.toLowerCase(), 3), editDistance(lower, (klass.label ?? "").toLowerCase(), 3)) }))
            .filter((item) => item.d <= 3 || item.fqn.toLowerCase().includes(lower))
            .sort((a, b) => a.d - b.d)
            .slice(0, 5)
            .map((item) => item.fqn);
    }
    findTerms(input) {
        const limit = input.limit ?? 15;
        const results = this.termSearch.search(input.query, { limit: limit * 2 });
        const glossary = [];
        const terms = [];
        const seen = new Set();
        const normQuery = normalize(input.query);
        for (const [index, entry] of this.model.glossary.entries()) {
            if (normQuery.includes(normalize(entry.phrase)) || normalize(entry.phrase).includes(normQuery)) {
                if (!seen.has(`glossary:${index}`)) {
                    seen.add(`glossary:${index}`);
                    glossary.push({ phrase: entry.phrase, means: entry.means, ...(entry.note ? { note: entry.note } : {}) });
                }
            }
        }
        for (const result of results) {
            if (seen.has(result.key))
                continue;
            seen.add(result.key);
            if (result.key.startsWith("glossary:")) {
                const entry = this.model.glossary[Number(result.key.slice(9))];
                glossary.push({ phrase: entry.phrase, means: entry.means, ...(entry.note ? { note: entry.note } : {}) });
                continue;
            }
            if (result.key.startsWith("member:")) {
                const member = this.model.members.get(result.key.slice(7));
                if (!member)
                    continue;
                terms.push({
                    text: `${splitIdentifier(member.name)} (${this.labelOf(member.owner)})`,
                    kind: "unverbalized",
                    member: member.id,
                    type: member.type,
                    ...(member.virtual ? { virtual: true } : {}),
                    note: "in the BOM but has no verbalization, so rules cannot use it yet",
                    matched: result.matched.filter((item) => item.query !== item.term).map((item) => `${item.query}→${item.term}`),
                    score: Math.round(result.score * 100) / 100,
                });
                if (terms.length >= limit)
                    break;
                continue;
            }
            const phrase = this.model.phrases.get(result.key.slice(7));
            if (!phrase)
                continue;
            const member = phrase.memberId ? this.model.members.get(phrase.memberId) : undefined;
            terms.push({
                text: phrase.text,
                kind: phrase.kind,
                ...(member ? { member: member.id, type: member.type } : { class: phrase.owner }),
                ...(phrase.virtual ? { virtual: true } : {}),
                ...(member?.documentation ? { documentation: member.documentation } : {}),
                matched: result.matched.filter((item) => item.query !== item.term).map((item) => `${item.query}→${item.term}`),
                score: Math.round(result.score * 100) / 100,
            });
            if (terms.length >= limit)
                break;
        }
        for (const item of terms)
            if (!item.matched.length)
                delete item.matched;
        return {
            query: input.query,
            glossary,
            terms,
            ...(terms.length || glossary.length
                ? {}
                : { note: "No term matched. Try other words, or browse with list_terms: if a term is not listed there, it is not in the vocabulary." }),
            checked: this.checked(),
        };
    }
    /** Strict check of BAL-like phrases. Every content word must be vocabulary, a BAL word, a literal, or a known variable. */
    validatePhrases(input) {
        const results = input.phrases.map((text) => this.validateOne(text));
        return { ok: results.every((result) => result.ok), results, checked: this.checked() };
    }
    validateOne(text) {
        const tokens = tokenizeBal(text);
        const matches = this.model.matcher.match(tokens, this.model.env);
        const covered = new Set();
        const typeErrors = [];
        const untyped = [];
        const terms = [];
        for (const match of matches) {
            for (const pos of match.literals)
                covered.add(pos);
            for (const slot of match.slots) {
                if (!slot)
                    continue;
                if (slot.typedBy === "concept" || slot.typedBy === "variable")
                    for (let i = slot.from; i < slot.to; i++)
                        covered.add(i);
            }
            const phrase = match.compiled.phrase;
            if (phrase.kind === "concept")
                continue;
            terms.push({
                text: phrase.text,
                kind: phrase.kind,
                ...(phrase.memberId ? { member: phrase.memberId } : {}),
                owner: phrase.owner,
                ...(phrase.type ? { type: phrase.type } : {}),
                ...(phrase.virtual ? { virtual: true } : {}),
                resolved: match.resolved,
            });
            typeErrors.push(...this.slotTypeErrors(match));
            if (!match.resolved) {
                const subject = match.slots[phrase.slots.findIndex((slot) => slot.name === "this")];
                if (subject && !subject.type)
                    untyped.push(`'${subject.text}' in "${phrase.text}" could not be typed`);
            }
        }
        typeErrors.push(...this.comparisonErrors(tokens, matches));
        const unknownWords = [];
        const unknownVariables = [];
        tokens.forEach((token, index) => {
            if (covered.has(index))
                return;
            if (token.kind === "var") {
                if (!this.model.env.variables.has(token.value))
                    unknownVariables.push(token.raw);
                return;
            }
            if (token.kind !== "word")
                return;
            if (BAL_WORDS.has(token.value) || /^\d/.test(token.value))
                return;
            unknownWords.push(token.value);
        });
        // Keyword-like nouns used as if they were members (`the count of the borrower`, `the value of the loan`):
        // they are BAL words, but here nothing in the vocabulary backs them.
        const NOUNS = new Set(["value", "values", "date", "time", "count", "size", "variable", "percent", "list", "number", "sum", "average", "minimum", "maximum"]);
        tokens.forEach((token, index) => {
            if (covered.has(index) || token.kind !== "word" || !NOUNS.has(token.value))
                return;
            const next = tokens[index + 1];
            if (!(next?.kind === "word" && (next.value === "of" || next.value === "de")))
                return;
            // `the number of <items> in ...` and other aggregates over a collection are BAL; a single object is not.
            const rest = tokens.slice(index + 2);
            if (rest.some((item) => item.kind === "word" && (item.value === "in" || item.value === "dans" || item.value === "where")))
                return;
            unknownWords.push(token.value);
        });
        const nonConcept = matches.filter((match) => match.compiled.phrase.kind !== "concept");
        // At least one real term (navigation, action or parameter) must be used: a concept name alone is not a condition.
        const ok = !unknownWords.length && !unknownVariables.length && !typeErrors.length && nonConcept.length > 0;
        return {
            phrase: text,
            ok,
            terms,
            ...(unknownWords.length ? { unknownWords: [...new Set(unknownWords)], suggestions: this.suggestFor(unknownWords) } : {}),
            ...(unknownVariables.length ? { unknownVariables } : {}),
            ...(typeErrors.length ? { typeErrors } : {}),
            ...(untyped.length ? { untyped } : {}),
            ...(nonConcept.length ? {} : { note: matches.length ? "Only a class name was found; no member of it is used, so this is not a valid condition or action." : "No vocabulary term found in this phrase." }),
        };
    }
    slotTypeErrors(match) {
        const errors = [];
        const phrase = match.compiled.phrase;
        phrase.slots.forEach((expected, index) => {
            const slot = match.slots[index];
            if (!slot?.type || !expected.type)
                return;
            if (expected.name === "this") {
                if (!this.model.env.isAssignable(slot.type, expected.type) && slot.typedBy !== "literal") {
                    errors.push(`"${phrase.text}" belongs to ${this.labelOf(expected.type)}, but '${slot.text}' is ${this.describeType(slot.type)}`);
                }
                else if (slot.typedBy === "literal") {
                    errors.push(`"${phrase.text}" needs ${this.labelOf(expected.type)}, but got the literal ${slot.text}`);
                }
                return;
            }
            const want = typeCategory(expected.type);
            const got = slot.type === "number" || slot.type === "string" ? slot.type : typeCategory(slot.type);
            if (want === "unknown" || got === "unknown")
                return;
            if (want === "object" && got === "object") {
                if (!this.model.env.isAssignable(slot.type, expected.type)) {
                    errors.push(`"${phrase.text}" expects ${this.describeType(expected.type)} for <${expected.name}>, but '${slot.text}' is ${this.describeType(slot.type)}`);
                }
                return;
            }
            if (want !== got && !(want === "collection" || got === "collection")) {
                errors.push(`"${phrase.text}" expects ${want} for <${expected.name}>, but '${slot.text}' is ${got}`);
            }
        });
        return errors;
    }
    /** `<number navigation> is less than "abc"` and similar. */
    comparisonErrors(tokens, matches) {
        const errors = [];
        const words = tokens.map((token) => (token.kind === "word" ? token.value : `\u0000${token.kind}`));
        for (const match of matches) {
            const phrase = match.compiled.phrase;
            if (phrase.kind !== "navigation" || !phrase.type)
                continue;
            const category = typeCategory(phrase.type);
            const after = words.slice(match.to, match.to + 4).join(" ");
            const op = COMPARISON.find((item) => after.startsWith(`is ${item}`) || after.startsWith(item));
            if (!op)
                continue;
            const opLen = op.split(" ").length + (after.startsWith("is ") ? 1 : 0);
            const value = tokens[match.to + opLen];
            if (!value)
                continue;
            if (category !== "number" && category !== "date" && category !== "unknown") {
                errors.push(`"${phrase.text}" is ${category}; '${op}' compares numbers or dates`);
            }
            else if (value.kind === "string" && category === "number") {
                errors.push(`"${phrase.text}" is a number but is compared with the text "${value.value}"`);
            }
        }
        return errors;
    }
    describeType(type) {
        if (type === "number" || type === "string")
            return `a ${type}`;
        if (this.model.classes.has(type))
            return `a ${this.labelOf(type)} (${type})`;
        return type;
    }
    suggestFor(words) {
        const out = {};
        for (const word of new Set(words)) {
            const hits = this.termSearch.search(word, { limit: 3 });
            const texts = hits
                .map((hit) => (hit.key.startsWith("phrase:") ? this.model.phrases.get(hit.key.slice(7))?.text : this.model.glossary[Number(hit.key.slice(9))]?.phrase))
                .filter((item) => Boolean(item));
            if (texts.length)
                out[word] = texts;
        }
        return out;
    }
    /** Resolve a term reference (member id, class fqn, phrase id, or phrase text) to member ids / class fqns. */
    /**
     * Resolve a term reference to member ids / class fqns. Phrase text must validate
     * exactly (every word known, subject type right): a near miss such as
     * "the combined credit score of the loan request" is not silently read as
     * "the credit score of the applicant". It returns `why` instead.
     */
    resolveTerm(ref) {
        if (this.model.members.has(ref))
            return { targets: [ref], via: "member id" };
        if (this.model.classes.has(ref))
            return { targets: [ref], via: "class" };
        // A bare BOM member name (`yearlyIncome`) of a verbalized member
        if (/^[A-Za-z_$][\w$]*$/.test(ref) && /[A-Z_]/.test(ref)) {
            const byName = [...this.model.members.values()].filter((member) => member.name === ref && this.phrasesByMember.has(member.id)).map((member) => member.id);
            if (byName.length)
                return { targets: byName, via: byName.length > 1 ? "member name (several classes have it)" : "member name" };
        }
        const phrase = this.model.phrases.get(ref);
        if (phrase)
            return { targets: [phrase.memberId ?? phrase.owner], via: "phrase id" };
        const variable = this.model.variables.get(normalize(ref).replace(/^(the|a|an) /, ""));
        if (variable)
            return { targets: [`var:${variable.name}`], via: "ruleset parameter" };
        const glossary = this.model.glossary.find((entry) => normalize(entry.phrase) === normalize(ref));
        if (glossary) {
            const targets = glossary.means.flatMap((item) => {
                const hit = this.resolveTerm(item);
                return hit && "targets" in hit ? hit.targets : [];
            });
            if (targets.length)
                return { targets: [...new Set(targets)], via: `glossary '${glossary.phrase}'` };
        }
        const tokens = tokenizeBal(ref);
        const matches = this.model.matcher.match(tokens, this.model.env).filter((match) => match.compiled.phrase.kind !== "concept" || matchesAll(match, tokens.length));
        if (matches.length) {
            const check = this.validateOne(ref);
            const problems = [
                ...(check.unknownWords?.length ? [`unknown words: ${check.unknownWords.join(", ")}`] : []),
                ...(check.unknownVariables?.length ? [`unknown variables: ${check.unknownVariables.join(", ")}`] : []),
                ...(check.typeErrors ?? []),
            ];
            if (problems.length)
                return { why: problems.join("; ") };
            const resolved = matches.filter((match) => match.resolved && match.compiled.phrase.kind !== "concept");
            const chosen = resolved.length ? resolved : matches.filter((match) => match.compiled.phrase.kind !== "concept");
            if (chosen.length) {
                return { targets: [...new Set(chosen.map((match) => match.compiled.phrase.memberId ?? match.compiled.phrase.owner))], via: resolved.length ? "phrase text" : "phrase text (subject not typed)" };
            }
            return { targets: [...new Set(matches.map((match) => match.compiled.phrase.owner))], via: "concept" };
        }
        // A bare term without its subject ("credit score"): every member verbalized with those words.
        const bare = stripArticles(normalize(ref));
        const members = [...this.model.phrases.values()]
            .filter((phrase) => phrase.memberId && phrase.kind === "navigation" && stripArticles(normalize(phrase.template.replace(/\{(this|\d+)\}/g, " ").replace(/\bof\s*$/, "").replace(/[{}]/g, " "))) === bare)
            .map((phrase) => phrase.memberId);
        if (members.length)
            return { targets: [...new Set(members)], via: members.length > 1 ? "term words (several classes have it)" : "term words" };
        return null;
    }
    /** A BOM member matching these words that has no verbalization (so only a vocabulary entry is missing). */
    unverbalizedMember(term) {
        const words = stripArticles(normalize(term));
        const head = words.split(" of ")[0].trim();
        for (const member of this.model.members.values()) {
            if (member.kind === "constructor" || this.phrasesByMember.has(member.id))
                continue;
            const spoken = normalize(splitIdentifier(member.name));
            if (term === member.id || term === member.name || spoken === words || spoken === head)
                return member.id;
        }
        return undefined;
    }
    /** Members a target stands for, including virtual members computed from it (transitively). */
    expandDerived(target) {
        const out = [{ id: target }];
        const seen = new Set([target]);
        const queue = [target];
        while (queue.length) {
            const current = queue.shift();
            for (const derived of this.derivedTo.get(current) ?? []) {
                if (seen.has(derived))
                    continue;
                seen.add(derived);
                out.push({ id: derived, via: `${derived} is computed from ${current} (B2X)` });
                queue.push(derived);
            }
        }
        return out;
    }
    /** Ruleflow tasks that run a rule, and the operations that run those flows. */
    runPath(artifact) {
        // A task that selects a parent package selects its sub-packages too.
        const selectedBy = [...(this.selectionByRule.get(artifact.id) ?? []), ...(artifact.package ? this.tasksSelectingPackage(artifact.package) : [])];
        const operations = new Set();
        const flows = new Set(selectedBy.map((item) => item.flow));
        const queue = [...flows];
        while (queue.length) {
            const flow = queue.shift();
            for (const op of this.flowsRunBy.get(flow) ?? [])
                operations.add(op);
            for (const parent of this.subflowParents.get(flow) ?? []) {
                if (!flows.has(parent)) {
                    flows.add(parent);
                    queue.push(parent);
                }
            }
        }
        return { selectedBy, operations: [...operations] };
    }
    /** Decision operations without a ruleflow: they run every rule of the ruleset. */
    operationsRunningAll() {
        return [...this.model.artifacts.values()].filter((item) => item.type === "decisionOperation" && !item.operation?.ruleflowName && !item.operation?.ruleflowUuid);
    }
    /**
     * Whether and how a rule runs, in words. A rule runs when a ruleflow task selects it and an
     * operation runs that ruleflow, or when an operation has no ruleflow (it runs every rule).
     */
    runsDescription(artifact) {
        const path = this.runPath(artifact);
        const unreachable = path.selectedBy.filter((item) => !this.taskReachable(item.flow, item.task));
        const lines = path.selectedBy.filter((item) => this.taskReachable(item.flow, item.task)).map((item) => item.reason);
        for (const item of unreachable) {
            lines.push(`selected by ruleflow '${this.model.artifacts.get(item.flow)?.name ?? item.flow}' task '${item.task}', which no path from the start reaches`);
        }
        const allOps = this.operationsRunningAll();
        const anyOperation = [...this.model.artifacts.values()].some((item) => item.type === "decisionOperation");
        const anyFlow = [...this.model.artifacts.values()].some((item) => item.type === "ruleflow");
        const reachableFlows = new Set(path.selectedBy.filter((item) => this.taskReachable(item.flow, item.task)).map((item) => item.flow));
        let runs = path.operations.length > 0 && reachableFlows.size > 0;
        if (path.selectedBy.length && !path.operations.length && anyOperation) {
            lines.push("but no decision operation runs that ruleflow");
        }
        for (const op of allOps) {
            lines.push(`operation '${op.name}' has no ruleflow: it runs every rule in the ruleset`);
            runs = true;
        }
        if (!anyOperation) {
            // No operation to anchor on (classic projects): selection is the best evidence we have.
            runs = path.selectedBy.length > 0 || !anyFlow;
            if (!anyFlow)
                lines.push("no ruleflow or operation: every rule in the ruleset runs");
        }
        if (!runs && !path.selectedBy.length)
            lines.push("not selected by any ruleflow task, and no operation runs all rules: this rule does not run");
        return { runs, lines };
    }
    findChangeCandidates(input) {
        const limit = input.limit ?? 15;
        const gaps = [];
        const requested = [];
        const unverbalized = [];
        for (const term of input.terms) {
            const resolved = this.resolveTerm(term);
            if (!resolved || "why" in resolved) {
                const inBom = this.unverbalizedMember(term);
                if (inBom) {
                    unverbalized.push({ term, member: inBom });
                    continue;
                }
                gaps.push({
                    term,
                    ...(resolved ? { why: resolved.why } : {}),
                    closest: this.termSearch.search(term, { limit: 3 }).map((hit) => this.model.phrases.get(hit.key.slice(7))?.text ?? "").filter(Boolean),
                });
                continue;
            }
            requested.push({ term, ...resolved });
        }
        // Every requested term that reaches a member gets credit for it, not just the first one.
        const targetInfo = new Map();
        for (const item of requested) {
            for (const target of item.targets) {
                for (const expanded of this.expandDerived(target)) {
                    const info = targetInfo.get(expanded.id) ?? { terms: [], via: expanded.via };
                    if (!info.terms.includes(item.term))
                        info.terms.push(item.term);
                    targetInfo.set(expanded.id, info);
                }
            }
        }
        // Score every rule by how many requested terms it uses, where, and how surely.
        const scores = new Map();
        for (const [target, info] of targetInfo) {
            for (const { artifactId, use } of this.model.usedBy.get(target) ?? []) {
                const artifact = this.model.artifacts.get(artifactId);
                // Rules, and ruleflows: a threshold in a transition condition or task filter is a decision point too.
                if (!artifact || !(RULE_KINDS.includes(artifact.type) || artifact.type === "ruleflow"))
                    continue;
                const entry = scores.get(artifactId) ?? { score: 0, terms: new Set(), reasons: [], uses: [] };
                const decisive = use.where === "conditions" || use.where.startsWith("column:") || use.where === "preconditions" || use.where.startsWith("transition:") || use.where.startsWith("task:");
                const weight = (decisive ? 1 : 0.6) * (use.resolved ? 1 : 0.5) * (info.via ? 0.8 : 1);
                for (const term of info.terms) {
                    if (!entry.terms.has(term))
                        entry.score += 2;
                    entry.terms.add(term);
                }
                entry.score += weight;
                entry.uses.push(use);
                entry.reasons.push(`${describeWhere(use.where, artifact)} uses "${use.text}"${use.resolved ? "" : " (subject not typed)"}${info.via ? `; ${info.via}` : ""}`);
                scores.set(artifactId, entry);
            }
        }
        if (input.requirement) {
            for (const hit of this.ruleSearch.search(input.requirement, { limit: 50 })) {
                const entry = scores.get(hit.key);
                if (entry)
                    entry.score += Math.min(1, hit.score / 10);
            }
        }
        const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
        const modify = ranked.slice(0, limit).map(([id, entry]) => {
            const artifact = this.model.artifacts.get(id);
            if (artifact.type === "ruleflow") {
                const ops = (this.flowsRunBy.get(artifact.id) ?? []).map((op) => this.model.artifacts.get(op)?.name ?? op);
                return {
                    ...this.summary(artifact),
                    coverage: `${entry.terms.size}/${requested.length} terms`,
                    reasons: [...new Set(entry.reasons)].slice(0, 6),
                    note: "the decision is in the ruleflow itself (a transition condition or task filter), not only in rules",
                    runs: ops.length ? ops.map((op) => `run by operation '${op}'`) : ["no decision operation runs this ruleflow"],
                };
            }
            return {
                ...this.summary(artifact),
                coverage: `${entry.terms.size}/${requested.length} terms`,
                reasons: [...new Set(entry.reasons)].slice(0, 6),
                ...(artifact.type === "decisionTable" ? { table: this.tableExcerpt(artifact, entry.uses) } : {}),
                runs: this.runsDescription(artifact).lines,
            };
        });
        // Where would a new rule go? Packages whose rules already use the terms, and that a task selects.
        const packageScore = new Map();
        for (const [id, entry] of ranked) {
            const artifact = this.model.artifacts.get(id);
            if (artifact.type === "ruleflow")
                continue;
            if (artifact.package)
                packageScore.set(artifact.package, (packageScore.get(artifact.package) ?? 0) + entry.score);
        }
        const add = [...packageScore.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 3)
            .map(([pkg]) => {
            const tasks = this.tasksSelectingPackage(pkg);
            const exemplars = ranked.filter(([id]) => this.model.artifacts.get(id).package === pkg).slice(0, 3).map(([id]) => this.summary(this.model.artifacts.get(id)));
            return {
                package: pkg,
                selectedBy: tasks.map((item) => item.reason),
                operations: [...new Set(tasks.flatMap((item) => this.flowsRunBy.get(item.flow) ?? []))].map((op) => this.model.artifacts.get(op)?.name ?? op),
                similarRules: exemplars,
                ...(tasks.length || this.operationsRunningAll().length || ![...this.model.artifacts.values()].some((item) => item.type === "ruleflow")
                    ? {}
                    : { warning: "no ruleflow task selects this package: a new rule here would not run" }),
            };
        });
        if (!add.length && requested.length) {
            for (const [pkg, tasks] of [...this.selectionByPackage.entries()].slice(0, 5)) {
                add.push({ package: pkg, selectedBy: tasks.map((item) => item.reason), operations: [], similarRules: [], warning: "no existing rule uses these terms; this is a package a ruleflow runs" });
            }
        }
        const unresolvedUses = ranked.reduce((sum, [, entry]) => sum + entry.uses.filter((use) => !use.resolved).length, 0);
        return {
            requested: requested.map((item) => ({ term: item.term, resolvedTo: item.targets, via: item.via })),
            modify,
            add,
            ...(unverbalized.length
                ? {
                    needsVerbalization: unverbalized.map((item) => ({
                        term: item.term,
                        member: item.member,
                        meaning: "exists in the BOM but has no verbalization: add a vocabulary entry for it (no BOM change needed)",
                    })),
                }
                : {}),
            vocabularyGaps: gaps.map((gap) => ({
                term: gap.term,
                meaning: gap.why?.includes("unknown words") || !gap.why
                    ? "not in the vocabulary: a BOM change is needed before a rule can use it"
                    : "the words exist but do not fit together (see why); fix the phrasing, or the BOM if the term is really missing",
                ...(gap.why ? { why: gap.why } : {}),
                closest: gap.closest,
            })),
            checked: this.checked({
                unresolvedUses,
                note: `searched ${this.rules().length} rules for ${targetInfo.size} members (including virtual members computed from them)`,
            }),
        };
    }
    tableExcerpt(artifact, uses) {
        const columnIds = new Set(uses.filter((use) => use.where.startsWith("column:")).map((use) => use.where.slice(7)));
        const columns = (artifact.columns ?? []).filter((column) => columnIds.has(column.id));
        const rows = (artifact.rows ?? []).map((row) => {
            const cells = [...row.conditions, ...row.actions].filter((cell) => columnIds.has(cell.columnId));
            return { row: row.index, cells: cells.map((cell) => ({ column: cell.columnId, values: cell.params, ...(cell.otherwise ? { otherwise: true } : {}), ...(cell.enabled ? {} : { disabled: true }) })) };
        });
        const MAX = 40;
        return {
            columns: columns.map((column) => ({ id: column.id, kind: column.kind, template: column.template })),
            rows: rows.slice(0, MAX),
            ...(rows.length > MAX ? { moreRows: rows.length - MAX, hint: "get_artifact with rows=[...] returns specific rows" } : {}),
            ...(artifact.preconditions ? { preconditions: artifact.preconditions } : {}),
        };
    }
    getArtifact(input) {
        const found = this.findArtifact(input.id);
        if (found.ambiguous)
            return { error: `'${input.id}' matches several artifacts; pass an id.`, matches: found.ambiguous, checked: this.checked() };
        const artifact = found.artifact;
        if (!artifact)
            return { error: `No artifact '${input.id}'.`, suggestions: this.ruleSearch.search(input.id, { limit: 5 }).map((hit) => hit.key), checked: this.checked() };
        const uses = this.model.uses.get(artifact.id) ?? [];
        const { rows: allRows, ...rest } = artifact;
        const MAX_ROWS = 100;
        const chosen = allRows ? (input.rows ? allRows.filter((row) => input.rows?.includes(row.index)) : allRows.slice(0, MAX_ROWS)) : undefined;
        const columns = new Map((artifact.columns ?? []).map((column) => [column.id, column]));
        const cell = (item) => ({
            column: item.columnId,
            values: item.params,
            text: renderCell(item, columns.get(item.columnId)),
            ...(item.enabled ? {} : { disabled: true }),
            ...(item.otherwise ? { otherwise: true } : {}),
        });
        const copy = {
            ...rest,
            ...(chosen ? { rows: chosen.map((row) => ({ row: row.index, conditions: row.conditions.map(cell), actions: row.actions.map(cell) })) } : {}),
            ...(allRows && !input.rows && allRows.length > MAX_ROWS ? { moreRows: allRows.length - MAX_ROWS, hint: "pass rows=[...] for specific rows" } : {}),
        };
        const run = RULE_KINDS.includes(artifact.type) ? this.runPath(artifact) : undefined;
        return {
            artifact: copy,
            uses: uses.map((use) => ({ target: use.target, where: use.where, text: use.text, ...(use.resolved ? {} : { resolved: false }), ...(use.writes ? { writes: true } : {}) })),
            ...(run
                ? {
                    runs: this.runsDescription(artifact).lines,
                    operations: [...new Set([...run.operations, ...this.operationsRunningAll().map((op) => op.id)])].map((op) => this.model.artifacts.get(op)?.name ?? op),
                }
                : {}),
            warnings: this.model.warnings.filter((warning) => warning.path === artifact.provenance.path).map((warning) => warning.message),
            checked: this.checked(),
        };
    }
    getImpact(input) {
        const ref = input.target;
        const term = this.model.members.has(ref) || this.model.classes.has(ref) ? { targets: [ref], via: "id" } : undefined;
        const found = term ? {} : this.findArtifact(ref);
        if (found.ambiguous)
            return { error: `'${ref}' matches several artifacts; pass an id.`, matches: found.ambiguous, checked: this.checked() };
        if (found.artifact)
            return this.artifactImpact(found.artifact);
        const resolved = term ?? this.resolveTerm(ref);
        if (resolved && "why" in resolved)
            return { error: `'${ref}' is not a valid vocabulary phrase: ${resolved.why}`, checked: this.checked() };
        if (resolved)
            return this.termImpact(ref, resolved.targets);
        return { error: `'${ref}' is not an artifact, package, BOM member or vocabulary phrase.`, checked: this.checked() };
    }
    artifactImpact(artifact) {
        const affected = [];
        const add = (item, reason) => {
            if (!item || item.id === artifact.id)
                return;
            if (affected.some((entry) => entry.artifact.id === item.id && entry.reason === reason))
                return;
            affected.push({ artifact: this.summary(item), reason });
        };
        if (artifact.type === "package") {
            for (const rule of this.rules().filter((item) => item.package === artifact.name || item.package.startsWith(`${artifact.name}.`)))
                add(rule, `in package ${artifact.name}`);
            const tasks = this.tasksSelectingPackage(artifact.name);
            for (const task of tasks)
                add(this.model.artifacts.get(task.flow), task.reason);
            for (const op of new Set(tasks.flatMap((task) => this.flowsRunBy.get(task.flow) ?? [])))
                add(this.model.artifacts.get(op), "runs a ruleflow that selects this package");
            return { target: this.summary(artifact), affected, checked: this.checked() };
        }
        if (artifact.type === "ruleflow") {
            for (const op of this.flowsRunBy.get(artifact.id) ?? [])
                add(this.model.artifacts.get(op), "runs this ruleflow");
            for (const parent of this.subflowParents.get(artifact.id) ?? [])
                add(this.model.artifacts.get(parent), "runs this ruleflow as a subflow");
            return { target: this.summary(artifact), affected, checked: this.checked() };
        }
        const run = this.runPath(artifact);
        for (const sel of run.selectedBy)
            add(this.model.artifacts.get(sel.flow), sel.reason);
        for (const op of run.operations)
            add(this.model.artifacts.get(op), "runs a ruleflow that selects this rule");
        if (artifact.package) {
            for (const rule of this.rules().filter((item) => item.package === artifact.package))
                add(rule, `same package '${artifact.package}': selected and run together`);
        }
        // Data flow: rules that read what this rule writes.
        const writes = (this.model.uses.get(artifact.id) ?? []).filter((use) => use.writes).map((use) => use.target);
        for (const target of new Set(writes)) {
            for (const expanded of this.expandDerived(target)) {
                for (const { artifactId, use } of this.model.usedBy.get(expanded.id) ?? []) {
                    if (use.writes)
                        continue;
                    add(this.model.artifacts.get(artifactId), `reads ${expanded.id}, which this rule sets${expanded.via ? ` (${expanded.via})` : ""}`);
                }
            }
        }
        const runs = this.runsDescription(artifact);
        return {
            target: this.summary(artifact),
            runs: runs.lines,
            ...(runs.runs ? {} : { warning: "this rule does not run: no ruleflow task that an operation runs selects it" }),
            affected,
            checked: this.checked(),
        };
    }
    termImpact(ref, targets) {
        const affected = [];
        const seen = new Set();
        let unresolved = 0;
        const subclasses = (fqn) => [...this.model.ancestors.entries()].filter(([, list]) => list.includes(fqn)).map(([sub]) => sub);
        const expandedTargets = [];
        for (const target of targets) {
            expandedTargets.push(...this.expandDerived(target));
            if (this.model.classes.has(target)) {
                for (const sub of subclasses(target))
                    expandedTargets.push({ id: sub, via: `${sub} extends ${target}` });
            }
        }
        for (const { id, via } of expandedTargets) {
            for (const { artifactId, use } of this.model.usedBy.get(id) ?? []) {
                const artifact = this.model.artifacts.get(artifactId);
                if (!artifact)
                    continue;
                const key = `${artifactId}|${use.where}|${id}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                if (!use.resolved)
                    unresolved++;
                affected.push({
                    artifact: this.summary(artifact),
                    reason: `${describeWhere(use.where, artifact)} ${use.writes ? "sets" : "uses"} "${use.text}"${via ? `; ${via}` : ""}`,
                    resolved: use.resolved,
                });
            }
        }
        const MAX = 150;
        return {
            target: ref,
            resolvedTo: targets,
            derived: expandedTargets.filter((item) => item.via).map((item) => item.via),
            total: affected.length,
            affected: affected.slice(0, MAX),
            ...(affected.length > MAX ? { note: `${affected.length - MAX} more not shown; narrow the target or use find_change_candidates` } : {}),
            checked: this.checked({ unresolvedUses: unresolved, ...(unresolved ? { note: "unresolved uses are included so nothing is missed; their subject could not be typed" } : {}) }),
        };
    }
    /**
     * The structure of a ruleflow as it runs: tasks in order, what each selects, the conditions on every path
     * that reaches it, what runs before and after, and which operations (or parent flows) run it.
     */
    getRuleflowPaths(input) {
        const flows = [...this.model.artifacts.values()].filter((item) => item.type === "ruleflow");
        let chosen = flows;
        if (input.ruleflow) {
            const found = this.findArtifact(input.ruleflow);
            if (found.ambiguous)
                return { error: `'${input.ruleflow}' matches several artifacts; pass an id.`, matches: found.ambiguous, checked: this.checked() };
            if (!found.artifact || found.artifact.type !== "ruleflow") {
                return { error: `No ruleflow '${input.ruleflow}'.`, ruleflows: flows.map((item) => this.summary(item)), checked: this.checked() };
            }
            chosen = [found.artifact];
        }
        if (!chosen.length) {
            return { ruleflows: [], note: "This decision service has no ruleflow: an operation without a ruleflow runs every rule.", checked: this.checked() };
        }
        const rulesOfTask = (flow, taskId) => {
            const task = flow.tasks?.find((item) => item.id === taskId);
            const ids = new Set();
            for (const pkg of task?.packages ?? []) {
                for (const rule of this.rules())
                    if (rule.package === pkg || rule.package.startsWith(`${pkg}.`))
                        ids.add(rule.id);
            }
            for (const edge of this.model.edges)
                if (edge.type === "SELECTS" && edge.from === `${flow.id}#${taskId}` && !edge.to.startsWith("pkg:"))
                    ids.add(edge.to);
            return [...ids];
        };
        const result = chosen.map((flow) => {
            const analysis = this.flows.get(flow.id);
            const operations = (this.flowsRunBy.get(flow.id) ?? []).map((op) => this.model.artifacts.get(op)?.name ?? op);
            const calledFrom = this.model.edges
                .filter((edge) => edge.type === "SUBFLOW" && edge.to === flow.id)
                .map((edge) => {
                const [parent, task] = edge.from.split("#");
                return { ruleflow: this.model.artifacts.get(parent)?.name ?? parent, task, reason: this.taskReason(parent, task) };
            });
            const tasks = [...(flow.tasks ?? [])]
                .map((task) => ({ task, info: analysis.tasks.get(task.id) }))
                .sort((a, b) => (a.info?.order ?? 1e9) - (b.info?.order ?? 1e9) || a.task.id.localeCompare(b.task.id))
                .filter((item) => !input.task || item.task.id === input.task)
                .map(({ task, info }) => {
                const rules = task.kind === "rule" ? rulesOfTask(flow, task.id) : [];
                const settings = describeTaskSettings(task);
                return {
                    task: task.id,
                    kind: task.kind,
                    order: info?.order ?? null,
                    reachedWhen: info ? describePaths(info) : "unknown",
                    ...(info && !info.always && info.reachable ? { paths: info.paths } : {}),
                    ...(task.packages.length ? { selectsPackages: task.packages } : {}),
                    ...(task.rules.length ? { selectsRules: task.rules } : {}),
                    ...(task.kind === "rule" ? { rules: rules.length, ruleNames: rules.slice(0, 25).map((id) => this.model.artifacts.get(id)?.name ?? id) } : {}),
                    ...(task.algorithm ? { algorithm: task.algorithm } : {}),
                    ...(task.exitCriteria && task.exitCriteria !== "None" ? { exitCriteria: task.exitCriteria } : {}),
                    ...(task.subflow ? { runsSubflow: this.model.edges.filter((edge) => edge.type === "SUBFLOW" && edge.from === `${flow.id}#${task.id}`).map((edge) => this.model.artifacts.get(edge.to)?.name ?? edge.to) } : {}),
                    ...(task.actions ? { actions: task.actions } : {}),
                    ...(settings.length ? { notes: settings } : {}),
                    next: info?.successors ?? [],
                    before: info?.before ?? [],
                    after: info?.after ?? [],
                };
            });
            return {
                ...this.summary(flow),
                runBy: operations.length ? operations.map((name) => `operation '${name}'`) : calledFrom.length ? [] : ["no decision operation runs this ruleflow"],
                ...(calledFrom.length ? { calledFrom } : {}),
                start: analysis.starts,
                ...(analysis.unreachable.length ? { unreachable: analysis.unreachable } : {}),
                ...(analysis.hasCycle ? { note: "the flow has a loop: a transition goes back to an earlier task" } : {}),
                tasks,
            };
        });
        return {
            ruleflows: result,
            legend: "order: steps from the start (tasks with the same order can run on different branches). reachedWhen: the conditions on every path from the start; 'otherwise' is the transition taken when none of its siblings' conditions hold.",
            checked: this.checked(),
        };
    }
    getOperationSignature(input) {
        const ops = [...this.model.artifacts.values()].filter((item) => item.type === "decisionOperation");
        const chosen = input.operation ? ops.filter((item) => item.name === input.operation || item.id === input.operation) : ops;
        if (!chosen.length)
            return { error: `No decision operation '${input.operation}'.`, operations: ops.map((item) => item.name), checked: this.checked() };
        return {
            operations: chosen.map((op) => {
                const flow = this.model.edges.find((edge) => edge.type === "RUNS" && edge.from === op.id)?.to;
                return {
                    ...this.summary(op),
                    ruleset: op.operation?.rulesetName,
                    ruleflow: flow ? this.model.artifacts.get(flow)?.name : op.operation?.ruleflowName,
                    signature: (op.operation?.signature ?? []).map((item) => {
                        const variable = [...this.model.variables.values()].find((v) => v.name === item.name);
                        return { name: item.name, direction: item.direction, type: variable?.type ?? null, verbalization: variable?.verbalization ?? null };
                    }),
                };
            }),
            checked: this.checked(),
        };
    }
    /** Rule-name search, used by the recall gate and by `get_artifact` suggestions. */
    searchRules(query, limit = 10) {
        // A rule searched by its exact name comes first, whatever the body length.
        const exact = this.rulesByNormalizedName.get(normalize(query)) ?? [];
        const hits = this.ruleSearch.search(query, { limit: limit + exact.length });
        const ordered = [...exact.map((key) => ({ key, score: Infinity })), ...hits.filter((hit) => !exact.includes(hit.key))].slice(0, limit);
        return ordered.map((hit) => ({ ...this.summary(this.model.artifacts.get(hit.key)), score: hit.score === Infinity ? 100 : Math.round(hit.score * 100) / 100 }));
    }
    warnings() {
        return this.model.warnings;
    }
}
function matchesAll(match, length) {
    return match.from === 0 && match.to === length;
}
function describeWhere(where, artifact) {
    if (where.startsWith("column:")) {
        const column = artifact.columns?.find((item) => item.id === where.slice(7));
        return `column ${where.slice(7)}${column ? ` (${column.kind})` : ""}`;
    }
    if (where.startsWith("transition:"))
        return `transition ${where.slice(11)} condition`;
    if (where.startsWith("task:"))
        return `task ${where.slice(5)}`;
    return where === "elseActions" ? "else" : where;
}
function bodyText(artifact) {
    return [
        artifact.bal,
        artifact.preconditions,
        artifact.irl,
        ...(artifact.columns ?? []).map((column) => column.template),
        // Row text is the column templates again plus values; only text values add anything searchable.
        [...new Set((artifact.rows ?? []).flatMap((row) => [...row.conditions, ...row.actions].flatMap((cell) => cell.params.filter((param) => /^".*"$/.test(param)))))].join(" "),
        ...(artifact.tasks ?? []).map((task) => [task.id, ...task.packages, ...task.rules, task.filter].filter(Boolean).join(" ")),
    ]
        .filter(Boolean)
        .join("\n");
}
export { stem };
