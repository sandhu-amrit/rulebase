import { ARTICLES, normalize, phraseWords } from "./text.js";
/** Words that end a noun phrase inside a slot. */
const BOUNDARY = new Set([
    "is",
    "are",
    "not",
    "and",
    "or",
    "then",
    "else",
    "if",
    "to",
    "set",
    "make",
    "it",
    "that",
    "true",
    "false",
    "less",
    "more",
    "greater",
    "than",
    "least",
    "most",
    "between",
    "equals",
    "equal",
    "does",
    "contains",
    "contain",
    "starts",
    "ends",
    "with",
    "where",
    "from",
    "after",
    "before",
    "one",
    "print",
    "add",
    "remove",
    "in",
    "as",
    "definitions",
    "when",
    "for",
    "each",
    "all",
    "any",
    "following",
    "conditions",
    "condition",
    "there",
    "no",
    "number",
    "null",
    "times",
    "plus",
    "minus",
    "divided",
    "multiplied",
    "by",
    "has",
    "have",
    "be",
    // French BAL
    "est",
    "sont",
    "et",
    "ou",
    "alors",
    "si",
    "sinon",
    "que",
    "qui",
    "pas",
    "ne",
    "n",
    "moins",
    "egal",
    "egale",
    "entre",
    "avec",
    "dans",
    "pour",
    "au",
    "aux",
    "superieur",
    "inferieur",
    "grand",
    "grande",
    "petit",
    "petite",
    "contient",
    "commence",
    "termine",
    "par",
    "vrai",
    "faux",
    "nul",
    "nulle",
    "chaque",
    "tous",
    "toutes",
    "aucun",
    "aucune",
    "assigner",
    "mettre",
    "ajouter",
    "retirer",
    "afficher",
    "rendre",
    "definir",
    "ou",
    // Portuguese and Spanish BAL
    "e",
    "se",
    "entao",
    "senao",
    "nao",
    "maior",
    "menor",
    "igual",
    "verdadeiro",
    "falso",
    "nulo",
    "definir",
    "definicoes",
    "es",
    "y",
    "entonces",
    "sino",
    "mayor",
    "igual",
    "verdadero",
    "falso",
    "nulo",
    "definiciones",
    "en",
    "em",
    "con",
    "com",
]);
const MAX_SLOT_TOKENS = 12;
/** BAL keywords and operator words: allowed in a validated phrase without being vocabulary. */
export const BAL_WORDS = new Set([
    ...BOUNDARY,
    "of",
    "at",
    "least",
    "most",
    "same",
    "nothing",
    "empty",
    "unknown",
    "other",
    "otherwise",
    "this",
    "these",
    "those",
    "their",
    "its",
    "which",
    "who",
    "whose",
    "variable",
    "value",
    "values",
    "date",
    "time",
    "today",
    "now",
    "year",
    "years",
    "month",
    "months",
    "day",
    "days",
    "week",
    "weeks",
    "hour",
    "hours",
    "minute",
    "minutes",
    "percent",
    "sum",
    "average",
    "minimum",
    "maximum",
    "count",
    "list",
    "collection",
    "elements",
    "element",
    "first",
    "last",
    "size",
    "new",
    "true",
    "false",
    "yes",
    "no",
    "also",
    "only",
    "every",
    "exists",
    "exist",
    "below",
    "above",
    "under",
    "over",
    "within",
    "outside",
    "inclusive",
    "exclusive",
    "higher",
    "lower",
    "greater",
    "fewer",
    "smaller",
    "bigger",
    "larger",
    "up",
    "down",
    "into",
    "on",
    "by",
    "per",
    "an",
    "a",
    "the",
    "do",
    "did",
    "done",
    "should",
    "must",
    "will",
    "would",
    "can",
    "could",
    "being",
    "been",
    "was",
    "were",
    // French BAL keywords and operator words
    "definitions",
    "il",
    "elle",
    "ce",
    "cette",
    "ces",
    "y",
    "a",
    "plus",
    "egaux",
    "different",
    "differente",
    "jour",
    "jours",
    "mois",
    "an",
    "ans",
    "annee",
    "annees",
    "heure",
    "heures",
    "nombre",
    "somme",
    "moyenne",
    "minimum",
    "maximum",
    "vide",
    "dernier",
    "derniere",
    "premier",
    "premiere",
    "suivant",
    "suivante",
    "selon",
    "sans",
    "sur",
    "sous",
    "apres",
    "avant",
]);
/**
 * French / Italian elision (`l'âge`, `d'un`, `qu'il`): the apostrophe belongs to the word, it does not
 * open a quoted variable. It is replaced by a space (same length, so offsets are unchanged).
 */
