# How it was built

This is the record of how the repo got to its current shape, so a later change can see what was chosen and why.

## Starting point

The brief was a knowledge base for existing IBM ODM rule apps, used by agents that incorporate future requirements. The design called for structured artifacts, a BOM, decision-service boundaries, a relationship graph, hybrid search, a synonym layer, provenance, and quality gates. The preference was the Rule Model API or DAIF. The practical start was a deterministic parser of a Rule Designer project, proved on a tutorial before a pilot.

## What was parsed

Real Miniloan files from DecisionsDev/odm-on-cloud-getting-started were used as the fixture, under the Apache-2.0 license that ships with them. The formats:

| Extension | Artifact |
|---|---|
| `.brl` | Action rule, BAL in a definition element |
| `.dta` | Decision table, nested partitions |
| `.dtr` `.fct` `.trl` | Decision tree, function, technical rule (typed; parsed as BAL-shaped when present) |
| `.rfl` | Ruleflow: start, rule, action, subflow, stop tasks, transitions, selection |
| `.dop` | Decision operation and the ruleflow it runs |
| `.var` | Variable set / ruleset parameters |
| `.bom` `.voc` | Model and English verbalizations |
| `.rulepackage` `.ruleproject` | Package and project |

`fast-xml-parser` is configured to treat repeating tags as arrays and to keep CDATA. Package names are derived from the path under `rules/`. BAL is split on `definitions` / `if` / `then` / `else`. Table rows are walked through nested partitions. Ruleflow tasks record the packages and rules they select, plus any filter text.

Verbalizations with `{this}` are instantiated against the matching parameter ("the borrower", and so on). `{0}` style slots become a wildcard in the match pattern.

## Index

`buildKnowledgeBase` parses the files, instantiates terms, links the graph, and builds the search index.

- BM25 over tokenized name, package, BAL, preconditions, column templates, and row summaries.
- A 128-dimension hashed embedding of the same tokens, for a cosine signal. This is a hashing trick, not a hosted embedding model, so the index has no network dependency.
- Edges: a package contains its artifacts; a ruleflow selects a package; an artifact uses a term when the instantiated phrase matches; an operation extracts a ruleflow and binds parameters.

## Grounding

`ground` is the agent path:

1. Expand the requirement through the glossary.
2. Match navigation, action, and parameter phrases.
3. Any remaining content token that is not in the lexicon is unknown.
4. Search with the mapped terms.
5. Impact from the top hit's package.
6. If unknowns remain, or nothing mapped, reject. Otherwise emit a draft that uses only mapped phrases.

The curated glossary maps phrases such as "over-leveraged", "high dti", and "debt ratio" onto yearly repayment and yearly income. Accepting a proposal in the workbench writes the mapping into the session glossary.

## Store

The first cut kept the index in memory and exported JSON. The durable store is now a single SQLite file via Node 22's `node:sqlite`. No extra database process.

Tables: `snapshots`, `artifacts`, `terms`, `edges`, `glossary`, `feedback`, `meta` (warnings and gates). Artifact and term bodies are JSON, so the full document is recoverable by id. Columns on type, package, and edge source support structural queries without loading every blob.

`npm run reindex` parses a folder, appends a snapshot, and diffs it against the previous snapshot in that file.

## Workbench

A TanStack Start app. The pipeline runs in the browser for the sample (fixtures are bundled with `import.meta.glob`) and for an uploaded Rule Designer folder. The same `buildKnowledgeBase` is what the CLI uses, so the workbench and the reindex cannot disagree about a file.

## Tests and CI

`src/lib/odm/pipeline.test.ts` is the contract for the sample: 3 rules, 1 table with 7 rows and 4 columns, 1 ruleflow selecting eligibility and validation, credit-score grounding, impact that includes the operation, rejection of "vibe", feedback, drift, SQLite round-trip, and all six gates. `.github/workflows/reindex.yml` runs that suite and a sample reindex on changes under `src/lib/odm` or `src/fixtures`.

## Choices that were deliberate

- Rule Designer XML first, not DAIF. It is deterministic and debuggable on a project a team already has in Git.
- A file database, not Postgres or a vector service, until one decision service is solid.
- Hashed vectors rather than an embedding API, so reindex is offline.
- Reject, do not guess, when a token is not in the vocabulary.
- The workbench is a reference client. The tool names are the API an external agent host should call.

## Not built yet

Persistent multi-project hosting, DAIF ingest, a real embedding index, override and test-coverage populated from production projects, and a Copilot or watsonx plugin. The schema has room for them. They were left until the Miniloan gates were green.
