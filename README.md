# Rulebase

Rulebase lets an AI assistant (Claude Code, GitHub Copilot) answer questions about your IBM ODM rules from the rules themselves. It reads a Rule Designer workspace and serves it to the assistant over MCP. When a requirement comes in, the assistant can find out:
- which vocabulary terms exist;
- which rules, decision-table rows or ruleflows would need to change;
- where a new rule would have to go so that it actually runs;
- what else the change would touch.

Rulebase is read-only: a person reviews the proposal and makes the change in Rule Designer or Decision Center.

## Start here

| I want to… | Read |
|---|---|
| Use Rulebase with my assistant on my rule project | [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) |
| Look up a tool, a command, a setting, or what an answer means | [docs/REFERENCE.md](docs/REFERENCE.md) |
| Understand why it works the way it does | [docs/DESIGN.md](docs/DESIGN.md) |
| Change or improve Rulebase (people and coding agents) | [AGENTS.md](AGENTS.md), then [docs/EXTENDING.md](docs/EXTENDING.md) |

## Which files are for which Copilot

There are two different situations. Each one uses its own files:

| Situation | Files | Where they go |
|---|---|---|
| **Using Rulebase:** Copilot (or Claude Code) in *your rule-project repository* answers questions about your rules | `.vscode/mcp.json` (connects the tools) and the skill in `skills/odm-change-analysis/` (the procedure) | In your rule-project repository, as described in [GETTING-STARTED.md](docs/GETTING-STARTED.md) steps 5 and 6 |
| **Improving Rulebase:** Copilot (or Claude Code) in *this repository* changes Rulebase's code | `AGENTS.md` and `.github/copilot-instructions.md` | Already here; both load automatically. Don't copy them into a rule project. |

## Install

Rulebase needs Node.js 22.13 or later, and installs from this repository with `npm install -g`. The steps, from install to your first question, are in [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

---|---|
| Use Rulebase with my assistant on my rule project | [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) |
| Look up a tool, a command, a setting, or what an answer means | [docs/REFERENCE.md](docs/REFERENCE.md) |
| Understand why it works the way it does | [docs/DESIGN.md](docs/DESIGN.md) |
| Change or improve Rulebase (people and coding agents) | [AGENTS.md](AGENTS.md), then [docs/EXTENDING.md](docs/EXTENDING.md) |

## Which files are for which Copilot

There are two different situations. Each one uses its own files:

| Situation | Files | Where they go |
|---|---|---|
| **Using Rulebase:** Copilot (or Claude Code) in *your rule-project repository* answers questions about your rules | `.vscode/mcp.json` (connects the tools) and the skill in `skills/odm-change-analysis/` (the procedure) | In your rule-project repository, as described in [GETTING-STARTED.md](docs/GETTING-STARTED.md) steps 5 and 6 |
| **Improving Rulebase:** Copilot (or Claude Code) in *this repository* changes Rulebase's code | `AGENTS.md` and `.github/copilot-instructions.md` | Already here; both load automatically. Don't copy them into a rule project. |

## Install

Requires Node.js 22.13 or later. Replace `<owner>/rulebase` with your organization's copy of this repository:

```powershell
npm install -g github:<owner>/rulebase
rulebase --version
```

Then follow [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

---

The Miniloan sample in `fixtures/miniloan` is from IBM's DecisionsDev `odm-on-cloud-getting-started` and is Apache-2.0. The license ships at `fixtures/miniloan/APACHE-LICENSE.txt`.
