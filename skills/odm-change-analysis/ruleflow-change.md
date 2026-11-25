# Ruleflow change

A change to how rules are sequenced: add, remove or move a task; change a transition's condition; change which packages or rules a task selects; change a task's algorithm or exit criteria. Or a requirement whose answer turns out to sit in a ruleflow (a `modify` candidate of type `ruleflow`).

The risk is a change that looks local but changes **which rules run, when, or in what order**. Work from the flow's actual paths, never from its picture or its names.

1. **Read the current flow.** Call `get_ruleflow_paths` with the ruleflow, and note for each task:
   - its `order`;
   - `reachedWhen`, the conditions on every path from the start;
   - its rules, and what runs before and after it;
   - the `notes` on its algorithm and exit criteria;
   - the flow's `runBy` or `calledFrom`: if neither exists, nothing runs the flow and the change has no effect.

   *Done when* you can state, for every task the change touches, when it runs and what it runs.

2. **State the change in the flow's own terms**: task ids, transition conditions written with validated vocabulary (check them with `validate_phrases`), and package names exactly as `get_ruleflow_paths` lists them.

3. **Work out the effect, task by task.** For each task the change touches, and each task after it:
   - **Rules that start or stop running.** Moving a package, deleting a task, or a selection change. Compare the rule lists before and after.
   - **Changed conditions.** A new or changed transition changes `reachedWhen` for its target and for everything after it. Write the old and new conditions side by side. A task that ends up with no path from the start never runs.
   - **Changed order.** For rules whose order changes, call `get_impact` on each one that sets a value. Any rule that reads that value and now runs *before* it sees the old value.
   - **Algorithm and exit criteria.** Moving rules into a task with exit criteria `Rule` means only the first rule that fires runs. Moving them between RetePlus and Fastpath or Sequential changes whether rules re-trigger each other.

   *Done when* every rule whose running, condition or order changes is listed with the reason.

4. **Check the operations.** `runBy` shows the operations affected. For a subflow, `calledFrom` shows the parent task and its `reachedWhen`, so the subflow's own conditions apply on top of the parent's.

5. **Write the proposal** in the shape in `SKILL.md`, with a **Ruleflow change** section in place of (or as well as) rule changes:

   ```markdown
   ### Ruleflow change: <ruleflow>
   | Order | Task | Reached when (now) | Reached when (proposed) | Rules |
   | 2 | validation | always | always | 6 |
   | 3 | fraud check (new) | – | 'the loan report' is valid data | package fraud (4) |

   **Effect**
   - Start running: <rules>
   - Stop running: <rules>
   - Different condition or order: <rule>: <before> → <after>
   ```

   The ruleflow is edited in Rule Designer's ruleflow editor, so describe the edit in its terms: add task, set the transition condition, change the task's rule selection.
