# Instructions for working on Rulebase

_For changing Rulebase's own code, in this repository. Copilot loads this file automatically; other coding agents can be pointed at it. To use Rulebase on a rule project, read `docs/GETTING-STARTED.md` instead, and don't copy this file there._

Rulebase is a local, read-only knowledge base over one IBM ODM Rule Designer workspace, served to AI assistants over MCP. Its users trust its answers in order to change business rules. **A confident wrong answer is the worst bug it can have**: worse than a crash, a slow index, or a missing feature. Every change is judged by that.

Read `docs/DESIGN.md` for why it is built this way. For a specific kind of change (a bug from a real workspace, new ODM syntax, a file type, a BAL language, a tool, a quality gate, performance), follow its recipe under **Recipes** below.

## Invariants

These hold after every change. A pull request that breaks one is not done. When unsure, report (a warning, `resolved: false`, a vocabulary gap) rather than guess.

1. **Loud, not silent.** Anything Rulebase cannot read or place becomes a `Warning` with its path (and line, where there is one). `severity: "error"` means it could hide a rule; `"info"` means it is noted and has no effect on answers. Every result ends with the `checked` footer, built by `KnowledgeBase.checked()`.
2. **Complete over precise.** When a subject can't be typed, keep every candidate match and mark it `resolved: false`. Impact may over-report but must never drop a rule.
3. **Strict over helpful.** A term that does not validate exactly becomes a vocabulary gap that says why. It is never matched to the nearest similar term.
4. **Deterministic.** The same workspace gives the same index and the same answers: stable sort orders, no clocks or randomness in results (`indexedAt` is the only timestamp).
5. **Read-only.** Rulebase never writes into the workspace. Its only writes are the cache file and the files the user asks for (`report`, `anonymize`).
6. **No business data leaves the machine.** Fixtures are hand-written, or are public samples whose licence allows it (Miniloan is Apache-2.0). Test against a real workspace only through `rulebase anonymize`.

## Where each change goes

The pipeline is: scan → parse (pure, one file at a time, cached) → link (one model) → query.

| To change…                                                                                   | Edit                                                                                   | Notes                                                                                                                                |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Which files and projects are found, encodings, the decision-service choice                   | `src/workspace.ts`                                                                     | Project references come from `.project` and BOM paths in `.ruleproject`.                                                             |
| Reading one file format                                                                      | `src/parse/bom.ts`, `voc.ts`, `b2x.ts`, `artifacts.ts`; XML helpers in `xml.ts`        | Parsers are pure: text in, data and warnings out.                                                                                    |
| Resolving the vocabulary, B2X, ruleset parameters, which rule uses which member, graph edges | `src/link.ts`                                                                          | `link()` copies what it changes, so cached parses are never mutated.                                                                 |
| Tokenizing BAL, phrase patterns, slot typing, languages                                      | `src/bal.ts`; articles in `src/text.ts`                                                | English, French, Portuguese and Spanish words live in the `ARTICLES`, `BOUNDARY` and `BAL_WORDS` sets.                               |
| What a tool answers                                                                          | `src/kb.ts`                                                                            | Keep answers small: summaries plus ids, and `get_artifact` for detail.                                                               |
| A tool's name, description or input schema (the MCP contract)                                | `src/tools.ts`                                                                         | A breaking change bumps the major version in `package.json` and `src/version.ts`.                                                    |
| How an assistant should use the tools (the procedure)                                        | `skills/odm-change-analysis/SKILL.md`, plus the short `INSTRUCTIONS` in `src/tools.ts` | When a tool or a result field is added, renamed or changes meaning, update both. `test/skill.test.ts` catches tool names that drift. |
| Ruleflow order, reachability and path conditions                                             | `src/flow.ts` (pure analysis), used by `src/kb.ts`                                     | Conditions are BAL text and are not evaluated. An unconditioned transition beside conditioned ones is "otherwise".                   |
| Freshness, watching, incremental rebuild                                                     | `src/session.ts`, `src/indexer.ts`                                                     |                                                                                                                                      |
| The cache                                                                                    | `src/store.ts`                                                                         | It is disposable: on a schema change, bump `SCHEMA_VERSION`.                                                                         |
| Quality gates and the HTML report                                                            | `src/check.ts`, `src/report.ts`                                                        |                                                                                                                                      |
| CLI commands                                                                                 | `src/main.ts`                                                                          |                                                                                                                                      |

