/**
 * Matching BAL text against vocabulary phrases.
 *
 * This is not a full BAL grammar. It does three things, deterministically:
 *
 * 1. Tokenizes BAL: words (articles dropped), quoted variables ('the loan'),
 *    string and number literals, operators, punctuation, and `<placeholders>`
 *    from decision-table templates.
 * 2. Finds every occurrence of every phrase pattern. Literal words must be
 *    contiguous, and each `{this}` / `{0}` slot captures a bounded noun phrase.
 * 3. Types each slot (variable type, nested navigation type, concept label,
 *    literal) and keeps a match as *resolved* when the `{this}` type is
 *    compatible with the member's owner class.
 *
 * When a slot cannot be typed, every candidate owner is kept and marked
 * unresolved. Impact stays complete; the "checked" footer reports how many
 * uses were unresolved.
 */
import type { Phrase } from "./model.ts";
import { ARTICLES, normalize, phraseWords } from "./text.ts";

/** `at` and `end` are character offsets in the source text. */
export type Token =
  | { kind: "word"; value: string; at: number; end: number }
  | { kind: "var"; value: string; raw: string; at: number; end: number }
  | { kind: "string"; value: string; at: number; end: number }
  | { kind: "number"; value: string; at: number; end: number }
  | { kind: "placeholder"; value: string; at: number; end: number }
  | { kind: "op"; value: string; at: number; end: number }
  | { kind: "punct"; value: string; at: number; end: number };

/** Words that end a noun phrase inside a slot. */
const BOUNDARY = new Set([
  "is", "are", "not", "and", "or", "then", "else", "if", "to", "set", "make", "it", "that", "true", "false",
  "less", "more", "greater", "than", "least", "most", "between", "equals", "equal", "does", "contains", "contain",
  "starts", "ends", "with", "where", "from", "after", "before", "one", "print", "add", "remove", "in", "as",
  "definitions", "when", "for", "each", "all", "any", "following", "conditions", "condition", "there", "no",
  "number", "null", "times", "plus", "minus", "divided", "multiplied", "by", "has", "have", "be",
]);

const MAX_SLOT_TOKENS = 12;

/** BAL keywords and operator words: allowed in a validated phrase without being vocabulary. */
export const BAL_WORDS = new Set([
  ...BOUNDARY,
  "of", "at", "least", "most", "same", "nothing", "empty", "unknown", "other", "otherwise", "this", "these",
  "those", "their", "its", "which", "who", "whose", "variable", "value", "values", "date", "time", "today",
  "now", "year", "years", "month", "months", "day", "days", "week", "weeks", "hour", "hours", "minute", "minutes",
  "percent", "sum", "average", "minimum", "maximum", "count", "list", "collection", "elements", "element",
  "first", "last", "size", "new", "true", "false", "yes", "no", "also", "only", "every", "exists", "exist",
  "below", "above", "under", "over", "within", "outside", "inclusive", "exclusive", "higher", "lower",
  "greater", "fewer", "smaller", "bigger", "larger", "up", "down", "into", "on", "by", "per", "an", "a", "the",
  "do", "did", "done", "should", "must", "will", "would", "can", "could", "being", "been", "was", "were",
]);

export function tokenizeBal(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /'([^'\n]*)'|"((?:[^"\\]|\\.)*)"|(<[^<>\n]+>)|(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|-?\d+(?:\.\d+)?%?)|([A-Za-zÀ-ɏ][\wÀ-ɏ-]*)|(<=|>=|!=|==|[*/+\-<>=%])|([;,.:()])/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const at = match.index;
    const end = at + match[0].length;
    if (match[1] !== undefined) {
      tokens.push({ kind: "var", value: stripArticles(normalize(match[1])), raw: match[1], at, end });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: "string", value: match[2], at, end });
    } else if (match[3] !== undefined) {
      tokens.push({ kind: "placeholder", value: match[3].slice(1, -1).trim().toLowerCase(), at, end });
    } else if (match[4] !== undefined) {
      tokens.push({ kind: "number", value: match[4], at, end });
    } else if (match[5] !== undefined) {
      for (const word of phraseWords(match[5])) tokens.push({ kind: "word", value: word, at, end });
    } else if (match[6] !== undefined) {
      tokens.push({ kind: "op", value: match[6], at, end });
    } else if (match[7] !== undefined) {
      tokens.push({ kind: "punct", value: match[7], at, end });
    }
  }
  return tokens;
}

export function stripArticles(value: string): string {
  return value
    .split(" ")
    .filter((word) => word && !ARTICLES.has(word))
    .join(" ");
}

export type PatternItem = { lit: string } | { slot: number };