function unelide(text) {
    return text.replace(/(^|[^A-Za-z\u00C0-\u024F'])([lLdDnNsScCjJmMtT]|[qQ]u)'(?=[A-Za-z\u00C0-\u024F])/g, (_, before, letters) => `${before}${letters} `);
}
export function tokenizeBal(text) {
    text = unelide(text);
    const tokens = [];
    const re = /'([^'\n]*)'|"((?:[^"\\]|\\.)*)"|(<[^<>\n]+>)|(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|-?\d+(?:\.\d+)?%?)|([A-Za-zÀ-ɏ][\wÀ-ɏ-]*)|(<=|>=|!=|==|[*/+\-<>=%])|([;,.:()])/g;
    let match;
    while ((match = re.exec(text))) {
        const at = match.index;
        const end = at + match[0].length;
        if (match[1] !== undefined) {
            tokens.push({
                kind: "var",
                value: stripArticles(normalize(match[1])),
                raw: match[1],
                at,
                end,
            });
        }
        else if (match[2] !== undefined) {
            tokens.push({ kind: "string", value: match[2], at, end });
        }
        else if (match[3] !== undefined) {
            tokens.push({
                kind: "placeholder",
                value: match[3].slice(1, -1).trim().toLowerCase(),
                at,
                end,
            });
        }
        else if (match[4] !== undefined) {
            tokens.push({ kind: "number", value: match[4], at, end });
        }
        else if (match[5] !== undefined) {
            for (const word of phraseWords(match[5]))
                tokens.push({ kind: "word", value: word, at, end });
        }
        else if (match[6] !== undefined) {
            tokens.push({ kind: "op", value: match[6], at, end });
        }
        else if (match[7] !== undefined) {
            tokens.push({ kind: "punct", value: match[7], at, end });
        }
    }
    return tokens;
}
export function stripArticles(value) {
    return value
        .split(" ")
        .filter((word) => word && !ARTICLES.has(word))
        .join(" ");
}
/**
 * Pattern for a verbalization. `{this}` is slot 0 and `{0}`, `{1}`… follow it in
 * order of appearance. Other braces (`{credit score}`) are literal words, except
 * the value placeholder of an attribute's setter action, which the caller marks
 * via `valueTerm`.
 */
