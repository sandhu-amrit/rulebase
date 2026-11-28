import type { SnapshotSummary } from "./store.ts";

export interface DriftReport {
  from?: { indexedAt: string; branch?: string };
  to: { indexedAt: string; branch?: string };
  added: { id: string; name: string; type: string; path: string }[];
  removed: { id: string; name: string; type: string; path: string }[];
  changed: { id: string; name: string; type: string; path: string }[];
  vocabulary: { added: string[]; removed: string[] };
  members: { added: string[]; removed: string[] };
}

export function drift(
  previous: { summary: SnapshotSummary; createdAt: string } | null,
  current: { summary: SnapshotSummary; createdAt: string },
): DriftReport {
  const before = new Map((previous?.summary.artifacts ?? []).map((item) => [item.id, item]));
  const after = new Map(current.summary.artifacts.map((item) => [item.id, item]));
  const pick = ({
    id,
    name,
    type,
    path,
  }: {
    id: string;
    name: string;
    type: string;
    path: string;
  }) => ({ id, name, type, path });
  const added = [...after.values()].filter((item) => !before.has(item.id)).map(pick);
  const removed = [...before.values()].filter((item) => !after.has(item.id)).map(pick);
  const changed = [...after.values()]
    .filter((item) => before.has(item.id) && before.get(item.id)?.fingerprint !== item.fingerprint)
    .map(pick);
  const phrasesBefore = new Set((previous?.summary.phrases ?? []).map((item) => item.text));
  const phrasesAfter = new Set(current.summary.phrases.map((item) => item.text));
  const membersBefore = new Set(previous?.summary.members ?? []);
  const membersAfter = new Set(current.summary.members);
  return {
    ...(previous
      ? {
          from: {
            indexedAt: previous.createdAt,
            ...(previous.summary.branch ? { branch: previous.summary.branch } : {}),
          },
        }
      : {}),
    to: {
      indexedAt: current.createdAt,
      ...(current.summary.branch ? { branch: current.summary.branch } : {}),
    },
    added,
    removed,
    changed,
    vocabulary: {
      added: [...phrasesAfter].filter((item) => !phrasesBefore.has(item)).sort(),
      removed: [...phrasesBefore].filter((item) => !phrasesAfter.has(item)).sort(),
    },
    members: {
      added: [...membersAfter].filter((item) => !membersBefore.has(item)).sort(),
      removed: [...membersBefore].filter((item) => !membersAfter.has(item)).sort(),
    },
  };
}