## Done means

Every item, in this order:

1. **A failing test first**, in the test file for that area (see **Recipes**). A pattern found in a real workspace gets a hand-written case in a fixture, never copied business content.
2. If a parser's output changes, **bump `PARSER_VERSION`** in `src/indexer.ts`, so cached parses are not reused.
3. `npm run typecheck`, `npm test` and `npm run format:check` all pass (`npm run format` fixes formatting).
4. **`npm run build`**, then commit `dist/` together with `src/`. A git install runs `dist/` with no build step, and CI fails if `dist/` doesn't match `src/` (`npm run check:dist`).
5. For changes to parsing, linking, search or the session: `npm run bench -- 5000` still meets the speed targets in `docs/DESIGN.md` (D15).
6. **Docs updated wherever behaviour changed.** Every fact has one home:
   - `docs/REFERENCE.md`: tools, answers, commands, configuration, what is read, accuracy and performance numbers;
   - `docs/GETTING-STARTED.md`: the steps a new user follows;
   - `docs/DESIGN.md`: decisions and known risks;
   - `skills/odm-change-analysis/`: how an assistant uses the tools;
   - this file (`.github/copilot-instructions.md`): invariants, the map above, this checklist, the recipes and the regression corpus.

   Edit the home, link to it from elsewhere, and delete what is no longer true. `README.md` is only the front door.

## Gotchas

- `fixtures/**` is byte-exact (`.gitattributes`): CRLF line endings and windows-1252 encoding are part of what is tested. Write fixture files with the line endings you mean.
- `output`, `bin` and `target` are build folders only when they sit next to a `.ruleproject`. Inside `rules/` they are ordinary packages.
- A bare `a` is dropped as an article, including the Portuguese/Spanish preposition `a`; the French `à` is kept, as the word `a`. When dropping `a` leaves two slots adjacent (`atribuir … {this} a {value}`), `PhraseMatcher.tryAt` handles it (`nextIsSlot`).
- Node runs `src/*.ts` directly (`--experimental-strip-types`), except under `node_modules`. That is why installs use the compiled `dist/`.
- Logs from the MCP server go to stderr; stdout belongs to the protocol.

## Recipes

Step-by-step recipes for the common kinds of change. Each one ends when the **Done means** checklist above is met, and the invariants apply throughout.

### Which recipe

