import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildKnowledgeBase } from "./kb.ts";
import { startServer } from "./server.ts";
import { RuleStore } from "./store.ts";
import type { SourceFile } from "./types.ts";

function loadSample(): SourceFile[] {
  const root = path.resolve("src/fixtures/miniloan");
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(brl|dta|rfl|dop|var|bom|voc|rulepackage|ruleproject)$/i.test(entry.name)) {
        files.push({ path: path.relative(root, full), content: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  return files;
}

describe("rulebase api", () => {
  it("serves projects and rejects an unknown term", async () => {
    const file = path.join(os.tmpdir(), `rulebase-api-${process.pid}.sqlite`);
    fs.rmSync(file, { force: true });
    const store = new RuleStore(file);
    const kb = buildKnowledgeBase(loadSample(), { commit: "test" });
    store.save(kb.snapshot(), { label: "miniloan" });
    store.close();

    const running = await startServer({ dbPath: file, port: 0, allowOpen: true });
    try {
      const health = await fetch(`http://127.0.0.1:${running.port}/health`).then((response) => response.json());
      assert.equal(health.ok, true);
      const listed = await fetch(`http://127.0.0.1:${running.port}/v1/projects`).then((response) => response.json());
      const project = listed.projects[0].projectName as string;
      const grounded = await fetch(
        `http://127.0.0.1:${running.port}/v1/projects/${encodeURIComponent(project)}/tools/map_requirement`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requirement: "Reject the loan when the vibe score is low" }),
        },
      ).then((response) => response.json());
      assert.equal(grounded.result.accepted, false);
      assert.ok(grounded.result.unknown.includes("vibe"));

      const mcp = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }).then((response) => response.json());
      assert.ok(mcp.result.tools.some((tool: { name: string }) => tool.name === "map_requirement"));
    } finally {
      await running.close();
      fs.rmSync(file, { force: true });
    }
  });

  it("refuses a request without a key", async () => {
    const file = path.join(os.tmpdir(), `rulebase-auth-${process.pid}.sqlite`);
    fs.rmSync(file, { force: true });
    const store = new RuleStore(file);
    store.close();
    const running = await startServer({ dbPath: file, port: 0, apiKey: "secret" });
    try {
      const open = await fetch(`http://127.0.0.1:${running.port}/v1/projects`);
      assert.equal(open.status, 401);
      const authed = await fetch(`http://127.0.0.1:${running.port}/v1/projects`, {
        headers: { authorization: "Bearer secret" },
      });
      assert.equal(authed.status, 200);
    } finally {
      await running.close();
      fs.rmSync(file, { force: true });
    }
  });
});
