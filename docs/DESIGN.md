# Design

The knowledge base is the piece everything else depends on. Proposal quality, low hallucination, and correct impact analysis all come from it. The design is hybrid by default: structured documents, relationships, and hybrid search, with provenance and vocabulary grounding.

## What the store must contain

| Layer | Content | Why it matters |
|---|---|---|
| Structured artifacts | Full BAL of action rules (definitions, if, then, else), decision-table columns, partitions, rows, preconditions, decision trees, functions, technical rules, ruleflow tasks, transitions, selection filters, package hierarchy | Exact source of truth for a proposal |
| Vocabulary / BOM | Every class, attribute, method, verbalization, domain, enumeration, ruleset parameter | Stops hallucinated terms |
| Decision-service boundary | Decision operations, input and output signatures, which packages and rules are in scope for a ruleset | Bounds what is deployed and affected |
| Relationships | Package contains artifact, ruleflow task selects a package or uses a filter, rule uses a term, decision table has a column, test covers a rule, override, shared BOM | Impact analysis that respects selection |
| Provenance | UUID, path, commit, Decision Center id when present | Every fact can be traced to a source file |

## Storage

The production shape is:

- A structured document per artifact, kept by id. Search finds candidates. The full document is what the agent reasons over.
- A graph for structural questions (contains, selects, uses, extracts).
- Hybrid search: lexical (BM25) plus a vector signal.
- A synonym glossary in front of the vocabulary, so business language maps onto formal verbalizations before anything is proposed.
- Versioned snapshots, with a drift check between them.

What is implemented today is the pragmatic form of that:

- Documents and the graph live in one SQLite file (`node:sqlite`), one snapshot per reindex.
- Search is BM25 (`k1 = 1.2`, `b = 0.75`) plus a 128-dimension hashed token vector. Score is `0.62 * lexical + 0.38 * cosine`, with a small bonus when the query phrase appears in the artifact.
- The glossary is a curated list plus session entries from accepted proposals.
- Drift compares artifact fingerprints and vocabulary examples between two snapshots.

A dedicated graph database and an embedding service are not required to prove quality on one decision service. They are the next store once the schema and the gates are stable.

## Retrieval

An agent does not get a blob of text. It calls tools:

1. `map_requirement` — translate the request onto vocabulary. Reject if any content token is unknown.
2. `search_rules` — candidates from the grounded terms.
3. `get_artifact` — the full document, with provenance.
4. `get_ruleflow_impact` — packages, the flow task that selects them, the operation that runs the flow. Selection filters are part of the reason, not ignored.
5. `get_decision_operation_signature` — inputs and directions, bound to known parameters.
6. `validate_terms` — a hard check before a draft is allowed.
7. `record_feedback` — an accepted proposal becomes a glossary entry; a rejection is kept.

A draft is a skeleton in the project's own phrases. It is not applied. A person reviews it, then it is committed to the rule project.

## Quality bar

- 100% of rule artifacts parsed, each with a UUID and a file path.
- Recall@5 at least 95% when searching a rule by its own name.
- Zero tolerance for a term that is not in the vocabulary. The proposal is rejected, not softened.
- Impact follows selection. A rule is in scope only if a ruleflow task selects its package or names it, or it shares that package with the seed.
- Decision-table rows are recovered, including nested partitions.
- Operation inputs resolve to variable-set parameters.

## What is deliberately later

- Rule Model API or Decision Automation Interchange Format as the preferred ingest, instead of Rule Designer XML.
- Shared BOM across several decision services as a first-class project graph (the `SHARES_BOM` edge is reserved for it).
- Override and test-coverage edges populated from real priority and test artifacts (the edge types exist; Miniloan does not exercise them).
- A host plugin for Copilot, Claude, or watsonx. The tool names are the contract. The workbench is the reference client.
- Automatic reindex on push, beyond the GitHub Action that runs the pipeline test and a sample reindex.

## Sample

The proving project is Miniloan: three action rules, one 7-row decision table, one ruleflow selecting `eligibility` and `validation`, one decision operation, a BOM, a vocabulary, and a variable set. It is Apache-2.0 from DecisionsDev/odm-on-cloud-getting-started.
