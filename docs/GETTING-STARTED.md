# Getting started with Rulebase

This guide takes you from nothing to asking your AI assistant questions about your own ODM rules, in about 15 minutes. It assumes you know your way around Rule Designer, but not Rulebase.

**What you'll end up with:** your assistant (Claude Code or GitHub Copilot) can look up your workspace's real vocabulary, rules, decision tables and ruleflows, and propose changes grounded in them. Rulebase only reads. You still make every change in Rule Designer or Decision Center.

Contents:

1. [Before you start](#1-before-you-start)
2. [Install](#2-install)
3. [Try it on the sample](#3-try-it-on-the-sample)
4. [Point it at your workspace](#4-point-it-at-your-workspace)
5. [Connect your assistant](#5-connect-your-assistant)
6. [Add the skill](#6-add-the-skill)
7. [Ask your first questions](#7-ask-your-first-questions)
8. [Day to day](#8-day-to-day)
9. [Use it in CI](#9-use-it-in-ci)
10. [Troubleshooting](#10-troubleshooting)
11. [Reporting a problem](#11-reporting-a-problem)

---

## 1. Before you start

You need:

- **Node.js 22.13 or later.** Check with `node --version`. If it's older or missing, install the LTS from nodejs.org, or ask IT if installs are restricted.
- **Git, with access to your organization's Rulebase repository.** That's an SSH key or a signed-in GitHub credential. In the commands below, replace `<owner>/rulebase` (and `<rulebase-repo-url>`) with its location.
- **A Rule Designer workspace on disk**, synced from Decision Center: the folder holding your decision service's projects (each project folder has a `.ruleproject` file).
- **An assistant that supports MCP:** Claude Code, or VS Code with GitHub Copilot.

## 2. Install

```powershell
npm install -g github:<owner>/rulebase
rulebase --version
```

You should see a version number such as `0.2.0`.

If `github:` doesn't resolve, use the SSH form:

```powershell
npm install -g git+ssh://git@github.com/<owner>/rulebase.git
```

There's nothing to build and no background service. `rulebase` is a command you run, or that your assistant starts for you.

## 3. Try it on the sample

The repository includes IBM's Miniloan sample. Trying it first shows you what good output looks like:

```powershell
git clone <rulebase-repo-url>
cd rulebase
rulebase check fixtures/miniloan
```

You should see eight `PASS` lines:

```text
PASS Every file parses, or is reported: 11 files, no errors
PASS Every rule has a UUID and a path: 4 rules
PASS Every rule runs (selected by a task an operation runs, or an operation without ruleflow): all rules selected
PASS Every decision table has rows: 7 rows
PASS Vocabulary resolves to the BOM: 20 phrases, 0 members without a verbalization (allowed)
PASS Virtual members have B2X: 0 virtual members
PASS Term uses have a typed subject: 16/16 typed (100%); untyped uses are kept for every candidate owner
PASS Name search recall@5 ≥ 95%: 100% of 4 rules are in the top 5 for their own name
```

Now ask it something, the way your assistant will:

```powershell
rulebase query fixtures/miniloan find_terms '{"query":"income"}'
```

The answer lists `yearly income of <borrower>` and its BOM member `miniloan.Borrower.yearlyIncome`.

> **Windows PowerShell 5.1** removes the double quotes inside that argument. Use PowerShell 7 (`pwsh`), or escape them: `'{\"query\":\"income\"}'`. Your assistant never has this problem; it talks to Rulebase directly.

## 4. Point it at your workspace

Rulebase reads **one decision service** at a time. Point it at one of these:

- **The workspace folder**, if it holds one decision service and its projects. Rulebase finds the project marked as a decision service and follows the projects it references.
- **The decision-service project folder itself**, if the workspace holds several decision services. Its sibling folders are searched for the projects it references.

```powershell
rulebase index C:\workspaces\LoanDS
```

The summary tells you which decision service and projects it found, what it read, and any errors:

```text
LoanDS: 3 project(s), 412 files
  parsed 412, reused 0; scan 210 ms, parse 1800 ms, link 640 ms
  decisionOperation 2, ruleflow 3, package 18, actionRule 240, decisionTable 61, …
  cache C:\Users\you\AppData\Local\rulebase\LoanDS-1a2b3c4d5e6f.sqlite (8200 KB)
```

Then run the checks, and create the report:

```powershell
rulebase check  C:\workspaces\LoanDS
rulebase report C:\workspaces\LoanDS -o rulebase-report.html
```

Open `rulebase-report.html` in a browser. It shows what was found, every check, every file that couldn't be read, and what wasn't indexed. **Read the Errors section.** A file Rulebase couldn't read may hide a rule. Each error names the file and line; see [Troubleshooting](#10-troubleshooting) for what the common ones mean.

The first index reads everything. After that, only changed files are re-read, which usually takes a second or less.

## 5. Connect your assistant

The assistant starts Rulebase itself, as an MCP server, for as long as your session lasts. Point it at the same folder you used in step 4.

### Claude Code

Windows:

```powershell
claude mcp add rulebase -- cmd /c rulebase mcp C:\workspaces\LoanDS
```

macOS or Linux:

```bash
claude mcp add rulebase -- rulebase mcp ~/workspaces/LoanDS
```

Start a new Claude Code session and type `/mcp`. **rulebase** should show as connected, with 9 tools.

### VS Code with GitHub Copilot

Create `.vscode/mcp.json` in the folder you open in VS Code:

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

On macOS or Linux, use `"command": "rulebase"` and `"args": ["mcp", "/path/to/workspace"]`.

Open Copilot Chat in **Agent** mode, open the tools list, and check that the Rulebase tools are there.

### Several decision services

Add one server per decision service, each with its own name, for example `rulebase-loans` and `rulebase-claims`.

## 6. Add the skill

The MCP server gives the assistant the tools. The **`odm-change-analysis` skill** gives it the procedure: how to work a requirement end to end, how to read the results, and the proposal to hand back to you. Install it once.

**Claude Code** (from the cloned repository):

```powershell
# Windows
Copy-Item -Recurse skills\odm-change-analysis $HOME\.claude\skills\
```
```bash
# macOS / Linux
cp -r skills/odm-change-analysis ~/.claude/skills/
```

It then runs on its own when you ask about a rule change, or you can type `/odm-change-analysis`.

**GitHub Copilot:** copy the folder to `.github/skills/odm-change-analysis/` in the repository you work in. If your Copilot version doesn't pick it up, paste the skill's "Requirement" section into that repository's `.github/copilot-instructions.md` instead.

## 7. Ask your first questions

Talk to the assistant as you would to a colleague who knows the rule project. Good first questions:

| You want to know | Ask something like |
|---|---|
| What a requirement would change | *"Requirement: decline applicants whose debt-to-income is above 40%. What needs to change?"* |
| Whether a term exists | *"Is there anything in the vocabulary for the applicant's employment status?"* |
| What a rule does | *"Show me the 'repayment and score' table, rows 3 to 5."* |
| What a change touches | *"If I change the yearly income field, which rules are affected?"* |
| Whether a rule runs | *"Does the rule 'legacy check' actually run?"* |
| What changed | *"What changed since the last time you indexed?"* (after a sync) |

For a requirement, expect a **proposal** like this:

- **Vocabulary:** each business word, the real term it maps to, or a gap.
- **Changes:** rules, table rows or ruleflows to modify, with the exact edit. Where to add a new rule so that it actually runs. Rule text that has already been checked against your vocabulary.
- **Impact:** what else the change touches.
- **Open points:** what you need to decide or confirm.

Some answers mean something specific:

| If the answer says… | It means |
|---|---|
| **vocabulary gap** | The term doesn't exist in your BOM, or its words don't fit together (the reason is given). A BOM or vocabulary change has to come first. |
| **needs verbalization** | The field exists in the BOM but has no wording yet. Adding a vocabulary entry is enough; no BOM change. |
| **does not run** | No ruleflow task that an operation runs selects this rule. Changing it has no effect. |
| **possible** / *subject not typed* | A likely match that Rulebase couldn't confirm. Check it. |
| **unread files** | Some files couldn't be read and may hide a rule. Fix them (see the report). |
| **stale** | Your workspace couldn't be re-indexed after a change. The answer is from the previous index. |

**What it won't do:** edit your rules. You review the proposal and make the change in Rule Designer or Decision Center. That's deliberate.

## 8. Day to day

- **Syncing from Decision Center, or switching branch or release:** nothing to do. Rulebase notices the changed files and re-indexes them before its next answer. Ask the assistant *"what changed?"* to see the drift.
- **Business words your team uses** that aren't in the BOM ("DTI", "over-leveraged"): put them in `rulebase.glossary.yaml` in the workspace folder, commit it, and review changes like code:

  ```yaml
  - phrase: debt-to-income
    means: ["the yearly repayment of the loan", "the yearly income of the borrower"]
    note: DTI is yearly repayment / yearly income
  ```

  An entry that points at a term that no longer exists shows up as an error, so the glossary can't silently go out of date.
- **Overriding the defaults** (rarely needed): `rulebase.yaml` in the workspace folder can pick the decision service, exclude a stale project, or set the vocabulary locale. See the README's Configuration section.
- **Clearing the cache:** `rulebase clean C:\workspaces\LoanDS`. It's safe to do; the next index is a full one.

## 9. Use it in CI

`rulebase check` exits with code 1 if a check fails, and `rulebase report` writes a single HTML file you can publish as a build artifact:

```yaml
- run: npm install -g github:<owner>/rulebase
- run: rulebase check ./LoanDS
- run: rulebase report ./LoanDS -o rulebase-report.html
```

This catches problems such as a ruleflow that selects a package that no longer exists, vocabulary for a deleted BOM field, or a glossary entry gone stale, before they reach Decision Center.

## 10. Troubleshooting

| Message | What it means | What to do |
|---|---|---|
| `No Rule Designer projects (.ruleproject) found under …` | The folder doesn't contain a rule project. | Point at the workspace or project folder that has the `.ruleproject` files. |
| `The workspace has 2 decision services: A, B. Point rulebase at one of their folders …` | Several decision services share the folder. | Use the decision-service project folder, e.g. `…\workspace\A`. |
| `No project is marked as a decision service, and 2 projects are not referenced by any other …` | Classic rule projects, and it's not clear which one is the main one. | Point at the main project's folder. |
| `this is an Automation Decision Services (ADS) project …` / `… a Decision Server Insights rule agent …` | Another IBM product with the same folder layout. | These aren't supported; Rulebase reads ODM rule projects. |
| `'x.y.Z.field' is not a BOM class or member` (in a `.voc` file) | The vocabulary describes a field the BOM no longer has. | A real inconsistency in the project: fix the BOM or the vocabulary in Rule Designer. |
| `task 't' selects rule '…', which is not in the decision service` | The ruleflow points at a rule that was deleted or moved. | Fix the ruleflow in Rule Designer. |
| `task 't' selects rule 'x', which matches 2 rules in different packages` | The ruleflow names a rule that exists in two packages. | Rulebase keeps both as "possibly selected". Rename one, or check which is meant. |
| `could not read member …` / `could not read class header …` (in a `.bom` file) | BOM syntax Rulebase doesn't understand yet. | Please report it (section 11). |
| The assistant says it can't find the Rulebase tools | The MCP server isn't connected. | Claude Code: run `/mcp`. VS Code: check `.vscode/mcp.json` and the MCP output log. Check that `rulebase --version` works in a terminal. |
| Answers look out of date | The index couldn't be refreshed. Answers will say `stale`. | Run `rulebase index <workspace>` to see the error. |

Rulebase understands rules written in **English, French, Portuguese and Spanish**. Rules in other languages index with few or no term matches.

## 11. Reporting a problem

If Rulebase misreads your workspace, it can be fixed without your rules leaving your machine:

```powershell
rulebase anonymize C:\workspaces\LoanDS C:\temp\LoanDS-anon
```

This makes a copy where every business word, value and name is replaced, but the structure is kept. It then checks that the copy indexes exactly like the original, and prints a comparison. Review the copy, then share it (or just the failing file) along with the error message.

If the comparison prints a `DIFF` line, the anonymizer itself changed something. Report the `DIFF` lines; they contain no business data.

---

**Next:** the [README](../README.md) is the full reference (tools, files read, configuration, accuracy, performance), and [DESIGN.md](DESIGN.md) explains why Rulebase works the way it does.
