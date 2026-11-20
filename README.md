# Rulebase

A knowledge pipeline for existing IBM ODM rule projects. It turns a Rule Designer folder into a structured, queryable model that an agent can trust when it proposes a change.

The goal is not searchable text. The goal is a model with provenance, vocabulary grounding, and ruleflow semantics, so a proposal is either grounded in the real rules or rejected.

Private repo: [sandhu-amrit/rulebase](https://github.com/sandhu-amrit/rulebase).

## Goal

An agent that changes an ODM decision service has to know three things before it writes a rule:

1. What is actually deployed: packages, ruleflows, selection filters, decision operations.
2. What words are legal: the BOM and its verbalizations, not invented business language.
3. What a change touches: the package, the ruleflow task that selects it, and the operation that runs that flow.

Rulebase is the store that answers those. A chat host (Copilot, Claude, watsonx, or the built-in workbench) calls the tools. The pipeline returns artifacts, impact, and a draft — or a rejection if a term is not in the vocabulary.

## What it does

| Layer | What is stored |
|---|---|
| Structured artifacts | Action rules (definitions / if / then / else), decision tables (columns, partitions, rows, preconditions), ruleflows (tasks, transitions, selection), decision operations, variable sets, packages, project |
| Vocabulary | Classes, members, verbalizations, parameters. `{this}` and argument slots are instantiated against the parameters |
| Decision-service boundary | Operation signature, the ruleflow it runs, the packages that flow selects |
| Graph | `CONTAINS`, `SELECTS_FROM`, `USES_TERM`, `EXTRACTS`, `BINDS_PARAMETER`, plus `OVERRIDES`, `COVERS`, `SHARES_BOM` when the source has them |
| Search | BM25 plus a 128-dimension hashed token vector |
| Grounding | Curated glossary (for example "over-leveraged" → yearly repayment / yearly income). Unknown tokens reject the proposal |
| Versions | Each reindex is a snapshot in SQLite. Drift is the diff against the previous snapshot |

## How to run

Requires Node 22 (the store uses the built-in `node:sqlite`).

```bash
npm install
npm run dev
```

The workbench is at `http://localhost:8080`. It loads the Miniloan sample. Open a Rule Designer folder to index that project instead. Tabs:

- **Pipeline** — counts, quality gates, ruleflow
- **Rules** — search and open an artifact
- **Vocabulary** — terms and verbalizations
- **Impact** — what a package or rule change touches
- **Agent** — ground a requirement; accept writes the mapping into the session glossary
- **Versions** — save a checkpoint and drift it against the current index

### Tests

```bash
npm test
```

The ODM suite is `src/lib/odm/pipeline.test.ts`. It checks parse counts, term grounding, impact, unknown-term rejection, feedback, drift, the SQLite round-trip, and the quality gates.

### Reindex a project into SQLite

```bash
npm run reindex -- path/to/rule-designer-project rulebase.sqlite
```

Each run appends a snapshot. The next run prints drift against the previous snapshot in that file. The file is gitignored.

### Quality gates on the sample

On Miniloan the gates that must pass are: artifacts parsed, provenance (UUID + path) on every rule, ruleflow selection resolves, decision tables have rows, the operation signature binds known parameters, and name search recall@5 is at least 95%.

## Agent tools

These are the calls an external agent is meant to make. They are implemented on `KnowledgeBase` and listed in `src/lib/odm/agent.ts`.

| Tool | Input | Returns |
|---|---|---|
| `search_rules` | query, optional package | Ranked artifacts |
| `get_artifact` | id or name | Full structured artifact |
| `get_vocabulary` | optional class or package | Terms |
| `get_ruleflow_impact` | package or artifact | Artifacts in scope, with reasons |
| `get_decision_operation_signature` | optional operation name | Inputs, direction, bound type |
| `validate_terms` | phrases | Missing phrases |
| `map_requirement` | requirement text | Mapped terms, unknown tokens, draft or rejection |
| `record_feedback` | requirement, accepted | Glossary update when accepted |

A proposal is allowed only when every content word maps to a real term. "Reject loans when the borrower is over-leveraged" is allowed. "Reject the loan when the vibe score of the applicant is low" is rejected because `vibe` is not in the BOM.

## Layout

```
src/lib/odm/          parser, index, store, agent tools, tests
src/fixtures/miniloan Apache-2.0 Miniloan decision service
src/components/workbench.tsx
src/routes/           app shell
docs/                 design and build notes
.github/workflows/reindex.yml
```

The Miniloan sample is from [DecisionsDev/odm-on-cloud-getting-started](https://github.com/DecisionsDev/odm-on-cloud-getting-started) and is Apache-2.0. The license text ships at `src/fixtures/miniloan/APACHE-LICENSE.txt`.

## Status

This is the first decision-service slice: parse, index, ground, impact, drift, SQLite snapshots, and a workbench. It is not yet a hosted multi-tenant system. There is no separate vector database, no Rule Model API / DAIF ingest, and no Copilot or watsonx plugin. Those sit on top of this store once one decision service is trusted.

## Production service

The workbench is the reference client. The production surface is the API in [docs/API.md](docs/API.md).

```bash
npm run reindex -- path/to/project rulebase.sqlite
export RULEBASE_API_KEY=$(openssl rand -hex 24)
npm start
```

`npm start` serves the tools on port 8787, including an MCP endpoint at `/mcp` for a Copilot, Claude, or watsonx host. Accepted feedback is written to the SQLite file and survives a restart.
