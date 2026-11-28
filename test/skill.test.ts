import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TOOLS } from "../src/tools.ts";
import { ROOT } from "./helpers.ts";

// Normalize line endings: a Windows checkout may convert them.
const dir = path.join(ROOT, "skills", "odm-change-analysis");
const read = (file: string) => fs.readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n");
const main = read("SKILL.md");
const files = fs.readdirSync(dir).filter((file) => file.endsWith(".md"));
/** The whole skill: SKILL.md plus the branch files it points at. */
const skill = files.map(read).join("\n");

test("the skill names every MCP tool, and only real ones", () => {
  for (const tool of TOOLS)
    assert.ok(skill.includes(`\`${tool.name}\``), `skill does not mention ${tool.name}`);
  const named = [...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]);
  const known = new Set(TOOLS.map((tool) => tool.name));
  for (const name of named) assert.ok(known.has(name), `skill mentions unknown tool ${name}`);
});

test("the skill's result fields exist in the tool answers", () => {
  for (const field of [
    "needsVerbalization",
    "vocabularyGaps",
    "modify",
    "add",
    "checked.errors",
    "checked.stale",
    "moreRows",
    "resolved: false",
  ]) {
    assert.ok(skill.includes(field), field);
  }
  const kb = fs.readFileSync(path.join(ROOT, "src", "kb.ts"), "utf8");
  for (const field of ["needsVerbalization", "vocabularyGaps", "moreRows", "stale", "total"])
    assert.ok(kb.includes(field), `kb.ts no longer returns ${field}`);
});

test("every branch file the skill points at exists, and every file is pointed at", () => {
  const pointed = [...main.matchAll(/`([a-z-]+\.md)`/g)].map((match) => match[1]);
  for (const file of pointed) assert.ok(files.includes(file), `SKILL.md points at missing ${file}`);
  for (const file of files)
    if (file !== "SKILL.md") assert.ok(pointed.includes(file), `${file} is never pointed at`);
});

test("the skill has valid frontmatter", () => {
  const front = /^---\nname: ([a-z-]+)\ndescription: (.+)\n---\n/.exec(main);
  assert.ok(front, "frontmatter");
  assert.equal(front[1], "odm-change-analysis");
  assert.ok(front[2].length < 1024);
});
