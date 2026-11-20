import { DatabaseSync } from "node:sqlite";
import type { KnowledgeSnapshot } from "./kb.ts";
import type { Artifact, Edge, FeedbackRecord, GlossaryEntry, QualityGate, VocabTerm } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  saved_at TEXT NOT NULL,
  label TEXT NOT NULL,
  commit_ref TEXT,
  project_name TEXT NOT NULL,
  decision_service TEXT,
  artifact_count INTEGER NOT NULL,
  term_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  snapshot_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  package TEXT NOT NULL,
  file_path TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, id)
);
CREATE TABLE IF NOT EXISTS terms (
  snapshot_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  example TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, id)
);
CREATE TABLE IF NOT EXISTS edges (
  snapshot_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (snapshot_id, id)
);
CREATE TABLE IF NOT EXISTS glossary (
  snapshot_id INTEGER NOT NULL,
  phrase TEXT NOT NULL,
  maps_to TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, phrase)
);
CREATE TABLE IF NOT EXISTS feedback (
  snapshot_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  requirement TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, id)
);
CREATE TABLE IF NOT EXISTS meta (
  snapshot_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, key)
);
CREATE INDEX IF NOT EXISTS artifacts_type ON artifacts(snapshot_id, type);
CREATE INDEX IF NOT EXISTS artifacts_package ON artifacts(snapshot_id, package);
CREATE INDEX IF NOT EXISTS edges_from ON edges(snapshot_id, from_id);
CREATE TABLE IF NOT EXISTS learned_glossary (
  project_name TEXT NOT NULL,
  phrase TEXT NOT NULL,
  maps_to TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'session',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_name, phrase)
);
CREATE TABLE IF NOT EXISTS feedback_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_name TEXT NOT NULL,
  requirement TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  unknown TEXT NOT NULL,
  mapped TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export interface StoredSnapshot {
  id: number;
  savedAt: string;
  label: string;
  commit?: string;
  projectName: string;
  decisionService?: string;
  artifactCount: number;
  termCount: number;
}

