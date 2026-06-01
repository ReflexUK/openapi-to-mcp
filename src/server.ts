/**
 * Build an MCP server from an OpenAPI document. Each operation is registered
 * as a tool; calling the tool performs the corresponding HTTP request.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { OpenApiDocument } from "./openapi.js";
import { buildInputSchema, buildRequest } from "./schema.js";

export interface ServerOptions {
  /** Override the base URL from the spec (e.g. point at a staging server). */
  baseUrl?: string;
  /** Extra headers sent on every request, e.g. an Authorization token. */
  headers?: Record<string, string>;
  /** Injected for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function createServer(doc: OpenApiDocument, options: ServerOptions = {}) {
  const baseUrl = options.baseUrl ?? doc.baseUrl;
  if (!baseUrl) {
    throw new Error(
      "No base URL found in spec `servers` and none provided. Pass --base-url.",
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const byName = new Map(doc.operations.map((op) => [op.toolName, op]));

  const server = new Server(
    { name: doc.title, version: doc.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: doc.operations.map((op) => ({
      name: op.toolName,
      description:
        op.summary ?? op.description ?? `${op.method} ${op.path}`,
      inputSchema: buildInputSchema(op),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const op = byName.get(request.params.name);
    if (!op) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      };
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const req = buildRequest(op, baseUrl, args);
      const res = await fetchImpl(req.url, {
        method: req.method,
        headers: { ...options.headers, ...req.headers },
        body: req.body,
      });
      const text = await res.text();
      const status = `HTTP ${res.status} ${res.statusText}`;
      return {
        isError: !res.ok,
        content: [{ type: "text", text: `${status}\n${text}` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Request failed: ${(err as Error).message}` },
        ],
      };
    }
  });

  return server;
}
