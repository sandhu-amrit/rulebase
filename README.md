# Rulebase

Knowledge pipeline for IBM ODM rule projects.

It parses Rule Designer files (`.brl`, `.dta`, `.rfl`, `.bom`, `.voc`, `.dop`, and related artifacts), indexes rules and vocabulary, and rejects agent proposals that use terms that are not in the BOM.

## What it covers

- Structured artifacts: action rules, decision tables, ruleflows, decision operations, packages
- Vocabulary grounding with a synonym glossary and unknown-token rejection
- Impact analysis that follows ruleflow selection
- Version snapshots and drift between indexes
- Feedback that writes accepted mappings back into the session glossary
- Agent tool surface: `search_rules`, `get_artifact`, `get_vocabulary`, `get_ruleflow_impact`, `get_decision_operation_signature`, `validate_terms`, `map_requirement`, `record_feedback`

The index is stored in a single SQLite file (`rulebase.sqlite`) using Node's built-in `node:sqlite`. Each reindex appends a snapshot, so drift is the difference between the new snapshot and the previous one in the same file.

```bash
npm install
npm run dev
npm test
npm run reindex
```

`npm run reindex` writes `rulebase.sqlite` from a Rule Designer folder. Pass a folder and an existing database to append another snapshot:

```bash
npm run reindex -- path/to/project rulebase.sqlite
```
