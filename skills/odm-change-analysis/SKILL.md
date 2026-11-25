---
name: odm-change-analysis
description: Analyze changes to IBM ODM business rules with the Rulebase MCP tools. Use for a new or changed requirement, large or small (which rules, decision-table rows or ruleflows to modify, or where a new rule must go), a ruleflow change (adding, moving or removing tasks, transitions, order), the impact of changing a rule, package or BOM member, whether a term exists in the vocabulary, or what changed after a Decision Center sync.
---

# ODM change analysis

You are answering from **Rulebase**, a read-only index of one ODM Rule Designer workspace, exposed as MCP tools (`list_decision_services`, `list_terms`, `find_terms`, `validate_phrases`, `find_change_candidates`, `get_artifact`, `get_impact`, `get_ruleflow_paths`, `get_operation_signature`, `drift`). If those tools are not available, say that Rulebase is not connected and stop: answers about the rules come from the tools, not from memory or guesswork.

Every fact you report is **grounded**: it comes from a tool result, and you can name the artifact and path it came from. The deliverable is a **proposal** for a person to review and apply in Rule Designer or Decision Center. Rulebase never edits rule files, and neither do you.

## Pick the branch

| The person asks… | Do |
|---|---|
| for a new or changed requirement ("decline applicants whose…", "raise the threshold to…") | **Requirement**, below |
| for a requirement with several clauses (a policy, a list of changes) | Read `large-requirement.md` in this skill's folder and follow it |
| to change a ruleflow (add, move or remove a task, change a transition or a task's selection), or what runs in what order | Read `ruleflow-change.md` in this skill's folder and follow it |
| what changing a rule, package, ruleflow or BOM member affects | `get_impact`, then report as in step 5 |
| whether a term exists, or what something is called | `find_terms` with several wordings, then `list_terms` on the likely class |
| what changed after a sync or a branch switch | `drift` |
| how a rule or table works, or what its rows are | `get_artifact` (pass `rows` for specific table rows) |

Start every session with `list_decision_services`. Note the decision service, the locale, and every entry under `warnings.errors`.

## Requirement

1. **Ground the words.** For each business concept in the requirement, call `find_terms` with two or three wordings (synonyms, the BOM's likely field name). Browse with `list_terms` when the search is thin: it is complete, so a term missing there does not exist. Check the team glossary hits that `find_terms` returns.
   *Done when* every concept maps to a vocabulary phrase or member id, or is listed as missing.

2. **Write the logic in the vocabulary's own words**, as BAL-like phrases: conditions ("the credit score of the borrower is less than 620") and actions ("reject the loan"). Run `validate_phrases` on all of them.
   *Done when* every phrase comes back `ok`. Fix unknown words and type errors by rephrasing with real terms. A phrase that only validates after inventing a word is a gap, not a fix.

3. **Find the change.** Call `find_change_candidates` with the validated terms and the original requirement. Read every section of the result:
   - `modify`: each rule, table or ruleflow that uses the terms, with the reason. For tables, the matching columns and rows. For a ruleflow, the decision sits in a transition condition or task filter: follow `ruleflow-change.md` for that candidate.
   - `add`: the package where a new rule would run, with the ruleflow task that selects it.
   - `needsVerbalization`: the member exists in the BOM but has no wording. A vocabulary entry is enough; no BOM change.
   - `vocabularyGaps`: the term doesn't exist, or its words don't fit together (read `why`). A BOM or vocabulary change comes first.

4. **Look closer at each `modify` candidate.** Use `get_artifact` to read its current logic (with `rows` for the relevant table rows), and decide whether the requirement changes it: a threshold, a new condition, a new row, or nothing.
   *Done when* each candidate is marked change, add-row, or no change, with a one-line reason.

5. **Check the reach.** Call `get_impact` on each artifact you propose to change, and on each BOM member whose meaning changes. Note what else selects it, runs it, or reads what it sets.

6. **Write the proposal**, in the shape below.

## Reading results

- **`checked.errors` > 0**: some files could not be read. Name them in the proposal. A rule could be hiding there.
- **`checked.stale`**: the workspace could not be re-indexed, and the answer is from an older index. Say so first, and ask the person to fix the workspace or re-sync.
- **`resolved: false`** or "subject not typed": the match is plausible, not certain. Label it "possible" in the proposal.
- **A `runs` line saying "does not run"**, or a task whose `reachedWhen` is "never": the rule is never executed. A change there has no effect, and a new rule placed like it would not run either. Say so.
- **`reached when: …`** in a `runs` line: the rule runs only when those conditions hold on the way through the ruleflow. A requirement that must apply in every case may need the rule in an earlier task.
- **"ambiguous"** (several artifacts share a name): list them all and ask which one is meant. Picking one is a guess.
- **`moreRows` / `total` larger than shown**: the list is capped. Ask for specific rows, or narrow the target.

## Proposal shape

```markdown
## Proposal: <requirement in one line>

**Decision service:** <name> · **indexed:** <checked.indexedAt> · **unread files:** <none | list>

### Vocabulary
| Business words | Vocabulary term | Status |
| debt-to-income | the debt ratio of the borrower | exists |
| employment type | – | gap: BOM change needed (<why>) |

### Changes
1. **Modify** `<package>/<rule or table>` (<path>): <what changes, e.g. row 3, column C0: 30 → 40>. Runs: <runs line>.
2. **Add** a rule in package `<package>` (run by <task / operation>):
       if <validated condition phrases>
       then <validated action phrases>;

### Impact
- <artifact>: <reason from get_impact>

### Open points
- <gaps, "possible" matches, ambiguities, unread files, rules that don't run>
```

Every BAL line in the proposal has passed `validate_phrases`. Leave out a section that is empty, except **Open points**: if there are none, write "none".
