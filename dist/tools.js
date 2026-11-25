/**
 * The tool contract. Names and input shapes are versioned with the package:
 * a breaking change here is a major version bump.
 */
import { z } from "zod";
export const TOOL_VERSION = "1";
export const INSTRUCTIONS = `Rulebase answers questions about one IBM ODM decision service, read from the developer's Rule Designer workspace. It is read-only and deterministic.

How to use it for a new requirement:
1. Map the requirement's business words onto vocabulary. Use find_terms with several wordings, and list_terms to browse classes and members. If a term is not in list_terms, it is not in the vocabulary.
2. Write the conditions and actions as BAL-like phrases using only those terms, and check them with validate_phrases. Fix every unknown word and type error before going on.
3. Call find_change_candidates with the validated terms (phrase texts or member ids) and the original requirement. It returns rules and table rows to modify, where a new rule would have to go to actually run, and vocabulary gaps (a BOM change is needed first).
4. Use get_artifact for the full rule or the specific table rows, and get_impact for what else a change touches.
5. Before proposing a ruleflow change, call get_ruleflow_paths: it gives the running order and the conditions on every path to each task.

Every answer ends with "checked": what was indexed, when, and any file that could not be read. Tell the user about errors there; an unread file can hide a rule.
Never invent vocabulary. If a term is missing, report it as a vocabulary gap.`;
export const TOOLS = [
    {
        name: "list_decision_services",
        title: "Decision service overview",
        description: "The decision service in this workspace: its rule projects, counts of rules, tables, ruleflows, BOM classes and phrases, the vocabulary locale, what was not indexed, and every parse error. Call this first.",
        input: {},
        run: (session) => session.kb().listDecisionServices(),
    },
    {
        name: "list_terms",
        title: "Browse vocabulary",
        description: "Browse the BOM. Without 'class': every class with its label, virtual flag and member count. With 'class' (fully qualified name, simple name or label): its members (including inherited ones) with type, virtual flag, what a virtual member is computed from, domain, documentation and verbalizations. Browsing is complete: a term that is not listed here does not exist.",
        input: {
            class: z.string().optional().describe("Class to open, e.g. com.acme.loan.Borrower or 'borrower'"),
            offset: z.number().int().min(0).optional(),
            limit: z.number().int().min(1).max(1000).optional(),
        },
        run: (session, args) => session.kb().listTerms(args),
    },
    {
        name: "find_terms",
        title: "Search vocabulary",
        description: "Search verbalizations, BOM member names, documentation and the team glossary. Tolerates plurals, tense and typos, but not synonyms: try several wordings ('income', 'salary', 'earnings'), and fall back to list_terms. Glossary hits show what the team agreed a business word means.",
        input: {
            query: z.string().min(1).describe("Words to look for"),
            limit: z.number().int().min(1).max(100).optional(),
        },
        run: (session, args) => session.kb().findTerms(args),
    },
    {
        name: "validate_phrases",
        title: "Validate BAL-like phrases",
        description: "Strictly check phrases such as \"the credit score of the borrower is less than 600\" or \"reject the loan\". Every content word must be vocabulary, a BAL keyword, a literal or a ruleset variable. Reports unknown words with suggestions, unknown variables, and type errors (a member used on the wrong class, text compared with a number, a value of the wrong type).",
        input: {
            phrases: z.array(z.string().min(1)).min(1).max(50),
        },
        run: (session, args) => session.kb().validatePhrases(args),
    },
    {
        name: "find_change_candidates",
        title: "Find rules to change or add",
        description: "Given vocabulary terms (phrase texts like 'the credit score of the borrower', member ids like 'com.acme.Borrower.creditScore', or glossary phrases) and optionally the requirement text: returns 'modify' (rules and decision-table rows that use the terms, with reasons and how they run), 'add' (packages where a new rule would run, with the ruleflow tasks that select them and similar rules), and 'vocabularyGaps' (terms that do not exist: a BOM change is needed). Includes rules that use virtual members computed from the terms.",
        input: {
            terms: z.array(z.string().min(1)).min(1).max(30),
            requirement: z.string().optional().describe("Original requirement text, used only to break ties"),
            limit: z.number().int().min(1).max(100).optional(),
        },
        run: (session, args) => session.kb().findChangeCandidates(args),
    },
    {
        name: "get_artifact",
        title: "Get a rule, table or ruleflow",
        description: "The full artifact by id, UUID, 'package.name' or unique name: BAL split into definitions/if/then/else, decision-table columns and rows, ruleflow tasks and transitions, operation signature. Includes every vocabulary use with its location, how the rule runs, and parse warnings for its file. Pass 'rows' to return only those decision-table rows.",
        input: {
            id: z.string().min(1),
            rows: z.array(z.number().int().min(1)).optional(),
        },
        run: (session, args) => session.kb().getArtifact(args),
    },
    {
        name: "get_impact",
        title: "What a change touches",
        description: "Impact of changing a rule, package, ruleflow, BOM member or class, or vocabulary phrase. For a rule: the ruleflow tasks that select it (with filters and transition conditions), the operations that run them, rules in the same package, and rules that read what it sets. For a term: every rule, table column and ruleflow condition that uses it, including through virtual members computed from it and through subclasses.",
        input: {
            target: z.string().min(1).describe("Artifact id/name, package name, member id, class fqn, or phrase text"),
        },
        run: (session, args) => session.kb().getImpact(args),
    },
    {
        name: "get_ruleflow_paths",
        title: "Ruleflow order and paths",
        description: "How a ruleflow runs: its tasks in running order; for each task, what it selects (packages, rules, how many rules), the conditions on every path from the start that reaches it (including 'otherwise' branches), what runs before and after it, its algorithm and exit criteria explained, and subflows. Also the operations or parent ruleflows that run it, and tasks that can never be reached. Use it before proposing any ruleflow change (adding, moving or removing a task, changing a transition or a selection), and to check what a change does to the order.",
        input: {
            ruleflow: z.string().optional().describe("Ruleflow name or id; omit to get every ruleflow"),
            task: z.string().optional().describe("Only this task"),
        },
        run: (session, args) => session.kb().getRuleflowPaths(args),
    },
    {
        name: "get_operation_signature",
        title: "Decision operation signature",
        description: "Inputs and outputs of the decision operations: parameter name, direction, BOM type, verbalization, and the ruleflow it runs.",
        input: {
            operation: z.string().optional(),
        },
        run: (session, args) => session.kb().getOperationSignature(args),
    },
    {
        name: "drift",
        title: "What changed since the last index",
        description: "Rules, tables and ruleflows added, removed or changed since the previous index, and vocabulary and BOM members added or removed. After syncing the workspace to another Decision Center branch or release, this is what differs.",
        input: {},
        run: (session) => ({ ...session.drift(), checked: session.kb().checked() }),
    },
];
