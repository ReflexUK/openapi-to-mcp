/**
 * Build a single JSON Schema for an operation''s tool input, and turn the
 * resulting tool arguments back into a concrete HTTP request.
 */
import type { JsonSchema, Operation } from "./openapi.js";

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, JsonSchema>;
  required: string[];
  additionalProperties: boolean;
}

/**
 * Flatten an operation''s path/query/header params plus its JSON request body
 * into one object schema. The request body (if any) lives under a `body` key.
 *
 * Description merging: the param-level description is preferred; if the schema
 * has its own description it is kept only as a fallback. This makes tool
 * descriptions more useful since the OpenAPI description is typically more
 * human-readable than the schema annotation.
 *
 * Cookie params are included as optional fields but marked with a note since
 * most fetch environments handle cookies automatically.
 */
export function buildInputSchema(op: Operation): ToolInputSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const p of op.parameters) {
    const schema: JsonSchema = { ...(p.schema ?? { type: "string" }) };

    // Param-level description takes priority over schema-level description.
    if (p.description) {
      schema.description = p.description;
    }

    // Tag where this param lives so buildRequest knows where to put it.
    schema["x-in"] = p.in;

    if (p.in === "cookie") {
      // Include cookie params but note that they may be handled automatically.
      schema.description =
        (schema.description ? schema.description + " " : "") +
        "(cookie parameter -- may be managed automatically by the HTTP client)";
    }

    properties[p.name] = schema;
    if (p.required && p.in !== "cookie") required.push(p.name);
  }

  if (op.requestBodySchema) {
    properties.body = {
      ...op.requestBodySchema,
      description: op.requestBodySchema.description ?? "JSON request body",
    };
    if (op.requestBodyRequired) required.push("body");
  }

  return { type: "object", properties, required, additionalProperties: false };
}

export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Construct a fetch request from tool arguments. Path params are substituted
 * into the path, query params appended, header params set, cookie params
 * forwarded via the Cookie header, and `body` serialized as JSON.
 */
export function buildRequest(
  op: Operation,
  baseUrl: string,
  args: Record<string, unknown>,
): BuiltRequest {
  let path = op.path;
  const query = new URLSearchParams();
  const headers: Record<string, string> = {};
  const cookieParts: string[] = [];

  for (const p of op.parameters) {
    const value = args[p.name];
    if (value === undefined || value === null) {
      if (p.required) throw new Error(`Missing required parameter: ${p.name}`);
      continue;
    }
    switch (p.in) {
      case "path":
        path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
        break;
      case "query":
        if (Array.isArray(value)) {
          for (const v of value) query.append(p.name, String(v));
        } else {
          query.set(p.name, String(value));
        }
        break;
      case "header":
        headers[p.name] = String(value);
        break;
      case "cookie":
        cookieParts.push(`${p.name}=${encodeURIComponent(String(value))}`);
        break;
    }
  }

  if (cookieParts.length > 0) {
    const existing = headers["cookie"] ?? headers["Cookie"];
    headers["cookie"] = existing
      ? `${existing}; ${cookieParts.join("; ")}`
      : cookieParts.join("; ");
  }

  const base = baseUrl.replace(/\/+$/, "");
  const qs = query.toString();
  const url = `${base}${path}${qs ? `?${qs}` : ""}`;

  let body: string | undefined;
  if (op.requestBodySchema && args.body !== undefined) {
    body = JSON.stringify(args.body);
    headers["content-type"] = "application/json";
  }

  return { url, method: op.method, headers, body };
}