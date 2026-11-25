# Rulebase: instructions for coding agents

Rulebase is a local, read-only knowledge base over one IBM ODM Rule Designer workspace, served to AI assistants over MCP. Its users trust its answers in order to change business rules. **A confident wrong answer is the worst bug it can have**: worse than a crash, a slow index, or a missing feature. Every change is judged by that.

Read `docs/DESIGN.md` for why it is built this way. For step-by-step recipes, open `docs/EXTENDING.md` when you add a file format, ODM syntax, a BAL language, a tool or a quality gate, or when you work on a bug from a real workspace.

## Invariants

These hold after every change. A pull request that breaks one is not done.

1. **Loud, not silent.** Anything Rulebase cannot read or place becomes a `Warning` with its path (and line, where there is one). `severity: "error"` means it could hide a rule; `"info"` means it is noted and has no effect on answers. Every result ends with the `checked` footer, built by `KnowledgeBase.checked()`.
2. **Complete over precise.** When a subject can't be typed, keep every candidate match and mark it `resolved: false`. Impact may over-report but must never drop a rule.
3. **Strict over helpful.** A term that does not validate exactly becomes a vocabulary gap that says why. It is never matched to the nearest similar term.
4. **Deterministic.** The same workspace gives the same index and the same answers: stable sort orders, no clocks or randomness in results (`indexedAt` is the only timestamp).
5. **Read-only.** Rulebase never writes into the workspace. Its only writes are the cache file and the files the user asks for (`report`, `anonymize`).
6. **No business data leaves the machine.** Fixtures are hand-written, or are public samples whose licence allows it (Miniloan is Apache-2.0). Test against a real workspace only through `rulebase anonymize`.

## Where each change goes

The pipeline is: scan → parse (pure, one file at a time, cached) → link (one model) → query.

| To change… | Edit | Notes |
|---|---|---|
| Which files and projects are found, encodings, the decision-service choice | `src/workspace.ts` | Project references come from `.project` and BOM paths in `.ruleproject`. |
| Reading one file format | `src/parse/bom.ts`, `voc.ts`, `b2x.ts`, `artifacts.ts`; XML helpers in `xml.ts` | Parsers are pure: text in, data and warnings out. |
| Resolving the vocabulary, B2X, ruleset parameters, which rule uses which member, graph edges | `src/link.ts` | `link()` copies what it changes, so cached parses are never mutated. |
| Tokenizing BAL, phrase patterns, slot typing, languages | `src/bal.ts`; articles in `src/text.ts` | English, French, Portuguese and Spanish words live in the `ARTICLES`, `BOUNDARY` and `BAL_WORDS` sets. |
| What a tool answers | `src/kb.ts` | Keep answers small: summaries plus ids, and `get_artifact` for detail. |
| A tool's name, description or input schema (the MCP contract) | `src/tools.ts` | A breaking change bumps the major version in `package.json` and `src/version.ts`. |
| How an assistant should use the tools (the procedure) | `skills/odm-change-analysis/SKILL.md`, plus the short `INSTRUCTIONS` in `src/tools.ts` | When a tool or a result field is added, renamed or changes meaning, update both. `test/skill.test.ts` catches tool names that drift. |
| Freshness, watching, incremental rebuild | `src/session.ts`, `src/indexer.ts` | |
| The cache | `src/store.ts` | It is disposable: on a schema change, bump `SCHEMA_VERSION`. |
| Quality gates and the HTML report | `src/check.ts`, `src/report.ts` | |
| CLI commands | `src/main.ts` | |

## Done means

Every item, in this order:

1. **A failing test first**, in the test file for that area (see `docs/EXTENDING.md`). A pattern found in a real workspace gets a hand-written case in a fixture, never copied business content.
2. If a parser's output changes, **bump `PARSER_VERSION`** in `src/indexer.ts`, so cached parses are not reused.
3. `npm run typecheck` and `npm test` both pass.
4. **`npm run build`**, then commit `dist/` together with `src/`. A git install runs `dist/` with no build step, and CI fails if `dist/` doesn't match `src/` (`npm run check:dist`).
5. For changes to parsing, linking, search or the session: `npm run bench -- 5000` still meets the speed targets in `docs/DESIGN.md` (D15).
6. **Docs updated wherever behaviour changed**: `README.md` (users), `docs/DESIGN.md` (a new or changed decision, or status), this file (a new invariant or area). Edit in place; delete what is no longer true.

## Gotchas

- `fixtures/**` is byte-exact (`.gitattributes`): CRLF line endings and windows-1252 encoding are part of what is tested. Write fixture files with the line endings you mean.
- `output`, `bin` and `target` are build folders only when they sit next to a `.ruleproject`. Inside `rules/` they are ordinary packages.
- A bare `a` is dropped as an article, including the Portuguese/Spanish preposition `a`; the French `à` is kept, as the word `a`. When dropping `a` leaves two slots adjacent (`atribuir … {this} a {value}`), `PhraseMatcher.tryAt` handles it (`nextIsSlot`).
- Node runs `src/*.ts` directly (`--experimental-strip-types`), except under `node_modules`. That is why installs use the compiled `dist/`.
- Logs from the MCP server go to stderr; stdout belongs to the protocol.
