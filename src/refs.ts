/**
 * External $ref resolver for OpenAPI specs.
 *
 * Walks a spec tree depth-first, inlining any $ref values that point to
 * external files or URLs (i.e. refs that do not start with "#").
 * Local (same-document) $ref values beginning with "#" are left untouched
 * so that the existing `inlineRefs` in src/openapi.ts can handle them.
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Returns true when `ref` is an external reference — i.e. it does not start
 * with `"#"` and therefore points outside the current document.
 */
export function isExternalRef(ref: string): boolean {
  return !ref.startsWith("#");
}

/**
 * Follow a JSON Pointer (the segment after `#`) into a parsed document.
 * An empty pointer string returns the root of the document.
 */
function followPointer(doc: unknown, pointer: string): unknown {
  if (!pointer || pointer === "/") {
    // Empty or bare "/" — return root
    return pointer === "/" ? undefined : doc;
  }
  // Trim leading slash then split
  const parts = pointer
    .replace(/^\//, "")
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));

  let cur: unknown = doc;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Load and parse an external document — file or URL.
 * Returns the parsed value (JSON or YAML).
 */
async function loadDocument(
  source: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let raw: string;
  if (/^https?:\/\//i.test(source)) {
    let res: Response;
    try {
      res = await fetchImpl(source);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot resolve external $ref "${source}": ${cause}`);
    }
    if (!res.ok) {
      throw new Error(
        `Cannot resolve external $ref "${source}": HTTP ${res.status} ${res.statusText}`,
      );
    }
    raw = await res.text();
  } else {
    try {
      raw = await readFile(source, "utf8");
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot resolve external $ref "${source}": ${cause}`);
    }
  }

  // Parse as JSON when the content looks like JSON; otherwise YAML.
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(raw);
  }
  return parseYaml(raw);
}

/**
 * Canonical source key: for file paths, use the resolved absolute path;
 * for URLs, use the URL string as-is.
 */
function canonicalSource(source: string, baseDir: string): string {
  if (/^https?:\/\//i.test(source)) return source;
  if (isAbsolute(source)) return source;
  return resolve(baseDir, source);
}

/**
 * Recursively walk `node`, resolve all external `$ref` values, and return a
 * new tree with those refs inlined.
 *
 * @param node       The current value being walked.
 * @param baseDir    Filesystem directory used to resolve relative file refs.
 * @param fetchImpl  Injectable fetch implementation (defaults to global `fetch`).
 * @param docCache   Cache of already-loaded documents, keyed by canonical source.
 * @param visited    Set of `"source#pointer"` strings already in the current chain.
 * @param depth      Current recursion depth (throws at > 16).
 * @param chain      Human-readable chain string for error messages.
 */
async function walk(
  node: unknown,
  baseDir: string,
  fetchImpl: typeof fetch,
  docCache: Map<string, unknown>,
  visited: Set<string>,
  depth: number,
  chain: string,
): Promise<unknown> {
  if (depth > 16) {
    throw new Error(`Circular $ref chain detected at depth 16: ${chain}`);
  }

  if (node == null || typeof node !== "object") {
    return node;
  }

  // Arrays: recurse into each element.
  if (Array.isArray(node)) {
    const result: unknown[] = [];
    for (const item of node) {
      result.push(await walk(item, baseDir, fetchImpl, docCache, visited, depth, chain));
    }
    return result;
  }

  const obj = node as Record<string, unknown>;

  // External $ref object — resolve and inline.
  if (typeof obj["$ref"] === "string" && isExternalRef(obj["$ref"])) {
    const rawRef = obj["$ref"] as string;
    const hashIdx = rawRef.indexOf("#");
    const sourcePart = hashIdx === -1 ? rawRef : rawRef.slice(0, hashIdx);
    const pointerPart = hashIdx === -1 ? "" : rawRef.slice(hashIdx + 1);

    const canonical = canonicalSource(sourcePart, baseDir);
    const visitKey = `${canonical}#${pointerPart}`;
    const newChain = chain ? `${chain} → ${rawRef}` : rawRef;

    if (visited.has(visitKey)) {
      // Already resolving this ref in the current chain — cycle detected.
      throw new Error(`Circular $ref chain detected at depth ${depth}: ${newChain}`);
    }
    visited.add(visitKey);

    // Load (and cache) the external document.
    let doc: unknown;
    if (docCache.has(canonical)) {
      doc = docCache.get(canonical);
    } else {
      doc = await loadDocument(canonical, fetchImpl);
      docCache.set(canonical, doc);
    }

    // Follow the JSON pointer to the target value.
    const target = followPointer(doc, pointerPart);

    // Recursively resolve any external refs within the fetched document.
    // Use the directory of the fetched file as the new baseDir for relative refs
    // inside it, falling back to baseDir for URLs.
    const nestedBaseDir = /^https?:\/\//i.test(canonical)
      ? baseDir
      : dirname(canonical);

    const resolved = await walk(
      target,
      nestedBaseDir,
      fetchImpl,
      docCache,
      visited,
      depth + 1,
      newChain,
    );

    visited.delete(visitKey);
    return resolved;
  }

  // Plain object: recurse into every property.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = await walk(value, baseDir, fetchImpl, docCache, visited, depth, chain);
  }
  return out;
}

/**
 * Walk the spec tree and resolve all external `$ref` pointers, returning a
 * new spec object with those refs inlined.
 *
 * Internal `$ref` values (starting with `"#"`) are left untouched — they are
 * handled by `inlineRefs` in `src/openapi.ts`.
 *
 * @param spec       The parsed spec object.
 * @param baseDir    Filesystem directory used to resolve relative file refs.
 *                   Typically the directory containing the spec file.
 * @param fetchImpl  Fetch implementation (injectable for testing).
 *                   Defaults to the global `fetch` available in Node 20+.
 */
export async function resolveExternalRefs(
  spec: unknown,
  baseDir: string,
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  const fetcher = fetchImpl ?? fetch;
  const docCache = new Map<string, unknown>();
  const visited = new Set<string>();
  return walk(spec, baseDir, fetcher, docCache, visited, 0, "");
}
