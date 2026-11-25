# Copilot instructions

*These are for working on Rulebase's code in this repository. To have Copilot use Rulebase on your rule project, follow `docs/GETTING-STARTED.md` steps 5 and 6.*

Before changing anything in this repository, read `AGENTS.md` at the repository root. It holds the invariants every change must keep, a map of which file owns which kind of change, and the checklist that defines "done". The recipes for each kind of improvement (a bug from a real workspace, new ODM syntax, a new file type, a new BAL language, a new tool, a new quality gate, performance) are in `docs/EXTENDING.md`.

The rule that decides most trade-offs: Rulebase's answers are used to change business rules, so a confident wrong answer is worse than a reported failure. When unsure, report (a warning, `resolved: false`, a vocabulary gap) rather than guess.

Before you finish, run `npm run typecheck`, `npm test` and `npm run build`, and commit `dist/` together with `src/`.
