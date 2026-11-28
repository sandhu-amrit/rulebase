/**
 * Parser for `.voc` vocabulary files: Java-properties style lines
 *
 *   com.acme.loan.Borrower#concept.label = borrower
 *   com.acme.loan.Borrower.creditScore#phrase.navigation = {credit score} of {this}
 *   com.acme.loan.Loan.addToMessages(java.lang.String)#phrase.action = add {0} to the messages of {this}
 *
 * Owners are left unresolved here. Which part of `a.b.C.d` is the class is only
 * known once every BOM class is known, so resolution happens at link time.
 */
import type { Provenance, Warning } from "../model.ts";

export interface VocEntry {
  /** Everything before `#`: a class fqn or `<classFqn>.<member>[(<types>)]`. */
  owner: string;
  /** Everything after `#`, e.g. `phrase.navigation`. */
  key: string;
  value: string;
  line: number;
}

export interface ParsedVoc {
  locale?: string;
  uuid?: string;
  entries: VocEntry[];
  provenance: Provenance;
  warnings: Warning[];
}

const KNOWN_KEYS = new Set(["concept.label", "phrase.navigation", "phrase.action"]);

export function vocLocale(path: string): string | undefined {
  const base = path.split("/").pop() ?? path;
  const match = /_([a-z]{2,3}(?:_[A-Z]{2})?(?:_\w+)?)\.voc$/i.exec(base);
  return match?.[1];
}

export function parseVoc(content: string, provenance: Provenance): ParsedVoc {
  const entries: VocEntry[] = [];
  const warnings: Warning[] = [];
  let uuid: string | undefined;
  const lines = joinContinuations(content.replace(/^﻿/, "").split(/\r?\n/));
  for (const { text, line } of lines) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const sep = separatorIndex(trimmed);
    if (sep < 0) {
      warnings.push({
        path: provenance.path,
        severity: "info",
        message: `line ${line}: no '=' in '${trimmed.slice(0, 60)}'`,
      });
      continue;
    }
    const rawKey = unescape(trimmed.slice(0, sep).trim());
    const value = unescape(trimmed.slice(sep + 1).trim());
    if (rawKey === "uuid") {
      uuid = value;
      continue;
    }
    const hash = rawKey.lastIndexOf("#");
    if (hash < 0) {
      warnings.push({
        path: provenance.path,
        severity: "info",
        message: `line ${line}: key without '#': ${rawKey}`,
      });
      continue;
    }
    const owner = rawKey.slice(0, hash);
    const key = rawKey.slice(hash + 1);
    if (!KNOWN_KEYS.has(key)) {
      warnings.push({
        path: provenance.path,
        severity: "info",
        message: `line ${line}: vocabulary key '${key}' is kept but not used`,
      });
    }
    entries.push({ owner, key, value, line });
  }
  return { locale: vocLocale(provenance.path), uuid, entries, provenance, warnings };
}

function joinContinuations(lines: string[]): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let buffer = "";
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!buffer) start = i + 1;
    const continued = /(^|[^\\])(\\\\)*\\$/.test(line);
    // A continuation line's leading whitespace is not part of the value (Java properties).
    const piece = buffer ? line.replace(/^\s+/, "") : line;
    buffer += continued ? piece.slice(0, -1) : piece;
    if (continued) {
      buffer = buffer.replace(/\s+$/, "") + " ";
      continue;
    }
    out.push({ text: buffer, line: start });
    buffer = "";
  }
  if (buffer) out.push({ text: buffer, line: start });
  return out;
}

/** First unescaped `=` or `:`. */
function separatorIndex(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "=" || text[i] === ":") {
      // `:` only counts before any `#`-free owner; owners never contain `:` so this is safe.
      return i;
    }
  }
  return -1;
}

function unescape(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, esc: string) => {
    if (esc[0] === "u" && esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (esc === "n") return "\n";
    if (esc === "t") return "\t";
    return esc;
  });
}
