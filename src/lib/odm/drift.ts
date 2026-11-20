import type { Artifact, DriftChange, DriftReport, VocabTerm } from "./types.ts";

export function artifactFingerprint(artifact: Artifact): string {
  return [
    artifact.type,
    artifact.name,
    artifact.package,
    artifact.bal ?? "",
    artifact.preconditions ?? "",
    (artifact.rows ?? []).map((row) => row.summary).join("|"),
    (artifact.tasks ?? []).map((task) => `${task.identifier}:${task.packages.join(",")}`).join("|"),
  ].join("\u0001");
}

export function driftReport(
  current: { commit?: string; artifacts: Artifact[]; terms: VocabTerm[] },
  previous: { commit?: string; artifacts: Artifact[]; terms: VocabTerm[] },
): DriftReport {
  const previousById = new Map(previous.artifacts.map((item) => [item.id, item]));
  const currentById = new Map(current.artifacts.map((item) => [item.id, item]));
  const added: DriftChange[] = [];
  const removed: DriftChange[] = [];
  const changed: DriftChange[] = [];
  for (const artifact of current.artifacts) {
    const before = previousById.get(artifact.id);
    if (!before) {
      added.push({ id: artifact.id, name: artifact.name, kind: "added", detail: artifact.filePath });
      continue;
    }
    if (artifactFingerprint(artifact) !== artifactFingerprint(before)) {
      changed.push({ id: artifact.id, name: artifact.name, kind: "changed", detail: artifact.filePath });
    }
  }
  for (const artifact of previous.artifacts) {
    if (!currentById.has(artifact.id)) {
      removed.push({ id: artifact.id, name: artifact.name, kind: "removed", detail: artifact.filePath });
    }
  }
  const currentTerms = new Set(current.terms.map((term) => term.example));
  const previousTerms = new Set(previous.terms.map((term) => term.example));
  return {
    fromCommit: previous.commit,
    toCommit: current.commit,
    added,
    removed,
    changed,
    vocabularyAdded: [...currentTerms].filter((term) => !previousTerms.has(term)),
    vocabularyRemoved: [...previousTerms].filter((term) => !currentTerms.has(term)),
  };
}
