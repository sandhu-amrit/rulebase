/**
 * The SQLite cache. Disposable: everything in it can be rebuilt from the
 * workspace, so deleting the file only costs one full reindex.
 *
 * - `parsed` holds one row per distinct (parser version, project, path, content hash).
 *   Unchanged files are never parsed twice.
 * - `snapshots` keeps only the current and previous index, for drift.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha } from "./workspace.js";
const SCHEMA_VERSION = 2;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS parsed (
  key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  decision_service TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot_files (
  snapshot_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  parse_key TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, path)
);
CREATE INDEX IF NOT EXISTS snapshot_files_key ON snapshot_files(parse_key);
`;
/** Default cache folder: %LOCALAPPDATA%\rulebase on Windows, $XDG_CACHE_HOME/rulebase or ~/.cache/rulebase elsewhere. */
export function cacheDir() {
    if (process.env.RULEBASE_CACHE_DIR)
        return process.env.RULEBASE_CACHE_DIR;
    if (process.platform === "win32") {
        return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "rulebase");
    }
    return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "rulebase");
}
export function cacheFileFor(workspace) {
    const resolved = path.resolve(workspace);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const name = path.basename(resolved).replace(/[^\w.-]+/g, "_") || "workspace";
    return path.join(cacheDir(), `${name}-${sha(key).slice(0, 12)}.sqlite`);
}
export class Store {
    file;
    db;
    getStmt;
    setStmt;
    constructor(file) {
        this.file = file;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
        const version = this.versionOf();
        if (version !== null && version !== SCHEMA_VERSION) {
            // A cache from another version is not migrated: it is rebuilt.
            this.db.exec("DROP TABLE IF EXISTS parsed; DROP TABLE IF EXISTS snapshots; DROP TABLE IF EXISTS snapshot_files; DROP TABLE IF EXISTS meta;");
        }
        this.db.exec(SCHEMA);
        this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
        this.getStmt = this.db.prepare("SELECT body FROM parsed WHERE key = ?");
        this.setStmt = this.db.prepare("INSERT OR REPLACE INTO parsed (key, path, body) VALUES (?, ?, ?)");
    }
    versionOf() {
        try {
            const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
            return row ? Number(row.value) : null;
        }
        catch {
            return null;
        }
    }
    /** New parses are buffered and written in one transaction by `record()` or `flush()`. */
    pending = new Map();
    get(key) {
        const buffered = this.pending.get(key);
        if (buffered)
            return buffered;
        const row = this.getStmt.get(key);
        return row ? JSON.parse(row.body) : undefined;
    }
    set(key, value) {
        this.pending.set(key, value);
    }
    flush() {
        if (!this.pending.size)
            return;
        this.transaction(() => this.writePending());
    }
    writePending() {
        for (const [key, value] of this.pending)
            this.setStmt.run(key, value.path, JSON.stringify(value));
        this.pending.clear();
    }
    /** Bulk writes inside one transaction. */
    transaction(fn) {
        this.db.exec("BEGIN");
        try {
            const out = fn();
            this.db.exec("COMMIT");
            return out;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    latest() {
        return this.snapshot("SELECT * FROM snapshots ORDER BY id DESC LIMIT 1");
    }
    previous() {
        return this.snapshot("SELECT * FROM snapshots ORDER BY id DESC LIMIT 1 OFFSET 1");
    }
    snapshot(sql) {
        const row = this.db.prepare(sql).get();
        if (!row)
            return null;
        return {
            id: row.id,
            createdAt: row.created_at,
            contentHash: row.content_hash,
            decisionService: row.decision_service,
            summary: JSON.parse(row.summary),
        };
    }
    /** Parsed files of the latest snapshot, for a warm start. */
    latestParsed() {
        const latest = this.latest();
        if (!latest)
            return [];
        const rows = this.db
            .prepare("SELECT p.body FROM snapshot_files f JOIN parsed p ON p.key = f.parse_key WHERE f.snapshot_id = ? ORDER BY f.path")
            .all(latest.id);
        return rows.map((row) => JSON.parse(row.body));
    }
    /**
     * Record an index. An identical index (same content hash as the latest) is not
     * stored again. Keeps the latest two snapshots and prunes unreferenced parses.
     */
    record(kb, files) {
        const latest = this.latest();
        if (latest && latest.contentHash === kb.meta.contentHash) {
            this.flush();
            return { stored: false, id: latest.id };
        }
        return this.transaction(() => {
            this.writePending();
            const inserted = this.db
                .prepare("INSERT INTO snapshots (created_at, content_hash, decision_service, summary) VALUES (?, ?, ?, ?)")
                .run(kb.meta.indexedAt, kb.meta.contentHash, kb.meta.decisionService, JSON.stringify(summarize(kb)));
            const id = Number(inserted.lastInsertRowid);
            const fileStmt = this.db.prepare("INSERT INTO snapshot_files (snapshot_id, path, hash, parse_key) VALUES (?, ?, ?, ?)");
            for (const file of files)
                fileStmt.run(id, file.path, file.hash, file.parseKey);
            const keep = this.db.prepare("SELECT id FROM snapshots ORDER BY id DESC LIMIT 2").all();
            const ids = keep.map((row) => row.id).join(",");
            this.db.exec(`DELETE FROM snapshot_files WHERE snapshot_id NOT IN (${ids})`);
            this.db.exec(`DELETE FROM snapshots WHERE id NOT IN (${ids})`);
            this.db.exec("DELETE FROM parsed WHERE key NOT IN (SELECT parse_key FROM snapshot_files)");
            return { stored: true, id };
        });
    }
    sizeBytes() {
        let total = 0;
        for (const suffix of ["", "-wal", "-shm"]) {
            try {
                total += fs.statSync(this.file + suffix).size;
            }
            catch {
                // not present
            }
        }
        return total;
    }
    close() {
        this.db.close();
    }
}
export function summarize(kb) {
    return {
        artifacts: [...kb.model.artifacts.values()]
            .filter((item) => item.type !== "package")
            .map((item) => ({ id: item.id, name: item.name, type: item.type, path: item.provenance.path, fingerprint: fingerprint(item) }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        phrases: [...kb.model.phrases.values()].map((phrase) => ({ id: phrase.id, text: phrase.text })).sort((a, b) => a.id.localeCompare(b.id)),
        members: [...kb.model.members.keys()].sort(),
        ...(kb.meta.branch ? { branch: kb.meta.branch } : {}),
    };
}
function fingerprint(artifact) {
    const { provenance, ...rest } = artifact;
    void provenance;
    return sha(JSON.stringify(rest)).slice(0, 16);
}
