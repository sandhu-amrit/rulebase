# Rulebase

A local, read-only knowledge base over an IBM ODM Rule Designer workspace, served to AI assistants (Claude Code, GitHub Copilot, Cursor) over MCP.

When a requirement comes in, the assistant asks Rulebase:

- **What words are legal?** These come from the BOM and its verbalizations, including virtual members. Invented terms are rejected.
- **Which rules or decision-table rows probably need to change**, and why.
- **Does this need a new rule, and where would it have to go** to actually run (package, ruleflow task, operation)?
- **What else does the change touch?** This follows ruleflow selection, transition conditions, data flow and virtual members.

Rulebase never writes rules. A person reviews the proposal and makes the change in Rule Designer or Decision Center.

**New here? Start with [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)**, which goes from install to your first question in about 15 minutes. This README is the reference. Design and decisions are in [docs/DESIGN.md](docs/DESIGN.md).

## Install

Requires Node.js 22.13 or later.

```powershell
npm install -g github:sandhu-amrit/rulebase
rulebase --version
```

The repository is private, so git needs access to it (an SSH key or a GitHub credential). If `github:` does not resolve, use `npm install -g git+ssh://git@github.com/sandhu-amrit/rulebase.git`.

## Connect your assistant

Point Rulebase at **one Rule Designer workspace**, the folder that holds the decision service and its rule projects. When a folder holds several decision services, point it at the decision-service project folder itself: its sibling folders are searched for the projects it references.

**Claude Code** (Windows):

```powershell
claude mcp add rulebase -- cmd /c rulebase mcp C:\workspaces\LoanDS
```

On macOS or Linux: `claude mcp add rulebase -- rulebase mcp ~/workspaces/LoanDS`.

**VS Code / GitHub Copilot**, in `.vscode/mcp.json`:

```json
{
  "servers": {
    "rulebase": {
      "type": "stdio",
      "command": "cmd",
      "args": ["/c", "rulebase", "mcp", "C:\\workspaces\\LoanDS"]
    }
  }
}
```

On macOS or Linux, use `"command": "rulebase", "args": ["mcp", "/path/to/workspace"]`.

The assistant starts the server when the session starts and stops it when the session ends. Nothing runs in the background. The server watches the workspace and re-indexes changed files before it answers, so syncing from Decision Center or switching branch is picked up automatically.

## How the assistant uses it

1. **Map the words.** `find_terms` (several wordings) and `list_terms` (browse classes, then members). If a term is not in `list_terms`, it is not in the vocabulary.
2. **Check the phrasing.** `validate_phrases` rejects unknown words and type errors, such as a member used on the wrong class or text compared with a number.
3. **Find the change.** `find_change_candidates` returns:
   - **modify**: rules, table rows and ruleflows (when a transition condition or task filter uses the terms) to change, with reasons and whether each one runs;
   - **add**: where a new rule would have to go to run;
   - **needsVerbalization**: terms that exist in the BOM but have no wording yet (a vocabulary entry is enough);
   - **vocabularyGaps**: terms that don't exist or don't fit together, with the reason (a BOM change, or better phrasing).
4. **Look closer.** `get_artifact` (full rule, specific rows) and `get_impact`.

Every answer ends with `checked`: when the index was built, how many files and rules it covers, the branch when known, and any file that could not be read. An unread file can hide a rule, so the assistant should mention it. If the workspace could not be re-indexed after a change, `checked.stale` says so, and the answer comes from the last good index.

"Runs" means: a ruleflow task selects the rule (by package, `package.name` or UUID) and a decision operation runs that ruleflow, or an operation has no ruleflow and so runs every rule.

| Tool | What it returns |
|---|---|
| `list_decision_services` | Projects, counts, locale, what was not indexed, every parse error |
| `list_terms` | Classes, or one class's members with types, virtual flags, what a virtual member is computed from, phrases |
| `find_terms` | Fuzzy search over verbalizations, member names, documentation and the team glossary |
| `validate_phrases` | Unknown words (with suggestions), unknown variables, type errors |
| `find_change_candidates` | `modify`, `add`, `needsVerbalization`, `vocabularyGaps` |
| `get_artifact` | The rule, table (rows and cells), ruleflow or operation, with every vocabulary use |
| `get_impact` | What a change to a rule, package, ruleflow, member or phrase touches |
| `get_operation_signature` | Operation inputs and outputs with BOM types |
| `drift` | What changed since the previous index |

