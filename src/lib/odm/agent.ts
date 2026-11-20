import type { KnowledgeBase } from "./kb.ts";

/** Stable tool names an external agent (Copilot, Claude, watsonx) calls. */
export const AGENT_TOOLS = [
  "search_rules",
  "get_artifact",
  "get_vocabulary",
  "get_ruleflow_impact",
  "get_decision_operation_signature",
  "validate_terms",
  "map_requirement",
  "record_feedback",
  "drift_check",
] as const;

export function runAgentTool(
  kb: KnowledgeBase,
  name: (typeof AGENT_TOOLS)[number],
  input: Record<string, string>,
): unknown {
  switch (name) {
    case "search_rules":
      return kb.search(input.query ?? "", {
        package: input.package,
        decisionService: input.decisionService,
      });
    case "get_artifact":
      return kb.getArtifact(input.id ?? input.name ?? "") ?? null;
    case "get_vocabulary":
      return kb.vocabulary(input.classOrPackage);
    case "get_ruleflow_impact":
      return kb.impact(input.seed ?? input.package ?? "");
    case "get_decision_operation_signature":
      return kb.signature(input.operation) ?? null;
    case "validate_terms":
      return kb.validateTerms((input.phrases ?? "").split(",").map((item) => item.trim()).filter(Boolean));
    case "map_requirement":
      return kb.ground(input.requirement ?? "");
    case "record_feedback":
      return kb.recordFeedback(input.requirement ?? "", input.accepted !== "false");
    case "drift_check":
      return { detail: "Pass two snapshots to KnowledgeBase.driftAgainst." };
    default:
      return { error: `Unknown tool ${name}` };
  }
}
