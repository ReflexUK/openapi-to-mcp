# openapi-to-mcp

[![CI](https://github.com/ReflexUK/openapi-to-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ReflexUK/openapi-to-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/openapi-to-mcp.svg)](https://www.npmjs.com/package/openapi-to-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Turn any OpenAPI 3.x spec into a [Model Context Protocol](https://modelcontextprotocol.io) server — every endpoint becomes a tool your LLM can call. No glue code.**

Point it at a spec (file or URL), and every operation shows up as an MCP tool in Claude Desktop, Codex, or any MCP client. Path/query/header params and JSON request bodies are mapped automatically.

```
  OpenAPI spec  ──►  openapi-to-mcp  ──►  MCP tools  ──►  Claude / Codex / any MCP client
```

## Why

Wiring an existing REST API into an LLM normally means hand-writing a tool wrapper per endpoint. Most APIs already publish an OpenAPI spec — this reads it and generates the tools at runtime, so a 200-endpoint API is one command, not 200 functions.

## Install

```bash
npm install -g openapi-to-mcp
# or run without installing:
npx openapi-to-mcp <spec>
```

## Quick start

Inspect the tools a spec produces (no server, no network):

```bash
openapi-to-mcp examples/petstore.json --list
```

```
Swagger Petstore v1.0.0 — 2 tools
  findPetsByStatus  (GET /pet/findByStatus)
  getPetById        (GET /pet/{petId})
```

Serve it over stdio (how MCP clients connect):

```bash
openapi-to-mcp https://petstore3.swagger.io/api/v3/openapi.json
```

## Use with Claude Desktop / Codex

Add to your MCP client config (Claude Desktop: `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "petstore": {
      "command": "npx",
      "args": ["-y", "openapi-to-mcp", "https://petstore3.swagger.io/api/v3/openapi.json"]
    }
  }
}
```

Restart the client and the API's endpoints appear as callable tools.

## Authentication

Most APIs need a token. Two ways, neither puts secrets in the spec:

```bash
# Bearer token via env (sent as "Authorization: Bearer <token>")
OPENAPI_MCP_TOKEN=sk-xxx openapi-to-mcp ./api.yaml

# Arbitrary headers (repeatable)
openapi-to-mcp ./api.yaml --header "X-Api-Key: abc123" --header "X-Org: acme"
```

## CLI reference

| Flag | Description |
|------|-------------|
| `<spec>` / `--spec <path\|url>` | OpenAPI 3.x spec, JSON or YAML, local or remote |
| `--base-url <url>` | Override the base URL from the spec's `servers` |
| `--header "K: V"` | Add a header to every request (repeatable) |
| `--list` | Print discovered tools and exit |
| `-h, --help` | Show help |

| Env | Description |
|-----|-------------|
| `OPENAPI_MCP_TOKEN` | Sent as `Authorization: Bearer <token>` |

## Programmatic use

```ts
import { loadSpec, extractDocument, createServer } from "openapi-to-mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const doc = extractDocument(await loadSpec("./api.yaml"), { specUrl: "./api.yaml" });
const server = createServer(doc, { headers: { "X-Api-Key": process.env.KEY! } });
await server.connect(new StdioServerTransport());
```

## How it works

1. **Load** the spec from a path or URL (JSON or YAML).
2. **Extract** every `path` × HTTP method into a normalized operation, deriving a stable tool name from `operationId` (or `method_path`).
3. **Map** path/query/header params and the JSON request body into a single JSON Schema per tool.
4. **Serve** over MCP stdio. A tool call rebuilds the HTTP request — substituting path params, appending query strings, setting headers — and returns the response.

## Limitations

- OpenAPI **3.x** only (not Swagger 2.0).
- `$ref`s are read as-is; deeply external `$ref` resolution is not performed.
- JSON request bodies only (`application/json`).
- Cookie parameters are ignored.

PRs welcome for any of these.

## Development

```bash
npm install
npm test       # node:test, no network required
npm run build  # tsc -> dist/
```

## License

[MIT](LICENSE) © ReflexUK
