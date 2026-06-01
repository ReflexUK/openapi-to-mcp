#!/usr/bin/env node
/**
 * CLI entry point. Loads an OpenAPI spec and serves it as an MCP server over
 * stdio, the transport MCP clients (Claude Desktop, Codex, etc.) speak.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { extractDocument, loadSpec } from "./openapi.js";
import { createServer } from "./server.js";

interface CliArgs {
  spec?: string;
  baseUrl?: string;
  headers: Record<string, string>;
  help: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { headers: {}, help: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "--spec":
        args.spec = argv[++i];
        break;
      case "--base-url":
        args.baseUrl = argv[++i];
        break;
      case "--header": {
        const h = argv[++i] ?? "";
        const idx = h.indexOf(":");
        if (idx > 0) args.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
        break;
      }
      default:
        if (!a.startsWith("-") && !args.spec) args.spec = a;
    }
  }
  // Allow a bearer token via env without putting secrets on the command line.
  if (process.env.OPENAPI_MCP_TOKEN && !args.headers.Authorization) {
    args.headers.Authorization = `Bearer ${process.env.OPENAPI_MCP_TOKEN}`;
  }
  return args;
}

const HELP = `openapi-to-mcp — serve any OpenAPI 3.x spec as an MCP server

Usage:
  openapi-to-mcp <spec> [options]
  openapi-to-mcp --spec <path|url> [options]

Options:
  --base-url <url>     Override the base URL from the spec's servers list
  --header "K: V"      Add a header to every request (repeatable)
  --list               Print the discovered tools and exit (no server)
  -h, --help           Show this help

Environment:
  OPENAPI_MCP_TOKEN    If set, sent as "Authorization: Bearer <token>"

Examples:
  openapi-to-mcp ./openapi.yaml
  openapi-to-mcp https://api.example.com/openapi.json --header "X-Api-Key: abc"
  openapi-to-mcp petstore.json --list
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.spec) {
    process.stdout.write(HELP);
    process.exit(args.spec ? 0 : 1);
  }

  const raw = await loadSpec(args.spec);
  const doc = extractDocument(raw, { specUrl: args.spec });

  if (args.list) {
    process.stdout.write(
      `${doc.title} v${doc.version} — ${doc.operations.length} tools\n`,
    );
    for (const op of doc.operations) {
      process.stdout.write(`  ${op.toolName}  (${op.method} ${op.path})\n`);
    }
    return;
  }

  const server = createServer(doc, {
    baseUrl: args.baseUrl,
    headers: args.headers,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so we never corrupt the stdio JSON-RPC stream.
  process.stderr.write(
    `openapi-to-mcp: serving "${doc.title}" with ${doc.operations.length} tools\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`openapi-to-mcp: ${(err as Error).message}\n`);
  process.exit(1);
});
