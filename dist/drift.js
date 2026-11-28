export function drift(previous, current) {
    const before = new Map((previous?.summary.artifacts ?? []).map((item) => [item.id, item]));
    const after = new Map(current.summary.artifacts.map((item) => [item.id, item]));
    const pick = ({ id, name, type, path, }) => ({ id, name, type, path });
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
