import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AGENT_TOOLS } from "./agent.ts";
import { RulebaseService } from "./service.ts";
import { RuleStore } from "./store.ts";

const TOOL_SCHEMA: Record<(typeof AGENT_TOOLS)[number], { description: string; fields: string[] }> = {
  search_rules: { description: "Rank artifacts for a grounded query.", fields: ["query", "package", "decisionService"] },
  get_artifact: { description: "Full artifact by id or name.", fields: ["id", "name"] },
  get_vocabulary: { description: "Vocabulary terms, optionally filtered.", fields: ["classOrPackage"] },
  get_ruleflow_impact: { description: "Artifacts in scope of a package or rule.", fields: ["seed", "package"] },
  get_decision_operation_signature: { description: "Operation inputs and bound types.", fields: ["operation"] },
  validate_terms: { description: "Reject phrases that are not in the vocabulary.", fields: ["phrases"] },
  map_requirement: { description: "Ground a requirement or reject it.", fields: ["requirement"] },
  record_feedback: { description: "Persist an accepted or rejected proposal.", fields: ["requirement", "accepted"] },
  drift_check: { description: "Diff the current index against a stored snapshot.", fields: ["snapshotId"] },
};

export function startServer(options: { dbPath: string; port: number; apiKey?: string; allowOpen?: boolean }) {
  const store = new RuleStore(options.dbPath);
  const service = new RulebaseService(store);
  const server = createServer(async (request, response) => {
    try {
      await handle(service, options, request, response);
    } catch (error) {
      send(response, 500, { error: error instanceof Error ? error.message : "Internal error" });
    }
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(options.port, "0.0.0.0", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => {
              store.close();
              done();
            });
          }),
      });
    });
  });
}

async function handle(
  service: RulebaseService,
  options: { apiKey?: string; allowOpen?: boolean },
  request: IncomingMessage,
  response: ServerResponse,
) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/health") {
    send(response, 200, { ok: true, projects: service.projects().length });
    return;
  }
  if (!authorized(request, options)) {
    send(response, 401, { error: "Missing or invalid API key" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/projects") {
    send(response, 200, { projects: service.projects() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/tools") {
    send(response, 200, {
      tools: AGENT_TOOLS.map((name) => ({ name, ...TOOL_SCHEMA[name] })),
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/mcp") {
    const body = await readJson(request);
    send(response, 200, mcp(service, body));
    return;
  }
  const toolMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/tools\/([a-z_]+)$/);
  if (request.method === "POST" && toolMatch) {
    const project = decodeURIComponent(toolMatch[1]);
    const tool = toolMatch[2] as (typeof AGENT_TOOLS)[number];
    if (!AGENT_TOOLS.includes(tool)) {
      send(response, 404, { error: `Unknown tool ${tool}` });
      return;
    }
    const input = await readJson(request);
    send(response, 200, { project, tool, result: service.call(project, tool, input) });
    return;
  }
  send(response, 404, { error: "Not found" });
}

function mcp(service: RulebaseService, body: Record<string, unknown>) {
  const id = body.id ?? null;
  const method = String(body.method ?? "");
  if (method === "initialize") {
    return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "rulebase", version: "1.0.0" }, capabilities: { tools: {} } } };
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: AGENT_TOOLS.map((name) => ({
          name,
          description: TOOL_SCHEMA[name].description,
          inputSchema: {
            type: "object",
            properties: Object.fromEntries([...TOOL_SCHEMA[name].fields, "project"].map((field) => [field, { type: "string" }])),
            required: ["project"],
          },
        })),
      },
    };
  }
  if (method === "tools/call") {
    const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, string> };
    const name = params.name as (typeof AGENT_TOOLS)[number];
    const args = params.arguments ?? {};
    if (!AGENT_TOOLS.includes(name)) return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool ${name}` } };
    if (!args.project) return { jsonrpc: "2.0", id, error: { code: -32602, message: "project is required" } };
    const result = service.call(args.project, name, args);
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } };
}

function authorized(request: IncomingMessage, options: { apiKey?: string; allowOpen?: boolean }): boolean {
  if (options.allowOpen) return true;
  if (!options.apiKey) return false;
  return request.headers.authorization === `Bearer ${options.apiKey}`;
}

function readJson(request: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, string>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const isMain = process.argv[1]?.endsWith("server.ts");
if (isMain) {
  const dbPath = process.env.RULEBASE_DB ?? "rulebase.sqlite";
  const port = Number(process.env.PORT ?? 8787);
  const apiKey = process.env.RULEBASE_API_KEY;
  const allowOpen = process.env.RULEBASE_ALLOW_OPEN === "1";
  if (!apiKey && !allowOpen) {
    console.error("Set RULEBASE_API_KEY, or RULEBASE_ALLOW_OPEN=1 for a local demo.");
    process.exit(1);
  }
  const running = await startServer({ dbPath, port, apiKey, allowOpen });
  console.log(`rulebase listening on :${running.port} (${dbPath})`);
}
