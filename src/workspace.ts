/**
 * Workspace discovery: find the rule projects in a Rule Designer workspace,
 * work out the decision service and the projects it references, and list the
 * files to index.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProjectInfo, Warning } from "./model.ts";
import { attr, children, decodeBytes, parseXml, rootElement, scalar, textOf } from "./parse/xml.ts";
import { portablePath } from "./text.ts";

/** Extensions Rulebase reads. Anything else inside a rule project's model folders is reported. */
export const INDEXED_EXTENSIONS = new Set([
  ".brl",
  ".dta",
  ".dtr",
  ".trl",
  ".fct",
  ".rfl",
  ".dop",
  ".var",
  ".rulepackage",
  ".bom",
  ".voc",
  ".b2x",
  ".b2xa",
]);

/** Known ODM files that are deliberately not indexed; counted in the footer, not warned per file. */
const KNOWN_SKIPPED = new Set([
  ".qry",
  ".tst",
  ".brmx",
  ".sc",
  ".dsc",
  ".ilrt",
  ".properties",
  ".xml",
  ".xsd",
  ".jar",
  ".class",
  ".java",
  ".prefs",
  ".json",
  ".txt",
  ".md",
]);

const SKIP_DIRS = new Set([
  ".metadata",
  ".git",
  ".svn",
  "node_modules",
  "output",
  "bin",
  "target",
  ".settings",
  "RemoteSystemsTempFiles",
]);
/** Skipped anywhere. The others (output, bin, target) are build folders only at a project's top level: inside rules/ they can be packages. */
const ALWAYS_SKIP = new Set([
  ".metadata",
  ".git",
  ".svn",
  "node_modules",
  ".settings",
  "RemoteSystemsTempFiles",
]);

export interface WorkspaceConfig {
  decisionService?: string;
  include?: string[];
  exclude?: string[];
  /** Vocabulary locale, e.g. `en_US`. Defaults to the locale most rules use. */
  locale?: string;
  glossary?: string;
}

export interface WorkspaceFile {
  /** Workspace-relative, `/` separated. */
  path: string;
  project: string;
  /** Package for rule files (dotted path under the source folder). */
  packageName: string;
  /** "source" | "bom" | "deployment" | other folder role. */
  role: "source" | "bom" | "other";
  /** Absent when the file was not re-read because its size and mtime are unchanged. Use `fileContent()`. */
  content?: string;
  hash: string;
  encoding: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
}

/** What a previous scan learned about a file, keyed by workspace-relative path. */
export interface FileStat {
  size: number;
  mtimeMs: number;
  hash: string;
  encoding: string;
  lossy: boolean;
}

export interface ScanOptions {
  /** Reuse hashes of files whose size and mtime are unchanged. */
  previous?: Map<string, FileStat>;
}

/** The decoded text of a scanned file, reading it now if the scan skipped it. */
export function fileContent(file: WorkspaceFile): string {
  if (file.content !== undefined) return file.content;
  return decodeBytes(fs.readFileSync(file.fullPath)).text;
}

export interface WorkspaceScan {
  root: string;
  config: WorkspaceConfig;
  configHash: string;
  decisionService: string;
  projects: ProjectInfo[];
  files: WorkspaceFile[];
  warnings: Warning[];
  /** Counts of files seen but not indexed, by extension. */
  skipped: Record<string, number>;
  branch?: string;
  /** For the next scan. */
  stats: Map<string, FileStat>;
}