/**
 * Pattern for a verbalization. `{this}` is slot 0 and `{0}`, `{1}`… follow it in
 * order of appearance. Other braces (`{credit score}`) are literal words, except
 * the value placeholder of an attribute's setter action, which the caller marks
 * via `valueTerm`.
 */
export function compilePattern(template: string, valueTerm?: string): { items: PatternItem[]; slotNames: string[] } {
  const items: PatternItem[] = [];
  const slotNames: string[] = [];
  const re = /\{([^}]*)\}|([^{]+)/g;
  let match: RegExpExecArray | null;
  const valueNorm = valueTerm ? normalize(valueTerm) : undefined;
  let valueUsed = false;
  const parts: { text: string; brace: boolean }[] = [];
  while ((match = re.exec(template))) {
    if (match[1] !== undefined) parts.push({ text: match[1].trim(), brace: true });
    else parts.push({ text: match[2], brace: false });
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
    if (part.brace && (part.text === "this" || /^\d+$/.test(part.text) || (index === valueIndex && !valueUsed))) {
      if (index === valueIndex) valueUsed = true;
      items.push({ slot: slotNames.length });
      slotNames.push(part.text);
      return;
    }
    for (const word of phraseWords(part.text)) items.push({ lit: word });
  });
  return { items, slotNames };
}

export interface CompiledPhrase {
  phrase: Phrase;
  items: PatternItem[];
  /** Index into items of the first literal. -1 when the pattern has no literal (cannot be matched). */
  anchor: number;
  literalCount: number;
}

export interface SlotMatch {
  from: number;
  to: number;
  text: string;
  type?: string;
  /** How the type was found, for explanations. */
  typedBy?: "variable" | "navigation" | "concept" | "literal";
}

export interface PhraseMatch {
  compiled: CompiledPhrase;
  /** Token indices covered by literal words. */
  literals: number[];
  slots: SlotMatch[];
  from: number;
  to: number;
  resolved: boolean;
}

export interface TypeEnv {
  /** Variable name (articles stripped, normalized) -> type. */
  variables: Map<string, string>;
  /** Concept label (normalized) -> class fqn. */
  concepts: Map<string, string>;
  isAssignable(type: string, to: string): boolean;
}

export class PhraseMatcher {
  private readonly byAnchor = new Map<string, CompiledPhrase[]>();
  readonly compiled: CompiledPhrase[] = [];

  constructor(phrases: { phrase: Phrase; items: PatternItem[] }[]) {
    for (const { phrase, items } of phrases) {
      const anchor = items.findIndex((item) => "lit" in item);
      const literalCount = items.filter((item) => "lit" in item).length;
      const compiled: CompiledPhrase = { phrase, items, anchor, literalCount };
      this.compiled.push(compiled);
      if (anchor < 0) continue;
      const key = (items[anchor] as { lit: string }).lit;
      const list = this.byAnchor.get(key) ?? [];
      list.push(compiled);
      this.byAnchor.set(key, list);
    }
  }

  /** All matches in a token stream, disambiguated by slot type. */
  match(tokens: Token[], env: TypeEnv, depth = 0): PhraseMatch[] {
    const raw: PhraseMatch[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.kind !== "word") continue;
      const candidates = this.byAnchor.get(token.value);
      if (!candidates) continue;
      for (const compiled of candidates) {
        const found = this.tryAt(tokens, i, compiled, env, depth);
        if (found) raw.push(found);
      }
    }
    return disambiguate(raw);
  }

  private tryAt(tokens: Token[], at: number, compiled: CompiledPhrase, env: TypeEnv, depth: number): PhraseMatch | null {
    const { items, anchor } = compiled;
    const literals: number[] = [];
    const slots: SlotMatch[] = [];
    // Leading slot(s) before the anchor: only `{this} is approved` style, one slot.
    let from = at;
    if (anchor > 0) {
      if (anchor > 1 || !("slot" in items[0])) return null;
      const slot = backwardNounPhrase(tokens, at - 1);
      if (!slot) return null;
      slots[(items[0] as { slot: number }).slot] = slot;
      from = slot.from;
    }
    let pos = at;
    for (let k = anchor; k < items.length; k++) {
      const item = items[k];
      if ("lit" in item) {
        const token = tokens[pos];
        if (!token || token.kind !== "word" || token.value !== item.lit) return null;
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
          if (token.kind === "word" && token.value === next.lit && end > pos) break;
          if (token.kind === "punct" && token.value === ";") return null;
          end++;
        }
        if (end === pos || end >= tokens.length) return null;
        const t = tokens[end];
        if (!(t.kind === "word" && t.value === next.lit)) return null;
        slots[item.slot] = { from: pos, to: end, text: spanText(tokens, pos, end) };
        pos = end;
      } else {
        const slot = forwardNounPhrase(tokens, pos);
        if (!slot) return null;
        slots[item.slot] = slot;
        pos = slot.to;
      }
    }
    for (const slot of slots) if (slot) typeSlot(slot, tokens, env, this, depth);
    const thisIndex = compiled.phrase.slots.findIndex((slot) => slot.name === "this");
    let resolved = true;
    if (thisIndex >= 0) {
      const subject = slots[thisIndex];
      resolved = Boolean(subject?.type && env.isAssignable(subject.type, compiled.phrase.owner));
    }
    return { compiled, literals, slots, from, to: pos, resolved };
  }
}

