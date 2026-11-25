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
- **mtime and size decide whether a file is re-read.** `--full` re-reads and re-parses everything.
- **One locale.** Mixing locales put French phrases into an English lexicon.

## Phase 1b (2026-11-25): real workspaces and a review

### Public sample corpus

Rulebase was run against every public Rule Designer workspace that could be found. Each round fixed what it exposed, and added a hand-written fixture case and a test for it.

| Source | Decision services | What they exposed |
|---|---|---|
| [DecisionsDev](https://github.com/DecisionsDev): `odm-transformation-advisor`, `odm-javatime`, `odm-libs-in-maven`, `odm-container-samples`, `ODM-AI-toolkit-for-Bob` (8 samples) | 13 | Body-level `domain {…}` (the first enum value was being lost); nested classes; parameter domains; `writeonly`; `@`-names; `#flags`; operators; `.b2xa`; fork/join nodes; classic `<parameters>` and no decision-service flag; unquoted definitions; `{this}.method({0})`; `{0, <hint>}`; brackets around arguments. Term resolution was made strict. |
| GitHub: [LoanValidation](https://github.com/ArnabMukherjee1991/LoanValidation), [ODMGovernanceAsset](https://github.com/ncrowther/ODMGovernanceAsset), [streamsx.health](https://github.com/IBMStreams/streamsx.health), [ODM_EducaCiencia_Template](https://github.com/perucello/ODM_EducaCiencia_Template), [IA-Hybride](https://github.com/oussemaBenAmor/IA-Hybride), [denim-compute](https://github.com/ibm-cloud-architecture/denim-compute), [athena-owl-demos](https://github.com/AthenaDecisionSystems/athena-owl-demos), [odm-cicd](https://github.com/pberlandier/odm-cicd), [SYRACUSE](https://github.com/jlv91/SYRACUSE), [ICP-Airways](https://github.com/SaifRehman/ICP-Airways), [ibm-odm-support-samples](https://github.com/inukshuk-io/ibm-odm-support-samples) | 14 | French and Portuguese BAL. A French rule yielded zero uses and no error, the worst failure found. Also: a package folder named `output` was skipped; subflows referenced by `Uuid`; `@term#plural`; draft rules; ADS and DSI projects that looked empty. |

After both rounds the corpus gives 336 rules and 1,675 of 1,678 term uses typed. The remaining errors are defects in the repositories themselves.

### Review

An external review looked for confident wrong answers, and all 11 findings were confirmed and fixed. Each has a test in `test/review.test.ts`:
- stale parses reused across a parser upgrade;
- build-folder ignore rules that missed real packages;
- a failed rebuild answering silently from the old index;
- a class name plus keywords passing validation;
- a missing verbalization reported as a missing BOM member;
- bare rule names linking to every same-named rule;
- "does not run" ignoring operations without a ruleflow;
- ruleflow conditions never offered as change candidates;
- two smaller scoring and ambiguity issues.

### Documentation for agents

`AGENTS.md` holds the invariants, the map of which file owns which change, and the done checklist. `docs/EXTENDING.md` holds the recipes, and `.github/copilot-instructions.md` points Copilot at both.

### The skill

`skills/odm-change-analysis/SKILL.md` gives assistants the procedure the MCP tools leave open: which tool answers which question, a done criterion per step, how to read the special results, and the proposal handed to a person. It was checked end to end with a headless Claude Code session on the LoanValidation sample. The skill fired on its own, the tools were called in the intended order, and the proposal was grounded. That run also exposed definitions holding a literal or arithmetic (`set 'minimum score' to 200`) that were not typed; this is now fixed. `test/skill.test.ts` keeps the skill's tool names in step with `src/tools.ts`.

### Large requirements and ruleflow changes

- **Large requirements.** `find_change_candidates` ranks by how many of the given terms a rule uses, so passing terms from unrelated clauses together buries the best match for each clause. The skill's `large-requirement.md` splits the work clause by clause and merges by artifact, flagging conflicts, rules that already cover a clause, and order dependencies.
- **Ruleflow changes.** `src/flow.ts` analyzes each ruleflow: running order (longest path from the start), every path with its conditions, "otherwise" branches, fork/join, loops and unreachable tasks. Complementary branches collapse back into "always". `get_ruleflow_paths` exposes it, `runs` lines now state the full path condition, and a rule selected only by an unreachable task is reported as not running. The skill's `ruleflow-change.md` works a change from the actual paths: rules that start or stop running, changed conditions, changed order, and algorithm semantics.

Both were checked end to end with headless Claude Code sessions on LoanValidation:
- **A four-clause change request.** The session grounded the vocabulary once and ran each clause on its own. It blocked the clause needing self-employment, which isn't in the vocabulary, and caught that "accept up to 1,500,000" also needs `is at least` changed to `is more than`.
- **Moving the insurance task before eligibility.** The session found that the insurance table reads the grade that eligibility sets. Moving the task would silently give every loan the default rate, so it proposed dropping one transition condition instead.

Subflows are followed at any depth. `flowRunContexts` builds every call chain from an operation down to a ruleflow, combines the calling tasks' conditions, and checks that each calling task is reachable. A rule inside a subflow carries its callers' conditions in its `runs` line, and a subflow called only from an unreachable task does not run. On the governance asset, a rule four levels deep reports `mainRuleflow → sharedFlow → advancedGovernanceFlow → elementCommitted`, with the condition that selects it.

The first run also showed `find_change_candidates`' add section disagreeing with the run path about a sub-package selected through its parent. Both now use one lookup, `tasksSelectingPackage`.

## Not built yet

- The IBM-parser comparison harness (D17).
- Reading Java (XOM) method bodies for impact (D11).
- BAL languages beyond English, French, Portuguese and Spanish.
- The Decision Center connector and activities.
- Decision tree structure (trees are indexed as text).
- Rule overrides and test coverage from real projects.
- Writing rules (phase 2).
