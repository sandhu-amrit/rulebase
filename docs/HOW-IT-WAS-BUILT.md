# How it was built

A record of how the repo got to its current shape, so a later change can see what was chosen and why. The decisions themselves are in [DESIGN.md](DESIGN.md).

## Phase 0 (2026-11-20): proof of concept

The first version proved the idea on IBM's Miniloan sample: a deterministic parser for Rule Designer XML, BM25 plus a hashed vector, a curated glossary, impact through ruleflow selection, SQLite snapshots, a browser workbench, an HTTP API and DAIF ingest. It was built inside an app-builder template, which brought auth, Postgres, PWA and preview scaffolding.

A review on 2026-11-24 measured it against what other developers would need:

- **Scale.** At 1,000 artifacts a reindex took 27 s, 24 s of it the recall gate running a full search per rule. At 5,000 artifacts it took about 10 minutes. Search scanned every document per query. Each reindex stored a full 15 MB copy.
- **Accuracy.**
  - 11 of 11 valid paraphrased requirements were rejected: numbers, comparison words and inflections counted as unknown vocabulary.
  - 2 of 7 nonsense requirements were accepted, because nothing checked types.
  - `com.x.y` BOM packages collapsed every class into one, and the BOM regex missed `extends`, `implements`, statics and domains.
  - `.ruleproject` files were never read by the CLI.
  - The eval set was one positive case, two negative ones and one search query.
- **Fit.** 55 of 56 dependencies belonged to the template or the UI. The ODM tests did not run under `npm test`.

## Phase 1 (2026-11-24 and 25): the rebaseline

The design review settled the decisions now in DESIGN.md: a local MCP tool, no UI, the assistant does language while Rulebase validates, SQLite as a disposable cache, full BOM and virtual-BOM fidelity, Windows first. The work, in commit order:

1. **Removed the template, UI, HTTP API and DAIF.** All remain in history.
2. **Rebuilt the pipeline around a workspace.**
   - Discovery follows project references.
   - The BOM parser is a statement scanner.
   - B2X marks virtual members and what they are computed from.
   - The vocabulary resolves owners by the longest class prefix, in one locale.
   - BAL matching uses typed token patterns.
   - Nine read-only tools sit on top, each answer ending in a `checked` footer.
3. **Made it fast without dropping checks.**
   - Unchanged files are not re-read.
   - Term matching is reused per artifact while the vocabulary is unchanged.
   - Phrases are indexed on two-word anchors.
   - Table cells keep values only.
   - The XML parser no longer builds a path string per element.
   - The recall gate moved to `rulebase check`.
4. **Added `rulebase anonymize` and cross-platform CI.**

### What was measured, and how

- `npm test`: parser units, both fixtures, the accuracy cases (the phase 0 failures are now tests), the incremental cache and drift, a real MCP client over stdio, and the anonymizer.
- `npm run bench -- 5000`, on an Intel i7-9750H Mac with Node 25:
  - full index 5–6 s;
  - incremental 0.7–0.9 s;
  - every query p95 under 10 ms;
  - a fresh server process at about 300 MB RSS (81 MB heap).

### Choices that were deliberate

- **Token patterns, not a BAL grammar.** It's deterministic and fast. The planned IBM-parser comparison (DESIGN D17) is how mismatches will be found.
- **Untyped uses are kept, marked unresolved.** Impact must not miss a rule; precision is reported in the footer.
- **mtime and size decide whether a file is re-read.** `--full` re-hashes everything.
- **One locale.** Mixing locales put French phrases into an English lexicon.

## Not built yet

- The IBM-parser comparison harness (D17).
- The Decision Center connector and activities.
- Decision tree structure (trees are indexed as text).
- Rule overrides and test coverage from real projects.
- Writing rules (phase 2).
