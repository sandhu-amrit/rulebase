# Large requirement

A requirement with several clauses (a policy, a change request listing several rules, a regulation). Analyzing it in one pass dilutes the ranking: `find_change_candidates` ranks rules by how many of the given terms they use, so mixing unrelated clauses buries the rule that fits one clause exactly. Work **clause by clause, then merge**.

1. **Split into clauses.** One clause is one condition leading to one outcome ("decline if the credit score is below 600"). Number them, C1 to Cn, and list them back in the proposal so the person can check the split.
   *Done when* no clause has two outcomes, and no clause depends on words defined only in another clause.

2. **Ground the vocabulary once, for all clauses.** Do the Requirement steps 1 and 2 (in `SKILL.md`) across every clause, and build one shared vocabulary table. A term missing for one clause is missing for all.
   *Done when* every business word in every clause is mapped, or listed as a gap.

3. **Run each clause on its own.** For each clause, call `find_change_candidates` with **only that clause's terms** and the clause text as `requirement`. Then read each candidate with `get_artifact` (Requirement step 4).
   *Done when* every clause has its own result: change, add, already covered by an existing rule, or blocked by a gap.

4. **Merge by artifact.** Group the per-clause results by the rule, table or ruleflow they touch.
   - **One artifact, several clauses:** propose one combined edit, and name all the clauses it serves.
   - **Conflicts:** two clauses set the same threshold or value differently, or give opposite outcomes for overlapping conditions. List each conflict in Open points with both clauses. Pick neither.
   - **Already covered:** an existing rule already does what a clause asks. Say so, and propose no change.
   - **Order dependencies:** a clause reads a value another clause's rule sets. Check the order with `get_ruleflow_paths`: the rule that sets the value must run first (an earlier `order`, or the same RetePlus task).

5. **Check the reach once per changed artifact** with `get_impact`, not once per clause.

6. **Write the proposal** in the shape in `SKILL.md`, with a **Clauses** section first:

   ```markdown
   ### Clauses
   | # | Clause | Result |
   | C1 | decline if credit score < 600 | change 1 |
   | C2 | decline if yearly income < 25,000 | change 2 (new rule) |
   | C3 | flag if employment type is temporary | blocked: vocabulary gap |
   ```

   Number the Changes section so the Clauses table can refer to it. Conflicts and blocked clauses go in Open points.
