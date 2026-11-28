import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { anonymizeWorkspace } from "../src/anonymize.ts";
import { ACME, MINILOAN, tempDir } from "./helpers.ts";

const BUSINESS =
  /credit|income|borrower|miniloan|repayment|debt|acme|salary|eligib|validation|approved|messages/i;

function allText(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ path: path.relative(dir, full), text: fs.readFileSync(full, "latin1") });
    }
  };
  walk(dir);
  return out;
}

for (const [name, source] of [
  ["miniloan", MINILOAN],
  ["acme", ACME],
] as const) {
  test(`anonymized ${name} indexes exactly like the original`, () => {
    const out = path.join(tempDir(), "anon");
    const result = anonymizeWorkspace(source, out);
    for (const row of result.comparison) assert.equal(row.anonymized, row.original, row.metric);
    assert.ok(result.ok);
  });

  test(`anonymized ${name} contains no business words outside UUIDs`, () => {
    const out = path.join(tempDir(), "anon");
    anonymizeWorkspace(source, out);
    for (const file of allText(out)) {
      assert.doesNotMatch(file.path, BUSINESS, file.path);
      const text = file.text
        .replace(/<uuid>[^<]*<\/uuid>/g, "")
        .replace(/^uuid\s*=.*$/gm, "")
        .replace(/property uuid "[^"]*"/g, "");
      const leak = BUSINESS.exec(text);
      assert.equal(
        leak,
        null,
        `${file.path}: ...${leak ? text.slice(Math.max(0, leak.index - 30), leak.index + 30) : ""}...`,
      );
    }
  });
}

test("refuses to write into a non-empty folder", () => {
  const out = tempDir();
  fs.writeFileSync(path.join(out, "keep.txt"), "x");
  assert.throws(() => anonymizeWorkspace(MINILOAN, out), /not empty/);
});
