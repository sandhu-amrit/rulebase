import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOLS } from "../src/tools.ts";
import { VERSION } from "../src/version.ts";
import { MINILOAN, ROOT, tempDir } from "./helpers.ts";

test("the version matches package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});

test("stdio MCP server: lists the tools and answers a call", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", "--no-warnings", path.join(ROOT, "src", "cli.ts"), "mcp", MINILOAN, "--cache", path.join(tempDir(), "c.sqlite")],
    stderr: "pipe",
  });
  const client = new Client({ name: "rulebase-test", version: "0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), TOOLS.map((tool) => tool.name).sort());
    for (const tool of listed.tools) assert.equal(tool.annotations?.readOnlyHint, true);
    const result = (await client.callTool({ name: "validate_phrases", arguments: { phrases: ["reject the borrower"] } })) as { content: { text: string }[] };
    const body = JSON.parse(result.content[0].text) as { ok: boolean; checked: { decisionService: string } };
    assert.equal(body.ok, false);
    assert.equal(body.checked.decisionService, "Miniloan Service");
    const bad = (await client.callTool({ name: "get_artifact", arguments: { id: "does not exist" } })) as { isError?: boolean };
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
  }
});
