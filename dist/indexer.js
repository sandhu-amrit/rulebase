/**
 * Turning a workspace into a KnowledgeBase, reusing cached per-file parses.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { KnowledgeBase } from "./kb.js";
import { link } from "./link.js";
import { extensionOf, parseArtifactFile } from "./parse/artifacts.js";
import { parseB2x } from "./parse/b2x.js";
import { parseBom } from "./parse/bom.js";
import { parseVoc } from "./parse/voc.js";
import { fileContent, scanWorkspace, sha } from "./workspace.js";
/** Bump when a parser changes output shape, so cached parses are not reused. */
export const PARSER_VERSION = "7";
export function cacheKey(file) {
    return sha(`${PARSER_VERSION}\u0000${file.project}\u0000${file.path}\u0000${file.packageName}\u0000${file.hash}`);
}
export function parseFile(file) {
    const content = fileContent(file);
    const provenance = { project: file.project, path: file.path };
    const ext = extensionOf(file.path);
    const base = { path: file.path, hash: file.hash, project: file.project };
    if (ext === ".bom") {
        const bomEntry = file.path.split("/").pop()?.replace(/\.bom$/i, "") ?? file.path;
        const bom = parseBom(content, provenance, bomEntry);
        return { ...base, kind: "bom", bom, warnings: bom.warnings };
    }
    if (ext === ".voc") {
        const voc = parseVoc(content, provenance);
        return { ...base, kind: "voc", voc, warnings: voc.warnings };
    }
    if (ext === ".b2x" || ext === ".b2xa") {
        const b2x = parseB2x(content, provenance);
        return { ...base, kind: "b2x", b2x, warnings: b2x.warnings };
    }
    const result = parseArtifactFile(content, provenance, file.role === "source" ? file.packageName : "");
    return { ...base, kind: "artifact", artifacts: result.artifacts, warnings: result.warnings };
}
export function loadGlossary(root, configured) {
    const file = path.resolve(root, configured ?? "rulebase.glossary.yaml");
    if (!fs.existsSync(file))
        return { entries: [], hash: "", warnings: [] };
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file).replace(/\\/g, "/");
    const warnings = [];
    let raw;
    try {
        raw = parseYaml(text);
    }
    catch (error) {
        return { entries: [], path: rel, hash: sha(text), warnings: [{ path: rel, severity: "error", message: `not valid YAML: ${error instanceof Error ? error.message : String(error)}` }] };
    }
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.terms) ? raw.terms : [];
    const entries = [];
    for (const item of list) {
        const entry = item;
        const phrase = typeof entry.phrase === "string" ? entry.phrase : undefined;
        const means = Array.isArray(entry.means) ? entry.means.filter((value) => typeof value === "string") : typeof entry.means === "string" ? [entry.means] : [];
        if (!phrase || !means.length) {
            warnings.push({ path: rel, severity: "error", message: `entry needs 'phrase' and 'means': ${JSON.stringify(item).slice(0, 80)}` });
            continue;
        }
        entries.push({ phrase, means, note: typeof entry.note === "string" ? entry.note : undefined });
    }
    return { entries, path: rel, hash: sha(text), warnings };
}
export function buildFromScan(scan, cache, previous, useCache) {
    const t0 = performance.now();
    const byKey = new Map();
    if (previous)
        for (const file of previous)
            byKey.set(file.hash + file.path, file);
    let reused = 0;
    const parsed = [];
    for (const file of scan.files) {
        const key = cacheKey(file);
        const hit = byKey.get(file.hash + file.path) ?? cache?.get(key);
        if (hit && hit.project === file.project) {
            parsed.push(hit);
            reused++;
            continue;
        }
        const result = parseFile(file);
        cache?.set(key, result);
        parsed.push(result);
    }
    const t1 = performance.now();
    const glossary = loadGlossary(scan.root, scan.config.glossary);
    // link() copies what it changes, so cached parses are shared, not cloned.
    const linked = link({
        decisionService: scan.decisionService,
        projects: scan.projects,
        files: parsed,
        locale: scan.config.locale,
        glossary: glossary.entries,
        useCache,
    });
    linked.warnings.unshift(...scan.warnings, ...glossary.warnings);
    const t2 = performance.now();
    const kb = new KnowledgeBase(linked, {
        workspace: scan.root,
        decisionService: scan.decisionService,
        projects: scan.projects,
        branch: scan.branch,
        indexedAt: new Date().toISOString(),
        files: scan.files.length,
        skipped: scan.skipped,
        glossaryPath: glossary.path,
        contentHash: sha(scan.files.map((file) => `${file.path}:${file.hash}`).join("\n") + scan.configHash + glossary.hash),
    });
    return {
        kb,
        scan,
        parsed,
        stats: {
            files: scan.files.length,
            parsed: scan.files.length - reused,
            reused,
            scanMs: 0,
            parseMs: Math.round(t1 - t0),
            linkMs: Math.round(t2 - t1),
        },
    };
}
export function buildWorkspace(root, cache, previous, previousStats, useCache) {
    const t0 = performance.now();
    const scan = scanWorkspace(root, { previous: previousStats });
    const scanMs = Math.round(performance.now() - t0);
    const result = buildFromScan(scan, cache, previous, useCache);
    result.stats.scanMs = scanMs;
    return result;
}
