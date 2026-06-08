/**
 * Minimal OpenAPI 3.x loader and operation extractor.
 *
 * Supports JSON and YAML specs loaded from a local path or an HTTP(S) URL.
 * Performs shallow $ref resolution for inline schema references so that
 * parameter and request body schemas are fully materialized before use.
 */
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

export interface OpenApiParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

export interface JsonSchema {
  type?: string;
  format?: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  default?: unknown;
  [key: string]: unknown;
}

export interface Operation {
  /** Stable, unique tool name derived from operationId or method+path. */
  toolName: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  parameters: OpenApiParameter[];
  requestBodySchema?: JsonSchema;
  requestBodyRequired: boolean;
}

export interface OpenApiDocument {
  title: string;
  version: string;
  /** Resolved base URL for requests, derived from `servers` or the spec URL. */
  baseUrl?: string;
  operations: Operation[];
}

const HTTP_METHODS = [
  "get", "put", "post", "delete", "patch", "options", "head",
];

/** Load and parse a spec from a path or URL. Detects JSON vs YAML by content. */
export async function loadSpec(source: string): Promise<unknown> {
  let raw: string;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`Failed to fetch spec: ${res.status} ${res.statusText}`);
    }
    raw = await res.text();
  } else {
    raw = await readFile(source, "utf8");
  }
  return parseSpecString(raw);
}

/** Parse a raw spec string, trying JSON first then YAML. */
export function parseSpecString(raw: string): unknown {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(raw);
  }
  return parseYaml(raw);
}

/** Convert a method + path into a deterministic, valid tool name. */
export function deriveToolName(method: string, path: string): string {
  const cleaned = path
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${method.toLowerCase()}_${cleaned || "root"}`.slice(0, 64);
}

/** Resolve the base URL from the spec's servers list, falling back to specUrl. */
export function resolveBaseUrl(
  spec: Record<string, any>,
  specUrl?: string,
): string | undefined {
  const servers = spec.servers as Array<{ url?: string }> | undefined;
  const serverUrl = servers?.[0]?.url;
  if (serverUrl) {
    if (/^https?:\/\//i.test(serverUrl)) return stripTrailingSlash(serverUrl);
    if (specUrl && /^https?:\/\//i.test(specUrl)) {
      return stripTrailingSlash(new URL(serverUrl, specUrl).toString());
    }
  }
  if (specUrl && /^https?:\/\//i.test(specUrl)) {
    return stripTrailingSlash(new URL(specUrl).origin);
  }
  return undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Resolve a JSON pointer ($ref) of the form "#/components/schemas/Foo" against
 * the root spec document. Returns the referenced value, or the original object
 * if the ref cannot be resolved (so callers degrade gracefully).
 */
export function resolveRef(ref: string, root: Record<string, any>): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: any = root;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Recursively inline $ref pointers within a schema using the spec root.
 * Guards against circular refs with a depth limit.
 */
export function inlineRefs(
  schema: unknown,
  root: Record<string, any>,
  depth = 0,
): unknown {
  if (depth > 8 || schema == null || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  if (typeof s["$ref"] === "string") {
    const resolved = resolveRef(s["$ref"], root);
    return inlineRefs(resolved, root, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (Array.isArray(v)) {
      out[k] = v.map((item) => inlineRefs(item, root, depth + 1));
    } else if (v && typeof v === "object") {
      out[k] = inlineRefs(v, root, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Extract a normalized document (title, baseUrl, operations) from a parsed spec. */
export function extractDocument(
  spec: unknown,
  options: { specUrl?: string } = {},
): OpenApiDocument {
  if (!spec || typeof spec !== "object") {
    throw new Error("Spec is not an object");
  }
  const s = spec as Record<string, any>;
  if (!s.paths || typeof s.paths !== "object") {
    throw new Error("Spec has no `paths` -- is this a valid OpenAPI 3.x document?");
  }

  const seen = new Set<string>();
  const operations: Operation[] = [];

  for (const [path, pathItem] of Object.entries(s.paths as Record<string, any>)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const pathLevelParams: OpenApiParameter[] = Array.isArray(pathItem.parameters)
      ? pathItem.parameters
      : [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;

      const opParams: OpenApiParameter[] = Array.isArray(op.parameters)
        ? op.parameters
        : [];
      const parameters = mergeParameters(pathLevelParams, opParams).map((p) => ({
        ...p,
        schema: p.schema ? (inlineRefs(p.schema, s) as JsonSchema) : undefined,
      }));

      let toolName: string = op.operationId
        ? sanitizeName(op.operationId)
        : deriveToolName(method, path);
      if (seen.has(toolName)) {
        let i = 2;
        while (seen.has(`${toolName}_${i}`)) i++;
        toolName = `${toolName}_${i}`;
      }
      seen.add(toolName);

      const { schema: requestBodySchema, required: requestBodyRequired } =
        extractRequestBody(op.requestBody, s);

      operations.push({
        toolName,
        method: method.toUpperCase(),
        path,
        summary: op.summary,
        description: op.description,
        parameters,
        requestBodySchema,
        requestBodyRequired,
      });
    }
  }

  return {
    title: s.info?.title ?? "OpenAPI Service",
    version: s.info?.version ?? "0.0.0",
    baseUrl: resolveBaseUrl(s, options.specUrl),
    operations,
  };
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

function mergeParameters(
  pathLevel: OpenApiParameter[],
  opLevel: OpenApiParameter[],
): OpenApiParameter[] {
  const key = (p: OpenApiParameter) => `${p.in}:${p.name}`;
  const map = new Map<string, OpenApiParameter>();
  for (const p of pathLevel) if (p?.name && p?.in) map.set(key(p), p);
  for (const p of opLevel) if (p?.name && p?.in) map.set(key(p), p);
  return [...map.values()];
}

function extractRequestBody(
  requestBody: any,
  root: Record<string, any>,
): { schema?: JsonSchema; required: boolean } {
  if (!requestBody || typeof requestBody !== "object") {
    return { required: false };
  }
  // Resolve a top-level $ref on the requestBody itself.
  const resolved = typeof requestBody["$ref"] === "string"
    ? (resolveRef(requestBody["$ref"], root) as any ?? requestBody)
    : requestBody;
  const content = resolved.content ?? {};
  const json = content["application/json"];
  const schema = json?.schema
    ? (inlineRefs(json.schema, root) as JsonSchema)
    : undefined;
  return {
    schema,
    required: Boolean(resolved.required),
  };
}