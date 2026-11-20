import { KnowledgeBase, type KnowledgeSnapshot } from "./kb.ts";
import { AGENT_TOOLS, runAgentTool } from "./agent.ts";
import type { RuleStore } from "./store.ts";
import type { FeedbackRecord } from "./types.ts";

export class RulebaseService {
  private readonly cache = new Map<string, KnowledgeBase>();
  readonly store: RuleStore;

  constructor(store: RuleStore) {
    this.store = store;
  }

  projects() {
    return this.store.projects();
  }

  open(projectName: string): KnowledgeBase {
    const cached = this.cache.get(projectName);
    if (cached) return cached;
    const header = this.store.projects().find((item) => item.projectName === projectName);
    if (!header) throw new Error(`Unknown project '${projectName}'`);
    const snapshot = this.store.load(header.id);
    if (!snapshot) throw new Error(`Snapshot ${header.id} is missing`);
    const learned = this.store.learnedGlossary(projectName);
    const glossary = mergeGlossary(snapshot.glossary, learned);
    const kb = new KnowledgeBase({ ...snapshot, glossary });
    this.cache.set(projectName, kb);
    return kb;
  }

  invalidate(projectName?: string) {
    if (projectName) this.cache.delete(projectName);
    else this.cache.clear();
  }

  call(projectName: string, tool: (typeof AGENT_TOOLS)[number], input: Record<string, string>) {
    const kb = this.open(projectName);
    if (tool === "record_feedback") {
      const record = kb.recordFeedback(input.requirement ?? "", input.accepted !== "false");
      this.persistFeedback(projectName, record);
      return record;
    }
    if (tool === "drift_check") {
      const previousId = Number(input.snapshotId);
      const previous = Number.isFinite(previousId) ? this.store.load(previousId) : null;
      if (!previous) return { error: "snapshotId is required and must exist" };
      return kb.driftAgainst(previous);
    }
    return runAgentTool(kb, tool, input);
  }

  persistFeedback(projectName: string, record: FeedbackRecord) {
    this.store.logFeedback(projectName, record);
    if (!record.accepted) return;
    for (const phrase of record.mapped) {
      this.store.remember(projectName, phrase, [phrase]);
    }
    const kb = this.open(projectName);
    for (const entry of kb.glossary.filter((item) => item.source === "session")) {
      this.store.remember(projectName, entry.phrase, entry.mapsTo);
    }
  }
}

function mergeGlossary(base: KnowledgeSnapshot["glossary"], learned: KnowledgeSnapshot["glossary"]) {
  const merged = [...base];
  for (const entry of learned) {
    if (!merged.some((item) => item.phrase.toLowerCase() === entry.phrase.toLowerCase())) merged.push(entry);
  }
  return merged;
}

export { AGENT_TOOLS };
