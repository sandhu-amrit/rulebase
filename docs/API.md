# Production API

The production surface is an HTTP service over the SQLite index. The workbench is the reference client. Agents call the API.

## Run

Index a project first:

```bash
npm run reindex -- path/to/rule-designer-project rulebase.sqlite
```

Start the service. It refuses to start without a key unless you explicitly open it for a local demo.

```bash
export RULEBASE_API_KEY=$(openssl rand -hex 24)
export RULEBASE_DB=rulebase.sqlite
npm start
```

Local demo with no key:

```bash
RULEBASE_ALLOW_OPEN=1 npm start
```

Docker:

```bash
docker build -t rulebase .
docker run -p 8787:8787 -e RULEBASE_API_KEY=... -v "$PWD/rulebase.sqlite:/app/rulebase.sqlite" rulebase
```

## Endpoints

All routes except `/health` require `Authorization: Bearer $RULEBASE_API_KEY`.

| Method | Path | Body |
|---|---|---|
| GET | `/health` | — |
| GET | `/v1/projects` | — |
| GET | `/v1/tools` | — |
| POST | `/v1/projects/:project/tools/:tool` | tool fields |
| POST | `/mcp` | MCP JSON-RPC |

Tools: `search_rules`, `get_artifact`, `get_vocabulary`, `get_ruleflow_impact`, `get_decision_operation_signature`, `validate_terms`, `map_requirement`, `record_feedback`, `drift_check`.

`record_feedback` writes the decision to `feedback_log` and, when accepted, to `learned_glossary`. Learned phrases are merged into the index on the next open, so they survive a process restart.

`/mcp` speaks the MCP methods `initialize`, `tools/list`, and `tools/call`. Every tool call takes a `project` argument. That is the hook for a Copilot, Claude, or watsonx host: point it at this server, do not embed the rules in the prompt.

## Example

```bash
curl -s -H "Authorization: Bearer $RULEBASE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"requirement":"Reject loans when the borrower is over-leveraged"}' \
  http://localhost:8787/v1/projects/rule%20project/tools/map_requirement
```

## What this is, and is not

This is a production-shaped service: authenticated HTTP, a durable file store, persisted feedback, multi-project snapshots, and an MCP tool surface.

It is not a hosted vector database, not a DAIF ingest, and not a published Copilot extension. Those are adapters on top of these endpoints. The contract is the tools.
