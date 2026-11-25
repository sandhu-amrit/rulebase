# Rulebase

A local, read-only knowledge base over an IBM ODM Rule Designer workspace, served to AI assistants (Claude Code, GitHub Copilot, Cursor) over MCP.

When a requirement comes in, the assistant asks Rulebase:

- **What words are legal?** These come from the BOM and its verbalizations, including virtual members. Invented terms are rejected.
- **Which rules or decision-table rows probably need to change**, and why.
- **Does this need a new rule, and where would it have to go** to actually run (package, ruleflow task, operation)?
- **What else does the change touch?** This follows ruleflow selection, transition conditions, data flow and virtual members.

Rulebase never writes rules. A person reviews the proposal and makes the change in Rule Designer or Decision Center.

Design and decisions: [docs/DESIGN.md](docs/DESIGN.md).

## Install

Requires Node.js 22.13 or later.

```powershell
npm install -g github:sandhu-amrit/rulebase
rulebase --version
```

The repository is private, so git needs access to it (an SSH key or a GitHub credential). If `github:` does not resolve, use `npm install -g git+ssh://git@github.com/sandhu-amrit/rulebase.git`.

## Connect your assistant

Point Rulebase at **one Rule Designer workspace**, the folder that holds the decision service and its rule projects.

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
   - **modify**: rules and table rows that use the terms, with reasons and how they run;
   - **add**: where a new rule would run;
   - **vocabulary gaps**: terms that need a BOM change first.
4. **Look closer.** `get_artifact` (full rule, specific rows) and `get_impact`.

Every answer ends with `checked`: when the index was built, how many files and rules it covers, the branch when known, and any file that could not be read. An unread file can hide a rule, so the assistant should mention it.

| Tool | What it returns |
|---|---|
| `list_decision_services` | Projects, counts, locale, what was not indexed, every parse error |
| `list_terms` | Classes, or one class's members with types, virtual flags, what a virtual member is computed from, phrases |
| `find_terms` | Fuzzy search over verbalizations, member names, documentation and the team glossary |
| `validate_phrases` | Unknown words (with suggestions), unknown variables, type errors |
| `find_change_candidates` | `modify`, `add`, `vocabularyGaps` |
| `get_artifact` | The rule, table (rows and cells), ruleflow or operation, with every vocabulary use |
| `get_impact` | What a change to a rule, package, ruleflow, member or phrase touches |
| `get_operation_signature` | Operation inputs and outputs with BOM types |
| `drift` | What changed since the previous index |

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
| `.ruleproject`, `.project` | Project name, decision-service flag, source and BOM folders, project references |
| `.brl` | Action rules: definitions / if / then / else, status, dates, properties |
| `.dta` | Decision tables: columns, nested partitions, rows and cells, preconditions; the row count is cross-checked |
| `.rfl` | Ruleflows: every task type, package and rule selection, filters, transitions with conditions, subflows |
| `.dop`, `.var` | Decision operations and their signature, ruleset parameters |
| `.bom`, `.voc`, `.b2x` | Classes (fully qualified, inheritance), members with types, statics and domains, verbalizations in one locale, virtual classes and members with their B2X code |
| `.trl`, `.fct` | Technical rules and functions (IRL): class patterns, member access, setters |
| `.dtr` | Decision trees: indexed as text (node structure is not modelled yet) |

Templates, queries, `.metadata` and projects the decision service does not reference are counted, not indexed. Anything that cannot be read is reported by path and line.

## Accuracy

- **Parsing** is checked by the gates: every file parses or is reported, every rule has a UUID and path, every table's row count matches the file, every selection and signature resolves, every verbalization resolves to a BOM member, and recall@5 by rule name is at least 95%.
- **Term use** in BAL is matched by token patterns with typed slots, not substrings. `the credit score of 'the applicant'` resolves through the definitions variable to `Borrower.creditScore`. When a subject cannot be typed, every candidate owner is kept and marked unresolved, so impact never drops a rule.
- **Validation** rejects unknown words, unknown variables, members used on the wrong class, and comparisons of the wrong type. `test/accuracy.test.ts` holds the cases.
- **Not yet measured on a real workspace.** The fixtures are Miniloan and a hand-built multi-project workspace with virtual BOM. Run `rulebase anonymize` on a real workspace to test it, or to share a failing case without its business content.

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
npm test            # unit, fixtures, accuracy, cache, MCP over stdio, anonymizer
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
fixtures/             Miniloan (Apache-2.0) and acme-workspace (multi-project, virtual BOM)
bench/                workspace generator and benchmark
```

The Miniloan sample is from [DecisionsDev/odm-on-cloud-getting-started](https://github.com/DecisionsDev/odm-on-cloud-getting-started) and is Apache-2.0. The license ships at `fixtures/miniloan/APACHE-LICENSE.txt`.
