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
import { drift } from "./drift.js";
import { buildWorkspace, cacheKey } from "./indexer.js";
import { cacheFileFor, Store, summarize } from "./store.js";
const STAT_INTERVAL_MS = 30_000;
/**
 * Paths (relative to the workspace) whose changes don't matter. Eclipse metadata and VCS folders anywhere;
 * output/bin/target only at a project's top level, because inside rules/ such a folder is a package.
 */
const IGNORED = /(^|[\\/])(\.metadata|\.git|\.svn|node_modules)([\\/]|$)/;
const BUILD_DIRS = new Set(["output", "bin", "target"]);
/** A build folder is output/bin/target directly inside a rule project (next to its .ruleproject). */
function isBuildDir(dir) {
    return (BUILD_DIRS.has(path.basename(dir)) &&
        fs.existsSync(path.join(path.dirname(dir), ".ruleproject")));
}
/** Whether a changed path (relative to the workspace) can affect the index. */
function ignoredChange(root, relative) {
    if (IGNORED.test(relative))
        return true;
    const parts = relative.split(/[\\/]/);
    for (let i = 0; i < parts.length - 1; i++) {
        if (BUILD_DIRS.has(parts[i]) && isBuildDir(path.join(root, ...parts.slice(0, i + 1))))
            return true;
    }
    return false;
}
export class Session {
    root;
    store;
    result = null;
    parsed = [];
    fileStats;
    useCache = new Map();
    dirty = true;
    lastStat = 0;
    statSignature = "";
    watcher = null;
    log;
    constructor(root, options = {}) {
        this.root = path.resolve(root);
        this.store = new Store(options.cacheFile ?? cacheFileFor(this.root));
        this.log = options.log ?? (() => { });
        this.parsed = this.store.latestParsed();
        if (options.watch)
            this.startWatching();
    }
    startWatching() {
        try {
            this.watcher = fs.watch(this.root, { recursive: true }, (_event, file) => {
                if (file && ignoredChange(this.root, String(file)))
                    return;
                this.dirty = true;
            });
            this.watcher.on("error", () => {
                this.watcher = null;
            });
        }
        catch {
            this.log("file watching is unavailable here; falling back to periodic checks");
        }
    }
    /** A cheap signature of every file's size and mtime. */
    statScan() {
        const parts = [];
        const walk = (dir, depth) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (IGNORED.test(path.relative(this.root, full)))
                    continue;
                if (entry.isDirectory() && isBuildDir(full))
                    continue;
                if (entry.isDirectory()) {
                    if (depth < 12)
                        walk(full, depth + 1);
                    continue;
                }
                try {
                    const stat = fs.statSync(full);
                    parts.push(`${full}:${stat.size}:${stat.mtimeMs}`);
                }
                catch {
                    // vanished between list and stat: it will show up as a change next time
                }
            }
        };
        walk(this.root, 0);
        return parts.sort().join("\n");
    }
    /** Rebuild if anything changed. Returns the current KnowledgeBase. */
    kb() {
        const now = Date.now();
        if (!this.dirty && this.result && now - this.lastStat > STAT_INTERVAL_MS) {
            this.lastStat = now;
            const signature = this.statScan();
            if (signature !== this.statSignature)
                this.dirty = true;
            this.statSignature = signature;
        }
        if (this.dirty || !this.result)
            this.rebuild();
        return this.result.kb;
    }
    /** `full` re-reads and re-hashes every file instead of trusting unchanged size and mtime. */
    rebuild(full = false) {
        this.lastStat = Date.now();
        this.statSignature = this.statScan();
        let result;
        try {
            result = full
                ? buildWorkspace(this.root, { get: () => undefined, set: (key, value) => this.store.set(key, value) }, undefined, undefined, undefined)
                : buildWorkspace(this.root, this.store, this.parsed, this.fileStats, this.useCache);
        }
        catch (error) {
            // Keep the last good index, but stay dirty (retry next call) and label every answer as stale.
            this.dirty = true;
            const reason = error instanceof Error ? error.message : String(error);
            this.log(`rebuild failed: ${reason}`);
            if (this.result) {
                this.result.kb.stale = `the workspace could not be re-indexed (${reason}); answers come from the index of ${this.result.kb.meta.indexedAt}`;
                return this.result;
            }
            throw error;
        }
        this.dirty = false;
        this.parsed = result.parsed;
        this.fileStats = result.scan.stats;
        // File contents are only needed for parsing; don't keep 5,000 file texts alive.
        for (const file of result.scan.files)
            delete file.content;
        this.result = result;
        const files = result.scan.files.map((file) => ({
            path: file.path,
            hash: file.hash,
            parseKey: cacheKey(file),
        }));
        this.store.record(result.kb, files);
        const { stats } = result;
        this.log(`indexed ${stats.files} files (${stats.parsed} parsed, ${stats.reused} reused) in ${stats.scanMs + stats.parseMs + stats.linkMs} ms`);
        return result;
    }
    get last() {
        return this.result;
    }
    driftCache = null;
    drift() {
        const kb = this.kb();
        if (this.driftCache?.hash === kb.meta.contentHash)
            return this.driftCache.report;
        const latest = this.store.latest();
        const previous = latest && latest.contentHash === kb.meta.contentHash ? this.store.previous() : latest;
        const report = drift(previous ? { summary: previous.summary, createdAt: previous.createdAt } : null, { summary: summarize(kb), createdAt: kb.meta.indexedAt });
        this.driftCache = { hash: kb.meta.contentHash, report };
        return report;
    }
    close() {
        this.watcher?.close();
        this.store.close();
    }
}
