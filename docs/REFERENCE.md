# Rulebase reference

The facts about using Rulebase: tools, answers, commands, configuration, what it reads, accuracy and performance. To get set up, read [GETTING-STARTED.md](GETTING-STARTED.md). For why it works this way, read [DESIGN.md](DESIGN.md).

## Tools

The MCP server offers these tools to the assistant. All are read-only.

| Tool | What it returns |
|---|---|
| `list_decision_services` | Projects, counts, locale, what was not indexed, every parse error |
| `list_terms` | Classes, or one class's members with types, virtual flags, what a virtual member is computed from, and phrases |
| `find_terms` | Fuzzy search over verbalizations, member names, documentation and the team glossary |
| `validate_phrases` | Unknown words (with suggestions), unknown variables, type errors |
| `find_change_candidates` | `modify`, `add`, `needsVerbalization`, `vocabularyGaps` (see below) |
| `get_artifact` | The rule, table (rows and cells), ruleflow or operation, with every vocabulary use |
| `get_impact` | What a change to a rule, package, ruleflow, member or phrase touches |
| `get_ruleflow_paths` | A ruleflow as it runs: tasks in order, what each selects, the conditions on every path that reaches it (including "otherwise" branches), before and after, algorithm and exit criteria explained, unreachable tasks, who runs it, and subflow call chains |
| `get_operation_signature` | Operation inputs and outputs with BOM types |
| `drift` | What changed since the previous index |

The order the assistant uses them in, and the proposal it hands back, are defined by the `odm-change-analysis` skill (`skills/odm-change-analysis/`).

## What the answers mean

| In an answer | It means |
|---|---|
| `modify` | Rules, table rows or ruleflows to change. A ruleflow appears when a transition condition or task filter uses the terms. |
| `add` | Where a new rule would have to go to run: the package, and the ruleflow task that selects it. |
| `needsVerbalization` | The member exists in the BOM but has no wording. A vocabulary entry is enough; no BOM change. |
| `vocabularyGaps` | The term doesn't exist, or its words don't fit together (`why` says which). A BOM or vocabulary change comes first. |
| `resolved: false`, "subject not typed", "possible" | A likely match Rulebase couldn't confirm. Kept so nothing is missed; check it. |
| "does not run" | No reachable ruleflow task that an operation runs selects the rule. Changing it has no effect. |
| "ambiguous" | Several artifacts share a name. Every match is listed; pick one by id. |
| `moreRows`, `total` larger than the list | The list is capped; ask for specific rows or narrow the target. |
| `checked` | On every answer: when the index was built, files and rules covered, the branch when known, and every file that couldn't be read. An unread file can hide a rule. |
| `checked.stale` | The workspace couldn't be re-indexed after a change. The answer comes from the last good index. |

**When does a rule run?** A ruleflow task selects it (by package, `package.name` or UUID). Some path from the ruleflow's start reaches that task. A decision operation runs the ruleflow, directly or as a subflow, through calling tasks that are themselves reachable, at any depth. Alternatively, an operation without a ruleflow runs every rule. The `runs` line names the conditions on every path to the task and, for a subflow, the chain of calling tasks with their conditions.

## Command line

```text
rulebase mcp <workspace>                 serve the tools to an assistant (the assistant starts this)
rulebase index <workspace> [--full]      index (incrementally; --full re-reads everything) and summarize
rulebase check <workspace> [--json]      every quality gate; exit 1 on failure
rulebase report <workspace> [-o file]    static HTML report: gates, errors, drift
rulebase drift <workspace>               what changed since the previous index
rulebase query <workspace> <tool> [json] call one tool and print its JSON answer
rulebase anonymize <workspace> <out>     copy with business content replaced, verified
rulebase clean [<workspace> | --all]     delete the cache
```

`<workspace>` is the Rule Designer workspace folder. When it holds several decision services, use the decision-service project folder: its sibling folders are searched for the projects it references.

## Configuration

Most workspaces need none. `rulebase.yaml` in the workspace folder overrides the defaults:

```yaml
decisionService: LoanDS   # when the workspace has more than one
exclude: [OldDS]          # projects to leave out
locale: en_US             # vocabulary locale (default: the one most rules use)
glossary: rulebase.glossary.yaml
```