export function loadConfig(root: string): {
  config: WorkspaceConfig;
  hash: string;
  warnings: Warning[];
} {
  const file = path.join(root, "rulebase.yaml");
  if (!fs.existsSync(file)) return { config: {}, hash: "", warnings: [] };
  const text = fs.readFileSync(file, "utf8");
  try {
    const config = (parseYaml(text) ?? {}) as WorkspaceConfig;
    return { config, hash: sha(text), warnings: [] };
  } catch (error) {
    return {
      config: {},
      hash: sha(text),
      warnings: [
        {
          path: "rulebase.yaml",
          severity: "error",
          message: `not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

export function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Find `.ruleproject` files, without descending into a project once found. */
function findProjectFolders(root: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === ".ruleproject")) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name))
        walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

function readProject(root: string, folder: string, warnings: Warning[]): ProjectInfo | null {
  const rel = portablePath(path.relative(root, folder)) || ".";
  const rpPath = path.join(folder, ".ruleproject");
  let node: Record<string, unknown>;
  try {
    const parsed = rootElement(parseXml(decodeBytes(fs.readFileSync(rpPath)).text));
    if (!parsed) throw new Error("no root element");
    node = parsed.node;
  } catch (error) {
    warnings.push({
      path: `${rel}/.ruleproject`,
      severity: "error",
      message: `cannot read rule project: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
  const references = new Set<string>();
  // Eclipse project references: <projectDescription><projects><project>Name</project></projects>
  const eclipse = path.join(folder, ".project");
  let eclipseName: string | undefined;
  if (fs.existsSync(eclipse)) {
    try {
      const parsed = rootElement(parseXml(decodeBytes(fs.readFileSync(eclipse)).text));
      eclipseName = scalar(parsed?.node, "name");
      for (const project of children(children(parsed?.node, "projects")[0], "project")) {
        const name = textOf(project).trim();
        if (name) references.add(name);
      }
    } catch (error) {
      warnings.push({
        path: `${rel}/.project`,
        severity: "error",
        message: `cannot read Eclipse project file: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const sourceFolders: string[] = [];
  const bomFolders: string[] = [];
  for (const folderNode of children(node, "modelFolders")) {
    const type = attr(folderNode, "xsi:type") ?? attr(folderNode, "type") ?? "";
    const name = scalar(folderNode, "name");
    if (!name) continue;
    if (/SourceFolder$/.test(type)) sourceFolders.push(name);
    else if (/BOMFolder$/.test(type)) bomFolders.push(name);
  }
  // BOM path entries may live in another project: platform:/<Project>/bom/x.bom
  for (const pathNode of children(node, "paths")) {
    for (const entry of children(pathNode, "entries")) {
      const url = attr(entry, "url") ?? "";
      const platform = /^platform:\/([^/]+)/.exec(url);
      if (platform) references.add(decodeURIComponent(platform[1]));
    }
  }
  const name = scalar(node, "name") ?? eclipseName ?? path.basename(folder);
  references.delete(name);
  const product = otherProduct(folder);
  if (product) {
    warnings.push({
      path: `${rel}/.ruleproject`,
      severity: "error",
      message: `this is ${product}, not an ODM rule project: its ${product.startsWith("a Decision Server") ? "event rules" : "decision models"} are not read`,
    });
  }
  const parameters = children(node, "parameters")
    .map((item) => ({
      name: attr(item, "name") ?? "",
      type: attr(item, "type") ?? "",
      verbalization: attr(item, "verbalization") ?? attr(item, "name") ?? "",
      ...(attr(item, "direction") ? { direction: attr(item, "direction") } : {}),
    }))
    .filter((item) => item.name);
  return {
    name,
    folder: rel,
    isDecisionService: attr(node, "isADecisionService") === "true",
    references: [...references].sort(),
    sourceFolders: sourceFolders.length ? sourceFolders : ["rules"],
    bomFolders: bomFolders.length ? bomFolders : ["bom"],
    uuid: scalar(node, "uuid"),
    ...(parameters.length ? { parameters } : {}),
  };
}

export function scanWorkspace(rootInput: string, options: ScanOptions = {}): WorkspaceScan {
  let root = path.resolve(rootInput);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Workspace folder not found: ${root}`);
  }
  // Pointing at a project folder means "this project is the decision service";
  // the workspace is the folder that holds it and its sibling projects.
  let chosenFolder: string | undefined;
  if (
    fs.existsSync(path.join(root, ".ruleproject")) &&
    !fs.existsSync(path.join(root, "rulebase.yaml"))
  ) {
    chosenFolder = path.basename(root);
    root = path.dirname(root);
  }
  const { config, hash: configHash, warnings } = loadConfig(root);
  // In project-folder mode only direct siblings can be referenced projects.
  const all = findProjectFolders(root, chosenFolder ? 1 : 4)
    .map((folder) => readProject(root, folder, warnings))
    .filter((item): item is ProjectInfo => Boolean(item));
  if (!all.length) throw new Error(`No Rule Designer projects (.ruleproject) found under ${root}`);

  const byName = new Map<string, ProjectInfo>();
  for (const project of all) {
    if (byName.has(project.name)) {
      warnings.push({
        path: `${project.folder}/.ruleproject`,
        severity: "error",
        message: `two projects are named '${project.name}'; using ${byName.get(project.name)?.folder}`,
      });
      continue;
    }
    byName.set(project.name, project);
  }

  const services = all.filter((project) => project.isDecisionService);
  let service: ProjectInfo | undefined;
  const chosen = chosenFolder ? all.find((project) => project.folder === chosenFolder) : undefined;
  if (chosen) {
    service = chosen;
    if (!chosen.isDecisionService) {
      warnings.push({
        path: `${chosen.folder}/.ruleproject`,
        severity: "info",
        message: "project is not marked as a decision service; indexing it as the main project",
      });
    }
  } else if (config.decisionService) {
    service = byName.get(config.decisionService);
    if (!service)
      throw new Error(
        `rulebase.yaml names decision service '${config.decisionService}', which is not in the workspace`,
      );
  } else if (services.length === 1) {
    service = services[0];
  } else if (services.length > 1) {
    throw new Error(
      `The workspace has ${services.length} decision services: ${services.map((item) => item.name).join(", ")}. ` +
        `Point rulebase at one of their folders (e.g. ${path.join(root, services[0].folder)}), or set 'decisionService:' in rulebase.yaml.`,
    );
  } else {
    // Classic rule projects have no decision-service flag. The main project is the one no other project references.
    const referenced = new Set(all.flatMap((project) => project.references));
    const tops = all.filter((project) => !referenced.has(project.name));
    if (tops.length === 1) {
      service = tops[0];
      warnings.push({
        path: `${service.folder}/.ruleproject`,
        severity: "info",
        message: "no project is marked as a decision service; indexing the only top-level project",
      });
    } else {
      throw new Error(
        `No project is marked as a decision service, and ${tops.length} projects are not referenced by any other (${tops.map((item) => item.name).join(", ")}). ` +
          `Point rulebase at the main project's folder, or set 'decisionService:' in rulebase.yaml.`,
      );
    }
  }

  // The decision service plus everything it references, transitively. References to
  // non-rule projects (the XOM Java project) are expected and skipped.
  const included = new Map<string, ProjectInfo>();
  const visit = (project: ProjectInfo) => {
    if (included.has(project.name)) return;
    included.set(project.name, project);
    for (const ref of project.references) {
      const target = byName.get(ref);
      if (target) visit(target);
    }
  };
  visit(service);
  for (const name of config.include ?? []) {
    const project = byName.get(name);
    if (project) visit(project);
    else
      warnings.push({
        path: "rulebase.yaml",
        severity: "error",
        message: `include names unknown project '${name}'`,
      });
  }
  for (const name of config.exclude ?? []) {
    if (name === service.name) {
      warnings.push({
        path: "rulebase.yaml",
        severity: "error",
        message: "the decision service itself cannot be excluded",
      });
      continue;
    }
    included.delete(name);
  }
  for (const project of all) {
    if (!included.has(project.name) && !chosenFolder) {
      warnings.push({
        path: `${project.folder}/.ruleproject`,
        severity: "info",
        message: `rule project '${project.name}' is not referenced by '${service.name}' and is not indexed`,
      });
    }
  }

  const projects = [...included.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files: WorkspaceFile[] = [];
  const skipped: Record<string, number> = {};
  const stats = new Map<string, FileStat>();
  for (const project of projects) {
    collectFiles(root, project, files, skipped, warnings, options.previous, stats);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    root,
    config,
    configHash,
    decisionService: service.name,
    projects,
    files,
    warnings,
    skipped,
    branch: detectBranch(root, projects),
    stats,
  };
}

function collectFiles(
  root: string,
  project: ProjectInfo,
  files: WorkspaceFile[],
  skipped: Record<string, number>,
  warnings: Warning[],
  previous: Map<string, FileStat> | undefined,
  stats: Map<string, FileStat>,
) {
  const projectDir = path.join(root, project.folder);
  const walk = (dir: string, role: WorkspaceFile["role"], sourceRoot: string | null) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push({
        path: portablePath(path.relative(root, dir)),
        severity: "error",
        message: `cannot list folder: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP.has(entry.name)) continue;
        walk(full, role, sourceRoot);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extensionOfName(entry.name);
      const rel = portablePath(path.relative(root, full));
      if (entry.name === ".ruleproject" || entry.name === ".project" || entry.name === ".classpath")
        continue;
      if (!INDEXED_EXTENSIONS.has(ext)) {
        const key = ext || entry.name;
        skipped[key] = (skipped[key] ?? 0) + 1;
        if (!KNOWN_SKIPPED.has(ext) && role !== "other") {
          warnings.push({
            path: rel,
            severity: "info",
            message: `file type '${key}' is not indexed`,
          });
        }
        continue;
      }
      const packageName = sourceRoot ? packageOf(path.relative(sourceRoot, dir)) : "";
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch (error) {
        warnings.push({
          path: rel,
          severity: "error",
          message: `cannot read file: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const known = previous?.get(rel);
      let info: FileStat;
      let content: string | undefined;
      if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) {
        info = known;
      } else {
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(full);
        } catch (error) {
          warnings.push({
            path: rel,
            severity: "error",
            message: `cannot read file: ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
        const decoded = decodeBytes(bytes);
        content = decoded.text;
        info = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          hash: sha(bytes),
          encoding: decoded.encoding,
          lossy: decoded.lossy,
        };
      }
      stats.set(rel, info);
      if (info.lossy) {
        warnings.push({
          path: rel,
          severity: "info",
          message: "not valid UTF-8 and no declared encoding; read as windows-1252",
        });
      }
      files.push({
        path: rel,
        project: project.name,
        packageName,
        role,
        ...(content !== undefined ? { content } : {}),
        hash: info.hash,
        encoding: info.encoding,
        fullPath: full,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  };
  const seen = new Set<string>();
  for (const folder of project.sourceFolders) {
    const dir = path.join(projectDir, folder);
    if (!fs.existsSync(dir)) {
      warnings.push({
        path: `${project.folder}/${folder}`,
        severity: "info",
        message: "source folder declared in .ruleproject does not exist",
      });
      continue;
    }
    seen.add(path.resolve(dir));
    walk(dir, "source", dir);
  }
  for (const folder of project.bomFolders) {
    const dir = path.join(projectDir, folder);
    if (!fs.existsSync(dir)) continue;
    seen.add(path.resolve(dir));
    walk(dir, "bom", null);
  }
  // Other top-level folders (deployment, resources...) hold operations and the like.
  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const dir = path.resolve(projectDir, entry.name);
    if (seen.has(dir)) continue;
    if (entry.name === "templates" || entry.name === "queries") {
      // Templates are not deployed and queries are not rules: count them, don't index them.
      countInto(dir, skipped, entry.name);
      continue;
    }
    walk(dir, "other", null);
  }
}

function countInto(dir: string, skipped: Record<string, number>, label: string) {
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else skipped[`${label}/`] = (skipped[`${label}/`] ?? 0) + 1;
    }
  };
  try {
    walk(dir);
  } catch {
    // unreadable folder: nothing to count
  }
}

function extensionOfName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function packageOf(relativeDir: string): string {
  return portablePath(relativeDir)
    .split("/")
    .filter((part) => part && part !== ".")
    .join(".");
}

/** Projects of other IBM decision products share the .ruleproject layout but not the rule formats. */
function otherProduct(folder: string): string | undefined {
  if (fs.existsSync(path.join(folder, "agent.adsc")))
    return "a Decision Server Insights rule agent";
  let found: string | undefined;
  const walk = (dir: string, depth: number) => {
    if (found || depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !ALWAYS_SKIP.has(entry.name))
        walk(path.join(dir, entry.name), depth + 1);
      else if (/\.(dmo|drl)$/.test(entry.name))
        found = "an Automation Decision Services (ADS) project";
    }
  };
  walk(path.join(folder, "rules"), 0);
  return found;
}

/** Best effort: Decision Center synchronization settings name the branch. Never guessed. */
function detectBranch(root: string, projects: ProjectInfo[]): string | undefined {
  for (const project of projects) {
    const settings = path.join(root, project.folder, ".settings");
    if (!fs.existsSync(settings)) continue;
    for (const file of fs.readdirSync(settings)) {
      if (!file.endsWith(".prefs")) continue;
      const text = fs.readFileSync(path.join(settings, file), "utf8");
      const match = /^[\w.]*branch[\w.]*\s*=\s*(.+)$/im.exec(text);
      if (match) return match[1].trim();
    }
  }
  return undefined;
}
