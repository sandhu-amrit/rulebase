import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspace } from "../src/indexer.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MINILOAN = path.join(ROOT, "fixtures", "miniloan");
export const ACME = path.join(ROOT, "fixtures", "acme-workspace");

const cache = new Map<string, ReturnType<typeof buildWorkspace>>();
/** Build once per test file; the KnowledgeBase is read-only so sharing is safe. */
export function built(root: string) {
  let result = cache.get(root);
  if (!result) {
    result = buildWorkspace(root);
    cache.set(root, result);
  }
  return result;
}

export function tempDir(prefix = "rulebase-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true });
}
