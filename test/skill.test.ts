import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TOOLS } from "../src/tools.ts";
import { ROOT } from "./helpers.ts";

const skill = fs.readFileSync(path.join(ROOT, "skills", "odm-change-analysis", "SKILL.md"), "utf8");

test("the skill names every MCP tool, and only real ones", () => {
  for (const tool of TOOLS) assert.ok(skill.includes(`\`${tool.name}\``), `skill does not mention ${tool.name}`);
  const named = [...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]);
  const known = new Set(TOOLS.map((tool) => tool.name));
  for (const name of named) assert.ok(known.has(name), `skill mentions unknown tool ${name}`);
});

test("the skill's result fields exist in the tool answers", () => {
  for (const field of ["needsVerbalization", "vocabularyGaps", "modify", "add", "checked.errors", "checked.stale", "moreRows", "resolved: false"]) {
    assert.ok(skill.includes(field), field);
  }
  const kb = fs.readFileSync(path.join(ROOT, "src", "kb.ts"), "utf8");
  for (const field of ["needsVerbalization", "vocabularyGaps", "moreRows", "stale", "total"]) assert.ok(kb.includes(field), `kb.ts no longer returns ${field}`);
});

test("the skill has valid frontmatter", () => {
  const front = /^---\nname: ([a-z-]+)\ndescription: (.+)\n---\n/.exec(skill);
  assert.ok(front, "frontmatter");
  assert.equal(front[1], "odm-change-analysis");
  assert.ok(front[2].length < 1024);
});