function spanText(tokens: Token[], from: number, to: number): string {
  return tokens
    .slice(from, to)
    .map((token) => (token.kind === "var" ? `'${token.raw}'` : token.kind === "string" ? `"${token.value}"` : token.kind === "placeholder" ? `<${token.value}>` : token.value))
    .join(" ");
}

function isNounToken(token: Token | undefined): boolean {
  if (!token) return false;
  if (token.kind === "var" || token.kind === "placeholder" || token.kind === "string" || token.kind === "number") return true;
  return token.kind === "word" && !BOUNDARY.has(token.value);
}

/** Noun phrase starting at `pos`: a variable, a literal, or words up to a boundary (`of` chains allowed). */
function forwardNounPhrase(tokens: Token[], pos: number): SlotMatch | null {
  const first = tokens[pos];
  if (!isNounToken(first)) return null;
  if (first.kind !== "word") return { from: pos, to: pos + 1, text: spanText(tokens, pos, pos + 1) };
  let end = pos;
  while (end < tokens.length && end - pos < MAX_SLOT_TOKENS) {
    const token = tokens[end];
    if (token.kind === "var" || token.kind === "placeholder") {
      end++;
      break;
    }
    if (token.kind !== "word" || BOUNDARY.has(token.value)) break;
    end++;
  }
  return end > pos ? { from: pos, to: end, text: spanText(tokens, pos, end) } : null;
}

/** Noun phrase ending at `pos` (inclusive), for `{this} is approved`. */
function backwardNounPhrase(tokens: Token[], pos: number): SlotMatch | null {
  if (pos < 0) return null;
  const last = tokens[pos];
  if (!isNounToken(last)) return null;
  let start = pos;
  if (last.kind === "word") {
    while (start - 1 >= 0 && pos - start < MAX_SLOT_TOKENS) {
      const token = tokens[start - 1];
      if (token.kind !== "word" || BOUNDARY.has(token.value)) break;
      start--;
    }
  } else {
    // 'x' of 'y' chains: "the borrower of 'the loan' is approved" -> take back through `of` words
    while (start - 2 >= 0 && tokens[start - 1].kind === "word" && (tokens[start - 1] as { value: string }).value === "of") {
      const before = tokens[start - 2];
      if (before.kind !== "word" || BOUNDARY.has(before.value)) break;
      start -= 2;
      while (start - 1 >= 0 && tokens[start - 1].kind === "word" && !BOUNDARY.has((tokens[start - 1] as { value: string }).value) && (tokens[start - 1] as { value: string }).value !== "of") start--;
    }
  }
  return { from: start, to: pos + 1, text: spanText(tokens, start, pos + 1) };
}

function typeSlot(slot: SlotMatch, tokens: Token[], env: TypeEnv, matcher: PhraseMatcher, depth: number): void {
  const span = tokens.slice(slot.from, slot.to);
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
  const words = span.filter((token) => token.kind === "word").map((token) => (token as { value: string }).value);
  if (words.length === span.length) {
    const label = words.join(" ");
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
function disambiguate(matches: PhraseMatch[]): PhraseMatch[] {
  if (matches.length < 2) return matches;
  const covered = matches.map((m) => new Set(m.literals));
  const kept = matches.filter((m, i) => {
    for (let j = 0; j < matches.length; j++) {
      if (i === j) continue;
      const other = covered[j];
      if (other.size <= m.literals.length) continue;
      if (m.literals.every((pos) => other.has(pos))) return false;
    }
    return true;
  });
  const groups = new Map<string, PhraseMatch[]>();
  for (const m of kept) {
    const key = m.literals.join(",");
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  const out: PhraseMatch[] = [];
  for (const group of groups.values()) {
    const fitting = group.filter((m) => m.resolved);
    if (fitting.length) out.push(...fitting);
    else out.push(...group.map((m) => ({ ...m, resolved: false })));
  }
  return out.sort((a, b) => a.from - b.from);
}
