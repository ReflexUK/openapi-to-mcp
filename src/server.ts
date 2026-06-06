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
  /** Per-request timeout in milliseconds. Defaults to 30 000 (30 s). */
  timeoutMs?: number;
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
  const timeoutMs = options.timeoutMs ?? 30_000;
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(req.url, {
          method: req.method,
          headers: { ...options.headers, ...req.headers },
          body: req.body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      const status = `HTTP ${res.status} ${res.statusText}`;
      if (!res.ok) {
        const snippet = text.slice(0, 500);
        return {
          isError: true,
          content: [{ type: "text", text: `${status}\n${snippet}` }],
        };
      }
      return {
        isError: false,
        content: [{ type: "text", text: `${status}\n${text}` }],
      };
    } catch (err) {
      const msg = (err as Error).message;
      const isTimeout = msg.includes("abort") || msg.toLowerCase().includes("timeout");
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: isTimeout
              ? `Request timed out after ${timeoutMs}ms`
              : `Request failed: ${msg}`,
          },
        ],
      };
    }
  });

  return server;
}