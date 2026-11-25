/**
 * stdio MCP server. The assistant host starts it; it lives as long as the
 * editor session. Logs go to stderr: stdout belongs to the protocol.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Session } from "./session.ts";
import { INSTRUCTIONS, TOOLS } from "./tools.ts";
import { VERSION } from "./version.ts";

export async function serveMcp(workspace: string, options: { cacheFile?: string } = {}): Promise<void> {
  const log = (message: string) => process.stderr.write(`[rulebase] ${message}\n`);
  const session = new Session(workspace, { watch: true, log, cacheFile: options.cacheFile });
  // Index before accepting calls, so a broken workspace fails at startup, visibly.
  session.rebuild();

  const server = new McpServer({ name: "rulebase", version: VERSION }, { instructions: INSTRUCTIONS });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = tool.run(session, args ?? {}) as Record<string, unknown>;
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 1) }],
            ...(result && typeof result === "object" && "error" in result ? { isError: true } : {}),
          };
        } catch (error) {
          log(`${tool.name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
          return {
            content: [{ type: "text" as const, text: `rulebase could not answer: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true,
          };
        }
      },
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = () => {
    session.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}
