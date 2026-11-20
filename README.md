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

A Rule Designer folder or a DAIF JSON document:

```bash
npm run reindex -- path/to/rule-designer-project rulebase.sqlite
npm run reindex -- path/to/decision-service.json rulebase.sqlite
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

## Which input

Either. You do not need both. They land in the same index.

| You have | Index this |
|---|---|
| An existing ODM project in Rule Designer or Git | The folder (`.ruleproject`, `rules/`, `bom/`) |
| A DAIF `DecisionService` JSON from a tool or an export | The `.json` |
| Both | The folder. It is the project. DAIF is a copy. |

For an existing rule app, the Rule Designer folder is the source of truth. DAIF is an extra door, not a conversion you have to do first.

## Workflow

You have this repo and a rule app in a workspace. Next is to index that app, then use the index when a requirement comes in.

1. Index the rule app.

```bash
npm install
npm run reindex -- /path/to/your-rule-app rulebase.sqlite
```

The output ends with the quality gates. You want all of them `PASS`. A selection or signature failure means the folder is incomplete, or the ruleflow names a package that is not in the project.

2. Look at it.

```bash
npm run dev
```

Open `http://localhost:8080`, then **Open project folder** and pick the same rule app. Impact should only include what the ruleflow actually selects.

3. Run it as the service an agent calls.

```bash
export RULEBASE_API_KEY=$(openssl rand -hex 24)
export RULEBASE_DB=rulebase.sqlite
npm start
```

That is the production surface, on port 8787.

4. A requirement comes in.

1. `map_requirement` grounds the words onto the BOM. If a word is not in the vocabulary, the proposal is rejected.
2. `search_rules` and `get_ruleflow_impact` show which rules, package, and operation the change touches.
3. A person reviews the draft. Accept writes the mapping into the glossary.
4. The person edits the rule in Rule Designer or Decision Center and commits. Rulebase does not write the rule.
5. Reindex again. Drift tells you what changed.

## Architecture

Two inputs, one index, three ways to ask it.

```text
Rule Designer folder ── parse.ts ──┐
                                   ├── kb.ts (search, graph, grounding, impact) ── rulebase.sqlite
DAIF JSON ──────────── daif.ts ────┘                                                    │
                                                                                        ▼
                              Workbench          CLI reindex          HTTP API :8787
                              (browser)          (snapshot+drift)     /v1/.../tools/...
                                                                      /mcp  (MCP-shaped)
```

| Piece | What it is |
|---|---|
| Ingest | `parse.ts` reads Rule Designer XML. `daif.ts` reads a DAIF document. Same artifacts, terms, and selection either way. |
| Index | `kb.ts`. BM25 plus a hashed vector, the relationship graph, grounding, impact, quality gates. |
| Store | One SQLite file. Snapshots, learned glossary, feedback, drift. |
| Workbench | Reference client. Sample or an uploaded folder, in memory. |
| API | The service. API key, multi-project, the tools. |
| `/mcp` | MCP-shaped JSON-RPC on that API. Not a host-ready MCP server. |

A requirement goes `map_requirement` → `search_rules` → `get_ruleflow_impact`. Unknown vocabulary rejects. A person accepts, edits the rule in ODM, and reindexes.

## Status

Built: parse (Rule Designer and DAIF), index, grounding, impact, drift, SQLite snapshots, workbench, authenticated HTTP API, and an MCP-shaped `/mcp` endpoint.

Not built: a host-ready MCP server (no stdio, no Streamable HTTP session), a Copilot or watsonx plugin, a hosted vector database, and writing the change back into the rule project.

## Production service

The workbench is the reference client. The production surface is the API in [docs/API.md](docs/API.md).

```bash
npm run reindex -- path/to/project rulebase.sqlite
export RULEBASE_API_KEY=$(openssl rand -hex 24)
npm start
```

`npm start` serves the tools on port 8787. `/mcp` answers `initialize`, `tools/list`, and `tools/call`. That is enough for a client you write. It is not the MCP protocol a Copilot or Claude host expects: there is no stdio transport, no Streamable HTTP session, and every call needs a `project` argument. Accepted feedback is written to the SQLite file and survives a restart.