| Situation                                                                     | Recipe                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A real workspace shows errors, untyped uses, or zero matches                  | [1. Bug from a real workspace](#1-bug-from-a-real-workspace)             |
| ODM writes some syntax Rulebase doesn't read (BOM, `.voc`, B2X, XML artifact) | [2. New syntax in a known file type](#2-new-syntax-in-a-known-file-type) |
| A file type Rulebase skips altogether                                         | [3. New file type](#3-new-file-type)                                     |
| Rules in a language other than English, French, Portuguese or Spanish         | [4. New BAL language](#4-new-bal-language)                               |
| The assistant needs an answer no tool gives                                   | [5. New or changed tool](#5-new-or-changed-tool)                         |
| A check CI should enforce                                                     | [6. New quality gate](#6-new-quality-gate)                               |
| A speed or memory target is missed                                            | [7. Performance](#7-performance)                                         |

### 1. Bug from a real workspace

A **confident wrong answer** (zero matches, the wrong member, a rule labelled "does not run" when it does) outranks a loud failure. Treat a suspicious zero as a bug until shown otherwise.

1. **Get a shareable reproduction.** Ask the owner to run `rulebase anonymize <workspace> <out>`. It verifies that the copy indexes the same way, and a `DIFF` line in that check is itself a bug in `src/anonymize.ts`. Never ask for, or commit, the original files.
2. **Find the exact construct.** `rulebase query <ws> get_artifact '{"id":"…"}'` shows a rule's parts and every use with `resolved`. `rulebase check <ws>` lists every error with its path and line. To see which uses are untyped, iterate `kb.model.uses` (as in `test/review.test.ts`).
3. **Decide whose defect it is.** A `.voc` entry for a member the BOM lacks, or a ruleflow task selecting a deleted rule, is a defect in the workspace: Rulebase reporting it is correct. Rulebase misreading valid ODM is ours.
4. **Write the smallest hand-made case** that shows it: a unit test (`test/bom.test.ts`, `test/bal.test.ts`, `test/voc.test.ts`) for a parser construct, or a file in a fixture workspace (`fixtures/classic-workspace`, `fixtures/i18n-workspace`) with an assertion in that fixture's test file. Watch it fail.
5. **Fix it in the layer that owns it** (the "Where each change goes" table above), and bump `PARSER_VERSION` if parse output changed.
6. **Re-run the public corpus** if you have it (see [Corpus](#corpus)) and confirm nothing else moved.

### 2. New syntax in a known file type

- **`.bom`**: `src/parse/bom.ts`. `scanBlock` splits the file into statements, with nested class bodies. `parseClassHeader` and `parseMember` read one statement each. Add the construct to the real-world test in `test/bom.test.ts`. A statement that cannot be read must still produce an `error` warning with its line.
- **`.voc`**: `src/parse/voc.ts` reads lines. Owners (`a.b.C.member(types)`) are resolved in `link.ts` (`resolveOwner`). Slot syntax inside templates (`{this,…}`, `{0, <hint>}`) is normalized in `link.ts` where `verbalizations` is built.
- **B2X / `.b2xa`**: `src/parse/b2x.ts` reads; `applyB2x` in `link.ts` matches to BOM members and computes `derivedFrom`.
- **XML artifacts** (`.brl`, `.dta`, `.rfl`, `.dop`, `.var`, …): `src/parse/artifacts.ts`. Every element is parsed as an array, so use `children()` and `child()`; don't index the parse result directly. Decision tables cross-check their row count against an independent count of action sets: keep that check passing.

### 3. New file type

1. Add the extension to `INDEXED_EXTENSIONS` in `src/workspace.ts`, or to `KNOWN_SKIPPED` if it should be counted but not read.
2. Route it in `parseFile` (`src/indexer.ts`) to a new pure parser in `src/parse/`.
3. Carry the result on `ParsedFile` (`src/link.ts`), and use it in `link()`.
4. Add a fixture file and a test. Bump `PARSER_VERSION`.

Projects from other IBM products (ADS `.dmo`/`.drl`, DSI `agent.adsc`) are detected by `otherProduct()` in `src/workspace.ts` and reported, not read. Reading one of them is a design decision for `docs/DESIGN.md`, not a quick recipe.

### 4. New BAL language

The patterns are language-neutral; the word lists are not.

1. **Section keywords** (`if/then/else`, `si/alors/sinon`, …): `splitBal` in `src/parse/artifacts.ts`, both the regex and `keyMap`.
2. **Articles** (dropped from both rule text and templates): `ARTICLES` in `src/text.ts`. Leave out any word that is also an English keyword (for example, Portuguese `no` is excluded).
3. **Words that end a noun phrase** (verbs, operators): `BOUNDARY` in `src/bal.ts`. Words that are allowed in a validated phrase without being vocabulary: `BAL_WORDS`.
4. **Demonstratives** (`this`, `cet`, `este`): the regex in `typeSlot` (`src/bal.ts`).
5. **Setter verbs**, so actions count as writes: the `writes` regex in `usesFromMatch` (`src/link.ts`).
6. **Elision** (`l'âge`): `unelide` in `src/bal.ts`. `phraseWords` in `src/text.ts` must split templates the same way.
7. Add a project in that language to `fixtures/i18n-workspace`, with tests like the French ones in `test/i18n.test.ts`: sections, slots, a write, validation.

### 5. New or changed tool

1. Add the query method to `KnowledgeBase` in `src/kb.ts`. It returns plain JSON and ends with `checked: this.checked(…)`. Cap list sizes and say how many items were left out.
2. Register it in `TOOLS` in `src/tools.ts`. The description is written for the model: say when to call it and what it returns. If the workflow changes, update `INSTRUCTIONS`.
3. Add a case to `test/mcp.test.ts` if the contract changed, and a behaviour test next to the area's other tests.
4. Document it in the tool table in `docs/REFERENCE.md`, and add any new answer field to "What the answers mean" there.
5. Add it to the skill (`skills/odm-change-analysis/SKILL.md`): to the branch table if it answers a new kind of question, and to "Reading results" if it returns a field the assistant must act on. `test/skill.test.ts` fails until the skill names the tool.

### 6. New quality gate

Add it to `runGates` in `src/check.ts`. A gate fails only on something that could make an answer wrong. Things worth seeing but not wrong go in the gate's `detail` with `pass: true` (as `selection` and `virtual` do). The fixtures must still pass every gate, and the HTML report picks the gate up automatically.

### 7. Performance

Run `npm run bench -- 5000`. The hot paths, in the order they have mattered: XML parsing (`jPath: false` matters), phrase matching (two-word anchors in `PhraseMatcher`), and re-linking (the per-artifact use cache in `link.ts`, keyed by the vocabulary signature). Speed is never bought by skipping a check: move an expensive check into `rulebase check` instead.

### Corpus

Public ODM workspaces used for regression testing. Clone them outside this repository, run `rulebase check` on each decision-service folder, and compare the error counts and typed-use counts before and after your change.

| Repository (GitHub)                                                                                                                                                                                     | Point Rulebase at                                                    | Exercises                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `DecisionsDev/odm-transformation-advisor`                                                                                                                                                               | the repo root                                                        | multi-project, large BOM, nested classes, parameter domains                  |
| `DecisionsDev/odm-javatime`                                                                                                                                                                             | `SampleRulesetStrict`, `SampleRulesetCompatible`                     | `.b2xa`, conversion operators, `#flags`, two decision services in one folder |
| `DecisionsDev/odm-libs-in-maven`                                                                                                                                                                        | `samples/executionserver/j2eerulesession/ruleproject/balsample rule` | classic project, `.ruleproject` parameters, fork/join                        |
| `DecisionsDev/odm-container-samples`                                                                                                                                                                    | `decisioncenter/dynamicdomain/projects`                              | body-level domains, virtual members                                          |
| `DecisionsDev/ODM-AI-toolkit-for-Bob`                                                                                                                                                                   | each folder under `sample_projects/`                                 | 8 small decision services (their `.voc` defects are real)                    |
| `ArnabMukherjee1991/LoanValidation`                                                                                                                                                                     | `Loan Validation Service`                                            | 5 projects, decision tables, definitions with arithmetic                     |
| `ncrowther/ODMGovernanceAsset`                                                                                                                                                                          | `GovernanceRules/rbrgDecisionService`                                | subflows 4 levels deep, subflow by `Uuid`                                    |
| `perucello/ODM_EducaCiencia_Template`                                                                                                                                                                   | `EducaCienciaFastCode/EducaCienciaFastCode`                          | Portuguese BAL, adjacent slots                                               |
| `oussemaBenAmor/IA-Hybride`                                                                                                                                                                             | `brms/BRMS`                                                          | French BAL, partitive slots                                                  |
| `jlv91/SYRACUSE`                                                                                                                                                                                        | `SYRACUSE-ODM/syracuse-rule-designer/syracuse-rules`                 | French BAL, a package named `output`                                         |
| `IBMStreams/streamsx.health`, `ibm-cloud-architecture/denim-compute`, `AthenaDecisionSystems/athena-owl-demos`, `pberlandier/odm-cicd`, `SaifRehman/ICP-Airways`, `inukshuk-io/ibm-odm-support-samples` | the decision-service project folders                                 | assorted styles and ODM versions                                             |

The baseline at the time of writing: 27 decision services, 336 rules, 1,675 of 1,678 term uses typed. Remaining errors are defects in those repositories.
