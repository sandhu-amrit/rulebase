/**
 * A workspace session: the current KnowledgeBase, kept fresh.
 *
 * Freshness, without a background service:
 *   - a recursive file watcher marks the index dirty on any change;
 *   - every 30 s (and before the first answer) a cheap stat scan catches
 *     changes the watcher missed, which happens on Windows during big syncs;
 *   - a dirty index is rebuilt before the next answer, re-parsing only files
 *     whose content hash changed.
 */
import fs from "node:fs";
import path from "node:path";
import { drift, type DriftReport } from "./drift.ts";
import { buildWorkspace, cacheKey, type BuildResult } from "./indexer.ts";
import type { KnowledgeBase } from "./kb.ts";
import type { ParsedFile } from "./link.ts";
import { cacheFileFor, Store, summarize } from "./store.ts";

const STAT_INTERVAL_MS = 30_000;
const IGNORED = /(^|[\\/])(\.metadata|\.git|output|bin|target|node_modules)([\\/]|$)/;

export interface SessionOptions {
  /** Path of the SQLite cache. Defaults to the per-user cache folder. */
  cacheFile?: string;
  /** Watch the workspace for changes (the MCP server does; one-shot CLI commands don't). */
  watch?: boolean;
  log?: (message: string) => void;
}

export class Session {
  readonly root: string;
  readonly store: Store;
  private result: BuildResult | null = null;
  private parsed: ParsedFile[] = [];
  private dirty = true;
  private lastStat = 0;
  private statSignature = "";
  private watcher: fs.FSWatcher | null = null;
  private readonly log: (message: string) => void;

  constructor(root: string, options: SessionOptions = {}) {
    this.root = path.resolve(root);
    this.store = new Store(options.cacheFile ?? cacheFileFor(this.root));
    this.log = options.log ?? (() => {});
    this.parsed = this.store.latestParsed();
    if (options.watch) this.startWatching();
  }

  private startWatching() {
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, file) => {
        if (file && IGNORED.test(String(file))) return;
        this.dirty = true;
      });
      this.watcher.on("error", () => {
        this.watcher = null;
      });
    } catch {
      this.log("file watching is unavailable here; falling back to periodic checks");
    }
  }

  /** A cheap signature of every file's size and mtime. */
  private statScan(): string {
    const parts: string[] = [];
    const walk = (dir: string, depth: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (IGNORED.test(full)) continue;
        if (entry.isDirectory()) {
          if (depth < 12) walk(full, depth + 1);
          continue;
        }
        try {
          const stat = fs.statSync(full);
          parts.push(`${full}:${stat.size}:${stat.mtimeMs}`);
        } catch {
          // vanished between list and stat: it will show up as a change next time
        }
      }
    };
    walk(this.root, 0);
    return parts.sort().join("\n");
  }

  /** Rebuild if anything changed. Returns the current KnowledgeBase. */
  kb(): KnowledgeBase {
    const now = Date.now();
    if (!this.dirty && this.result && now - this.lastStat > STAT_INTERVAL_MS) {
      this.lastStat = now;
      const signature = this.statScan();
      if (signature !== this.statSignature) this.dirty = true;
      this.statSignature = signature;
    }
    if (this.dirty || !this.result) this.rebuild();
    return (this.result as BuildResult).kb;
  }

  rebuild(): BuildResult {
    this.dirty = false;
    this.lastStat = Date.now();
    this.statSignature = this.statScan();
    const result = buildWorkspace(this.root, this.store, this.parsed);
    this.parsed = result.parsed;
    this.result = result;
    const files = result.scan.files.map((file) => ({ path: file.path, hash: file.hash, parseKey: cacheKey(file) }));
    this.store.record(result.kb, files);
    const { stats } = result;
    this.log(`indexed ${stats.files} files (${stats.parsed} parsed, ${stats.reused} reused) in ${stats.scanMs + stats.parseMs + stats.linkMs} ms`);
    return result;
  }

  get last(): BuildResult | null {
    return this.result;
  }

  drift(): DriftReport {
    const kb = this.kb();
    const latest = this.store.latest();
    const previous = latest && latest.contentHash === kb.meta.contentHash ? this.store.previous() : latest;
    return drift(previous ? { summary: previous.summary, createdAt: previous.createdAt } : null, { summary: summarize(kb), createdAt: kb.meta.indexedAt });
  }

  close(): void {
    this.watcher?.close();
    this.store.close();
  }
}