export function compilePattern(template, valueTerm) {
    const items = [];
    const slotNames = [];
    const re = /\{([^}]*)\}|([^{]+)/g;
    let match;
    const valueNorm = valueTerm ? normalize(valueTerm) : undefined;
    let valueUsed = false;
    const parts = [];
    while ((match = re.exec(template))) {
        if (match[1] !== undefined)
            parts.push({ text: match[1].trim(), brace: true });
        else
            parts.push({ text: match[2], brace: false });
    }
    // In a setter, the value placeholder is the *last* brace equal to the attribute's term.
    let valueIndex = -1;
    if (valueNorm) {
        for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i].brace && normalize(parts[i].text) === valueNorm) {
                valueIndex = i;
                break;
            }
        }
    }
    parts.forEach((part, index) => {
        if (part.brace &&
            (part.text === "this" || /^\d+$/.test(part.text) || (index === valueIndex && !valueUsed))) {
            if (index === valueIndex)
                valueUsed = true;
            items.push({ slot: slotNames.length });
            slotNames.push(part.text);
            return;
        }
        for (const word of phraseWords(part.text))
            items.push({ lit: word });
    });
    return { items, slotNames };
}
export class PhraseMatcher {
    /**
     * Phrases are indexed by their first literal word, or by their first two when
     * those are adjacent ("set credit"). Thousands of setters share "set"; few
     * share "set credit", so each position tries only a handful of patterns.
     */
    byWord = new Map();
    byPair = new Map();
    compiled = [];
    constructor(phrases) {
        for (const { phrase, items } of phrases) {
            const anchor = items.findIndex((item) => "lit" in item);
            const literalCount = items.filter((item) => "lit" in item).length;
            const compiled = { phrase, items, anchor, literalCount };
            this.compiled.push(compiled);
            if (anchor < 0)
                continue;
            const first = items[anchor].lit;
            const next = items[anchor + 1];
            const map = next && "lit" in next ? this.byPair : this.byWord;
            const key = next && "lit" in next ? `${first} ${next.lit}` : first;
            const list = map.get(key) ?? [];
            list.push(compiled);
            map.set(key, list);
        }
    }
    /** All matches in a token stream, disambiguated by slot type. */
    match(tokens, env, depth = 0) {
        const raw = [];
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token.kind !== "word")
                continue;
            const next = tokens[i + 1];
            const pair = next?.kind === "word" ? this.byPair.get(`${token.value} ${next.value}`) : undefined;
            for (const candidates of [this.byWord.get(token.value), pair]) {
                if (!candidates)
                    continue;
                for (const compiled of candidates) {
                    const found = this.tryAt(tokens, i, compiled, env, depth);
                    if (found)
                        raw.push(found);
                }
            }
        }
        return disambiguate(raw);
    }
    tryAt(tokens, at, compiled, env, depth) {
        const { items, anchor } = compiled;
        const literals = [];
        const slots = [];
        // Leading slot(s) before the anchor: only `{this} is approved` style, one slot.
        let from = at;
        if (anchor > 0) {
            if (anchor > 1 || !("slot" in items[0]))
                return null;
            // `'the customer'.isOlderThan(30)`: a dot may sit between the subject and the phrase.
            const before = tokens[at - 1]?.kind === "punct" && tokens[at - 1].value === "." ? at - 2 : at - 1;
            const slot = backwardNounPhrase(tokens, before);
            if (!slot)
                return null;
            slots[items[0].slot] = slot;
            from = slot.from;
        }
        let pos = at;
        for (let k = anchor; k < items.length; k++) {
            const item = items[k];
            if ("lit" in item) {
                const token = tokens[pos];
                if (!token || token.kind !== "word" || token.value !== item.lit)
                    return null;
                literals.push(pos);
                pos++;
                continue;
            }
            // Slot: up to the next literal (lazy), or a noun phrase at the end.
            const next = items[k + 1];
            if (next && "lit" in next) {
                let end = pos;
                while (end < tokens.length && end - pos < MAX_SLOT_TOKENS) {
                    const token = tokens[end];
                    if (token.kind === "word" && token.value === next.lit && end > pos)
                        break;
                    if (token.kind === "punct" && token.value === ";")
                        return null;
                    end++;
                }
                if (end === pos || end >= tokens.length)
                    return null;
                const t = tokens[end];
                if (!(t.kind === "word" && t.value === next.lit))
                    return null;
                slots[item.slot] = { from: pos, to: end, text: spanText(tokens, pos, end) };
                pos = end;
            }
            else {
                // `isOlderThan({0})`: skip an opening bracket before a trailing slot, and its closing one after.
                const open = tokens[pos]?.kind === "punct" && tokens[pos].value === "(";
                // Two slots in a row (`atribuir o status final {this} a {status final}`, where `a` is dropped):
                // the first one must not swallow the value that starts the second.
                const nextIsSlot = Boolean(next && "slot" in next);
                const slot = forwardNounPhrase(tokens, open ? pos + 1 : pos, nextIsSlot);
                if (!slot)
                    return null;
                slots[item.slot] = slot;
                pos = slot.to;
                if (open && tokens[pos]?.kind === "punct" && tokens[pos].value === ")")
                    pos++;
            }
        }
        for (const slot of slots)
            if (slot)
                typeSlot(slot, tokens, env, this, depth);
        const thisIndex = compiled.phrase.slots.findIndex((slot) => slot.name === "this");
        let resolved = true;
        if (thisIndex >= 0) {
            const subject = slots[thisIndex];
            resolved = Boolean(subject?.type && env.isAssignable(subject.type, compiled.phrase.owner));
        }
        return { compiled, literals, slots, from, to: pos, resolved };
    }
}
function spanText(tokens, from, to) {
    return tokens
        .slice(from, to)
        .map((token) => token.kind === "var"
        ? `'${token.raw}'`
        : token.kind === "string"
            ? `"${token.value}"`
            : token.kind === "placeholder"
                ? `<${token.value}>`
                : token.value)
        .join(" ");
}
function isNounToken(token) {
    if (!token)
        return false;
    if (token.kind === "var" ||
        token.kind === "placeholder" ||
        token.kind === "string" ||
        token.kind === "number")
        return true;
    return token.kind === "word" && !BOUNDARY.has(token.value);
}
/** Noun phrase starting at `pos`: a variable, a literal, or words up to a boundary (`of` chains allowed). */
function forwardNounPhrase(tokens, pos, wordsOnly = false) {
    const first = tokens[pos];
    if (!isNounToken(first))
        return null;
    if (first.kind !== "word")
        return { from: pos, to: pos + 1, text: spanText(tokens, pos, pos + 1) };
    let end = pos;
    while (end < tokens.length && end - pos < MAX_SLOT_TOKENS) {
        const token = tokens[end];
        if (token.kind === "var" || token.kind === "placeholder") {
            if (wordsOnly)
                break;
            end++;
            break;
        }
        if (token.kind !== "word" || BOUNDARY.has(token.value))
            break;
        end++;
    }
    return end > pos ? { from: pos, to: end, text: spanText(tokens, pos, end) } : null;
}
/** Noun phrase ending at `pos` (inclusive), for `{this} is approved`. */
function backwardNounPhrase(tokens, pos) {
    if (pos < 0)
        return null;
    const last = tokens[pos];
    if (!isNounToken(last))
        return null;
    let start = pos;
    if (last.kind === "word") {
        while (start - 1 >= 0 && pos - start < MAX_SLOT_TOKENS) {
            const token = tokens[start - 1];
            if (token.kind !== "word" || BOUNDARY.has(token.value))
                break;
            start--;
        }
    }
    else {
        // 'x' of 'y' chains: "the borrower of 'the loan' is approved" -> take back through `of` words
        while (start - 2 >= 0 &&
            tokens[start - 1].kind === "word" &&
            tokens[start - 1].value === "of") {
            const before = tokens[start - 2];
            if (before.kind !== "word" || BOUNDARY.has(before.value))
                break;
            start -= 2;
            while (start - 1 >= 0 &&
                tokens[start - 1].kind === "word" &&
                !BOUNDARY.has(tokens[start - 1].value) &&
                tokens[start - 1].value !== "of")
                start--;
        }
    }
    return { from: start, to: pos + 1, text: spanText(tokens, start, pos + 1) };
}
function typeSlot(slot, tokens, env, matcher, depth) {
    let span = tokens.slice(slot.from, slot.to);
    // `in 'the loan report', reject ...`: punctuation at the edges of a slot is not part of its value.
    while (span.length > 1 &&
        span[span.length - 1].kind === "punct" &&
        [",", ";", ":"].includes(span[span.length - 1].value))
        span = span.slice(0, -1);
    while (span.length > 1 && span[0].kind === "punct" && [",", ":"].includes(span[0].value))
        span = span.slice(1);
    // `(the location of 'the merchant')`: brackets around an argument don't change its type.
    while (span.length > 2 &&
        span[0].kind === "punct" &&
        span[0].value === "(" &&
        span[span.length - 1].kind === "punct" &&
        span[span.length - 1].value === ")") {
        span = span.slice(1, -1);
    }
    if (span.length === 1) {
        const token = span[0];
        if (token.kind === "var") {
            const type = env.variables.get(token.value);
            if (type) {
                slot.type = type;
                slot.typedBy = "variable";
            }
            return;
        }
        if (token.kind === "number") {
            slot.type = "number";
            slot.typedBy = "literal";
            return;
        }
        if (token.kind === "string") {
            slot.type = "string";
            slot.typedBy = "literal";
            return;
        }
    }
    const words = span
        .filter((token) => token.kind === "word")
        .map((token) => token.value);
    if (words.length === span.length) {
        // `this ilr project element`, `each item`, `cet élément`, `este pedido`: a demonstrative in front of a concept label
        const label = words
            .join(" ")
            .replace(/^(this|each|that|every|ce|cet|cette|ces|chaque|este|esta|esse|essa|cada) /, "");
        const concept = env.concepts.get(label);
        if (concept) {
            slot.type = concept;
            slot.typedBy = "concept";
            return;
        }
        const variable = env.variables.get(label);
        if (variable) {
            slot.type = variable;
            slot.typedBy = "variable";
            return;
        }
    }
    if (depth < 3) {
        // A nested navigation that covers the whole slot gives the slot its type.
        const inner = matcher.match(span, env, depth + 1);
        const whole = inner.find((m) => m.from === 0 && m.to === span.length && m.compiled.phrase.kind === "navigation");
        if (whole?.compiled.phrase.type) {
            slot.type = whole.compiled.phrase.type;
            slot.typedBy = "navigation";
        }
    }
}
/**
 * Prefer longer phrases: drop a match whose literal tokens are a strict subset
 * of another match's. Among matches on the same literal tokens, keep those whose
 * subject type fits; if none fit, keep all as unresolved.
 */
function disambiguate(matches) {
    if (matches.length < 2)
        return matches;
    const covered = matches.map((m) => new Set(m.literals));
    const kept = matches.filter((m, i) => {
        for (let j = 0; j < matches.length; j++) {
            if (i === j)
                continue;
            const other = covered[j];
            if (other.size <= m.literals.length)
                continue;
            if (m.literals.every((pos) => other.has(pos)))
                return false;
        }
        return true;
    });
    const groups = new Map();
    for (const m of kept) {
        const key = m.literals.join(",");
        const list = groups.get(key) ?? [];
        list.push(m);
        groups.set(key, list);
    }
    const out = [];
    for (const group of groups.values()) {
        const fitting = group.filter((m) => m.resolved);
        if (fitting.length)
            out.push(...fitting);
        else
            out.push(...group.map((m) => ({ ...m, resolved: false })));
    }
    return out.sort((a, b) => a.from - b.from);
}