## The skill: a procedure for the assistant

The MCP server gives the assistant the tools. The **`odm-change-analysis` skill** ([`skills/odm-change-analysis/SKILL.md`](skills/odm-change-analysis/SKILL.md)) gives it the procedure:
- which tool to use for which question;
- how to work a requirement end to end, with a done criterion per step;
- how to read the special results (`needsVerbalization`, `checked.stale`, rules that don't run, ambiguous names);
- the shape of the proposal it hands to a person to review.

Without the skill, each session improvises the process.

**Claude Code**, for every project:

```powershell
# Windows (PowerShell)
Copy-Item -Recurse skills\odm-change-analysis $HOME\.claude\skills\
```
```bash
# macOS / Linux
cp -r skills/odm-change-analysis ~/.claude/skills/
```

Or, for one rule project only, copy it to that project's `.claude/skills/`. It then fires on its own when you ask about an ODM rule change, or you can invoke it with `/odm-change-analysis`.

**GitHub Copilot:** versions with Agent Skills support read skills from a repository's `.github/skills/` folder, so copy the folder to `.github/skills/odm-change-analysis/` in the repo you work in. Without that support, paste the skill's "Requirement" steps into that repo's `.github/copilot-instructions.md`.

## Command line

```text
rulebase index <workspace> [--full]      index (incrementally) and summarize
rulebase check <workspace> [--json]      every quality gate; exit 1 on failure
rulebase report <workspace> [-o file]    static HTML report: gates, errors, drift
rulebase drift <workspace>               what changed since the previous index
rulebase query <workspace> <tool> [json] call one tool, print its JSON
rulebase anonymize <workspace> <out>     copy with business content replaced, verified
rulebase clean [<workspace> | --all]     delete the cache
```

`rulebase check` and `rulebase report` are what CI runs on a rule project. The report is one HTML file with no scripts, safe to publish as a build artifact.

## Configuration (optional)

Most workspaces need none. Put `rulebase.yaml` in the workspace folder only to override something:

```yaml
decisionService: LoanDS   # when the workspace has more than one
exclude: [OldDS]          # projects to leave out
locale: en_US             # vocabulary locale (default: the one most rules use)
glossary: rulebase.glossary.yaml
```

`rulebase.glossary.yaml` records the business words the team has agreed on. Commit it and review changes in pull requests:

```yaml
- phrase: debt-to-income
  means: ["the debt ratio of the borrower"]
  note: computed in the BOM (B2X) from monthly debt and yearly income
- phrase: salary
  means: ["com.acme.loan.Borrower.yearlyIncome"]
```

An entry that points at a term which no longer exists is reported as an error.

The index cache is an SQLite file outside the workspace, at `%LOCALAPPDATA%\rulebase\` on Windows and `~/.cache/rulebase/` elsewhere. Override it with `RULEBASE_CACHE_DIR` or `--cache`. Deleting it only costs one full reindex.

## What is read

| File | What Rulebase takes from it |
|---|---|
| `.ruleproject`, `.project` | Project name, decision-service flag, source and BOM folders, project references, and ruleset parameters (classic projects) |
| `.brl` | Action rules: definitions / if / then / else, status, dates, properties |
| `.dta` | Decision tables: columns, nested partitions, rows and cells, preconditions; the row count is cross-checked |
| `.rfl` | Ruleflows: every task and node type (fork, join, branch), package and rule selection (by name or UUID), filters, transitions with conditions, subflows |
| `.dop`, `.var` | Decision operations and their signature, ruleset parameters |
| `.bom`, `.voc`, `.b2x`, `.b2xa` | Classes (fully qualified, nested, inheritance), members with types (attributes, methods and their overloads, constructors, conversion operators, statics, domains), verbalizations in one locale, virtual classes and members with their B2X code |
| `.trl`, `.fct` | Technical rules and functions (IRL): class patterns, member access, setters |
| `.dtr` | Decision trees: indexed as text (node structure is not modelled yet) |

Templates, queries, `.metadata` and projects the decision service does not reference are counted, not indexed. Anything that cannot be read is reported by path and line.

**Rule languages:** English, French, Portuguese and Spanish BAL (section keywords, articles, elision, partitive slots such as `{this,PARTITIVE_ARTICLE}`). Other languages are not supported yet; `docs/EXTENDING.md` says how to add one.

**Project styles:** decision services, and classic rule projects without the decision-service flag (the main project is the one no other project references). Projects from Automation Decision Services (`.dmo`, `.drl`) and Decision Server Insights rule agents (`agent.adsc`) share the layout but not the formats: they are reported as unsupported, not read.

## Accuracy

- **Parsing** is checked by the gates: every file parses or is reported, every rule has a UUID and path, every table's row count matches the file, every selection and signature resolves, every verbalization resolves to a BOM member, and recall@5 by rule name is at least 95%.
- **Term use** in BAL is matched by token patterns with typed slots, not substrings. `the credit score of 'the applicant'` resolves through the definitions variable to `Borrower.creditScore`. When a subject cannot be typed, every candidate owner is kept and marked unresolved, so impact never drops a rule.
- **Validation** rejects unknown words, unknown variables, members used on the wrong class, and comparisons of the wrong type. `test/accuracy.test.ts` holds the cases.
- **Tested on 27 public decision services** (IBM DecisionsDev samples and ODM projects from GitHub; listed in `docs/HOW-IT-WAS-BUILT.md`): 336 rules, 387 table rows, and 1,675 of 1,678 term uses (99.8%) linked to the right BOM member. Their remaining errors are defects in those repositories (vocabulary for members missing from their own BOM, ruleflows selecting deleted rules).
- **Not yet tested on a large private workspace.** The biggest public decision service has 35 rules. Run `rulebase anonymize` on a real workspace to test it, or to share a failing case without its business content.

## Performance

Measured with `npm run bench -- 5000` (a synthetic workspace of 5,000 artifacts, 65k table rows) on an Intel i7-9750H Mac with Node 25:

| | Target | Measured |
|---|---|---|
| Full index | < 30 s | 5–6 s |
| Incremental (one file changed) | < 2 s | 0.7–0.9 s |
| Query p95 | < 50 ms | under 10 ms for every tool |
| Memory (fresh server process) | < 300 MB | about 300 MB RSS, 81 MB heap |

At 1,000 artifacts a fresh server uses about 170 MB. `rulebase check` at 5,000 artifacts takes about 9 s, mostly the recall gate.

## Development

```bash
npm install
npm test            # unit, fixtures, accuracy, review regressions, cache, MCP over stdio, anonymizer
npm run typecheck
npm run bench -- 1000
npm run rulebase -- check fixtures/acme-workspace
```

```text
src/workspace.ts      discovery, project references, encodings
src/parse/            .bom .voc .b2x and XML artifact parsers (pure, per file)
src/link.ts           BOM + B2X + vocabulary + BAL matching -> one model
src/bal.ts            BAL tokenizer and typed phrase matcher
src/kb.ts             the queries behind the tools
src/session.ts        freshness: watcher, stat scan, incremental rebuild
src/store.ts          SQLite cache
src/tools.ts, mcp.ts  the MCP contract and stdio server
src/check.ts          quality gates;  src/report.ts  HTML report
src/anonymize.ts      structure-preserving anonymizer
fixtures/             Miniloan (Apache-2.0); acme (multi-project, virtual BOM); classic (no DS flag, .b2xa,
                      nested classes); i18n (French BAL, package named output, other IBM products)
bench/                workspace generator and benchmark
```

The Miniloan sample is from [DecisionsDev/odm-on-cloud-getting-started](https://github.com/DecisionsDev/odm-on-cloud-getting-started) and is Apache-2.0. The license ships at `fixtures/miniloan/APACHE-LICENSE.txt`.

## Improving Rulebase

Coding agents (Copilot, Claude Code) and people start at [`AGENTS.md`](AGENTS.md): the invariants every change keeps, which file owns which kind of change, and the checklist for done. The recipes are in [`docs/EXTENDING.md`](docs/EXTENDING.md). Copilot Chat loads `.github/copilot-instructions.md`, which points there.
