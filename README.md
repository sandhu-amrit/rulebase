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

The Miniloan sample under `src/fixtures/miniloan` is from DecisionsDev/odm-on-cloud-getting-started and is Apache-2.0. See `src/fixtures/miniloan/APACHE-LICENSE.txt`.

```bash
npm install
npm run dev
npm test
npm run reindex
```

The dev server listens on port 8080. `npm run reindex` writes `rulebase.json` from a Rule Designer folder:

```bash
npm run reindex -- path/to/project previous-rulebase.json
```