`rulebase.glossary.yaml` records the business words the team has agreed on. Commit it and review changes in pull requests:

```yaml
- phrase: debt-to-income
  means: ["the yearly repayment of the loan", "the yearly income of the borrower"]
  note: DTI is yearly repayment / yearly income
- phrase: salary
  means: ["com.acme.loan.Borrower.yearlyIncome"]
```

An entry that points at a term which no longer exists is reported as an error.

**Cache:** an SQLite file outside the workspace, at `%LOCALAPPDATA%\rulebase\` on Windows and `~/.cache/rulebase/` elsewhere. Override it with `RULEBASE_CACHE_DIR` or `--cache`. Deleting it only costs one full reindex.

## What is read

| File | What Rulebase takes from it |
|---|---|
| `.ruleproject`, `.project` | Project name, decision-service flag, source and BOM folders, project references, and ruleset parameters (classic projects) |
| `.brl` | Action rules: definitions / if / then / else, status, dates, properties |
| `.dta` | Decision tables: columns, nested partitions, rows and cells, preconditions. The row count is cross-checked. |
| `.rfl` | Ruleflows: every task and node type (fork, join, branch), package and rule selection (by name or UUID), filters, transitions with conditions, subflows |
| `.dop`, `.var` | Decision operations and their signature, ruleset parameters |
| `.bom`, `.voc`, `.b2x`, `.b2xa` | Classes (fully qualified, nested, inheritance); members with types (attributes, methods and overloads, constructors, conversion operators, statics, domains); verbalizations in one locale; virtual classes and members with their B2X code |
| `.trl`, `.fct` | Technical rules and functions (IRL): class patterns, member access, setters |
| `.dtr` | Decision trees, indexed as text (node structure is not modelled yet) |

Templates, queries, `.metadata`, and projects the decision service does not reference are counted, not indexed. Anything that cannot be read is reported by path and line.

**Rule languages:** English, French, Portuguese and Spanish BAL (section keywords, articles, elision, partitive slots such as `{this,PARTITIVE_ARTICLE}`). Rules in other languages index with few or no term matches.

**Project styles:** decision services, and classic rule projects without the decision-service flag (the main project is the one no other project references). Automation Decision Services projects (`.dmo`, `.drl`) and Decision Server Insights rule agents (`agent.adsc`) share the folder layout but not the formats. They are reported as unsupported, not read.

## Accuracy

- **Parsing** is checked by the quality gates (`rulebase check`):
  - every file parses or is reported;
  - every rule has a UUID and a path;
  - every table's row count matches the file;
  - every selection and signature resolves;
  - every verbalization resolves to a BOM member;
  - searching a rule by its own name finds it in the top 5 at least 95% of the time.
- **Term use** in BAL is matched by token patterns with typed slots, not substrings. For example, `the credit score of 'the applicant'` resolves through the definitions variable to `Borrower.creditScore`. When a subject cannot be typed, every candidate owner is kept and marked unresolved, so impact never drops a rule.
- **Validation** rejects unknown words, unknown variables, members used on the wrong class, comparisons of the wrong type, and phrases that name only a class.
- **Real-world coverage:** 27 public decision services (IBM DecisionsDev samples and ODM projects on GitHub, listed in [EXTENDING.md](EXTENDING.md#corpus)). They contain 336 rules and 387 table rows, and 1,675 of 1,678 term uses (99.8%) are linked to the right BOM member. Their remaining errors are defects in those repositories.
- **Not yet tested on a large private workspace.** The biggest public decision service has 35 rules. Use `rulebase anonymize` to test a real workspace, or to share a failing case without its business content.

## Performance

Measured with `npm run bench -- 5000` (a synthetic workspace of 5,000 artifacts and 65k table rows) on an Intel i7-9750H Mac with Node 25:

| | Target | Measured |
|---|---|---|
| Full index | < 30 s | 5–6 s |
| Incremental (one file changed) | < 2 s | 0.7–0.9 s |
| Query p95 | < 50 ms | under 10 ms for every tool |
| Memory (fresh server process) | < 300 MB | about 300 MB RSS, 81 MB heap |

At 1,000 artifacts a fresh server uses about 170 MB. `rulebase check` at 5,000 artifacts takes about 9 s, mostly the recall gate.