export class RuleStore {
  readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  save(snapshot: KnowledgeSnapshot, options: { label?: string; feedback?: FeedbackRecord[] } = {}): number {
    const savedAt = new Date().toISOString();
    const label = options.label ?? snapshot.commit ?? snapshot.projectName;
    this.db.exec("BEGIN");
    try {
      const inserted = this.db
        .prepare(
          `INSERT INTO snapshots (saved_at, label, commit_ref, project_name, decision_service, artifact_count, term_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          savedAt,
          label,
          snapshot.commit ?? null,
          snapshot.projectName,
          snapshot.decisionService ?? null,
          snapshot.artifacts.length,
          snapshot.terms.length,
        );
      const id = Number(inserted.lastInsertRowid);
      const artifactStmt = this.db.prepare(
        `INSERT INTO artifacts (snapshot_id, id, type, name, package, file_path, body) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const artifact of snapshot.artifacts) {
        artifactStmt.run(id, artifact.id, artifact.type, artifact.name, artifact.package, artifact.filePath, JSON.stringify(artifact));
      }
      const termStmt = this.db.prepare(
        `INSERT INTO terms (snapshot_id, id, kind, example, body) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const term of snapshot.terms) {
        termStmt.run(id, term.id, term.kind, term.example, JSON.stringify(term));
      }
      const edgeStmt = this.db.prepare(
        `INSERT INTO edges (snapshot_id, id, type, from_id, to_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const edge of snapshot.edges) {
        edgeStmt.run(id, edge.id, edge.type, edge.from, edge.to, edge.detail ?? null);
      }
      const glossaryStmt = this.db.prepare(
        `INSERT INTO glossary (snapshot_id, phrase, maps_to, source) VALUES (?, ?, ?, ?)`,
      );
      for (const entry of snapshot.glossary) {
        glossaryStmt.run(id, entry.phrase, JSON.stringify(entry.mapsTo), entry.source);
      }
      const feedbackStmt = this.db.prepare(
        `INSERT INTO feedback (snapshot_id, id, requirement, accepted, body) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const record of options.feedback ?? []) {
        feedbackStmt.run(id, record.id, record.requirement, record.accepted ? 1 : 0, JSON.stringify(record));
      }
      const metaStmt = this.db.prepare(`INSERT INTO meta (snapshot_id, key, value) VALUES (?, ?, ?)`);
      metaStmt.run(id, "warnings", JSON.stringify(snapshot.warnings));
      metaStmt.run(id, "gates", JSON.stringify(snapshot.gates));
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(): StoredSnapshot[] {
    return this.db
      .prepare(
        `SELECT id, saved_at, label, commit_ref, project_name, decision_service, artifact_count, term_count
         FROM snapshots ORDER BY id DESC`,
      )
      .all()
      .map(rowToSnapshot);
  }

  latestId(): number | null {
    const row = this.db.prepare(`SELECT id FROM snapshots ORDER BY id DESC LIMIT 1`).get() as { id: number } | undefined;
    return row?.id ?? null;
  }

  projects(): StoredSnapshot[] {
    return this.db
      .prepare(
        `SELECT id, saved_at, label, commit_ref, project_name, decision_service, artifact_count, term_count
         FROM snapshots
         WHERE id IN (SELECT MAX(id) FROM snapshots GROUP BY project_name)
         ORDER BY project_name`,
      )
      .all()
      .map(rowToSnapshot);
  }

  learnedGlossary(projectName: string): GlossaryEntry[] {
    return this.db
      .prepare(`SELECT phrase, maps_to, source FROM learned_glossary WHERE project_name = ? ORDER BY phrase`)
      .all(projectName)
      .map((row) => {
        const entry = row as { phrase: string; maps_to: string; source: GlossaryEntry["source"] };
        return { phrase: entry.phrase, mapsTo: JSON.parse(entry.maps_to) as string[], source: entry.source };
      });
  }

  remember(projectName: string, phrase: string, mapsTo: string[]): void {
    this.db
      .prepare(
        `INSERT INTO learned_glossary (project_name, phrase, maps_to, source, created_at)
         VALUES (?, ?, ?, 'session', ?)
         ON CONFLICT(project_name, phrase) DO UPDATE SET maps_to = excluded.maps_to, created_at = excluded.created_at`,
      )
      .run(projectName, phrase, JSON.stringify(mapsTo), new Date().toISOString());
  }

  logFeedback(projectName: string, record: FeedbackRecord): void {
    this.db
      .prepare(
        `INSERT INTO feedback_log (project_name, requirement, accepted, unknown, mapped, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectName,
        record.requirement,
        record.accepted ? 1 : 0,
        JSON.stringify(record.unknown),
        JSON.stringify(record.mapped),
        record.at,
      );
  }

  load(snapshotId?: number): KnowledgeSnapshot | null {
    const id = snapshotId ?? this.latestId();
    if (id == null) return null;
    const header = this.db
      .prepare(`SELECT commit_ref, project_name, decision_service FROM snapshots WHERE id = ?`)
      .get(id) as { commit_ref: string | null; project_name: string; decision_service: string | null } | undefined;
    if (!header) return null;
    const artifacts = this.db
      .prepare(`SELECT body FROM artifacts WHERE snapshot_id = ?`)
      .all(id)
      .map((row) => JSON.parse(String((row as { body: string }).body)) as Artifact);
    const terms = this.db
      .prepare(`SELECT body FROM terms WHERE snapshot_id = ?`)
      .all(id)
      .map((row) => JSON.parse(String((row as { body: string }).body)) as VocabTerm);
    const edges = this.db
      .prepare(`SELECT id, type, from_id, to_id, detail FROM edges WHERE snapshot_id = ?`)
      .all(id)
      .map((row) => {
        const edge = row as { id: string; type: Edge["type"]; from_id: string; to_id: string; detail: string | null };
        return { id: edge.id, type: edge.type, from: edge.from_id, to: edge.to_id, detail: edge.detail ?? undefined };
      });
    const glossary = this.db
      .prepare(`SELECT phrase, maps_to, source FROM glossary WHERE snapshot_id = ?`)
      .all(id)
      .map((row) => {
        const entry = row as { phrase: string; maps_to: string; source: GlossaryEntry["source"] };
        return { phrase: entry.phrase, mapsTo: JSON.parse(entry.maps_to) as string[], source: entry.source };
      });
    const warnings = readMeta<string[]>(this, id, "warnings") ?? [];
    const gates = readMeta<QualityGate[]>(this, id, "gates") ?? [];
    return {
      projectName: header.project_name,
      commit: header.commit_ref ?? undefined,
      decisionService: header.decision_service ?? undefined,
      artifacts,
      terms,
      edges,
      glossary,
      warnings,
      gates,
    };
  }
}

function readMeta<T>(store: RuleStore, snapshotId: number, key: string): T | null {
  const row = store.db.prepare(`SELECT value FROM meta WHERE snapshot_id = ? AND key = ?`).get(snapshotId, key) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

function rowToSnapshot(row: unknown): StoredSnapshot {
  const record = row as {
    id: number;
    saved_at: string;
    label: string;
    commit_ref: string | null;
    project_name: string;
    decision_service: string | null;
    artifact_count: number;
    term_count: number;
  };
  return {
    id: record.id,
    savedAt: record.saved_at,
    label: record.label,
    commit: record.commit_ref ?? undefined,
    projectName: record.project_name,
    decisionService: record.decision_service ?? undefined,
    artifactCount: record.artifact_count,
    termCount: record.term_count,
  };
}
