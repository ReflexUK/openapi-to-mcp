/**
 * Spec_Validator — structural validation of a parsed OpenAPI spec object.
 *
 * Returns an array of non-fatal warnings. Throws a TypeError for fatal errors.
 * In strict mode, warnings are promoted to thrown errors.
 */

export interface ValidationWarning {
  code:
    | "MISSING_OPENAPI_VERSION"
    | "UNSUPPORTED_OPENAPI_VERSION"
    | "MISSING_TITLE"
    | "MISSING_VERSION"
    | "EMPTY_PATHS"
    | "PATH_NO_METHODS";
  message: string;
  path?: string;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head"];

/**
 * Validate the structural correctness of a parsed OpenAPI spec.
 * Returns an array of warnings (non-fatal issues).
 * Throws a TypeError for fatal structural problems.
 *
 * @param spec    The parsed spec object (output of loadSpec / parseSpecString).
 * @param strict  If true, warnings are promoted to thrown errors.
 */
export function validateSpec(spec: unknown, strict = false): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  if (!spec || typeof spec !== "object") {
    throw new TypeError(
      "Invalid spec: expected an object but received " +
        (spec === null ? "null" : typeof spec),
    );
  }

  const s = spec as Record<string, unknown>;

  // Rule 1: spec.openapi must exist and start with "3." — always fatal
  const openapi = s["openapi"];
  if (openapi === undefined || openapi === null) {
    throw new TypeError(
      'Invalid spec: missing "openapi" field. This tool requires an OpenAPI 3.x document.',
    );
  }
  if (typeof openapi !== "string") {
    throw new TypeError(
      `Invalid spec: "openapi" field must be a string, got ${typeof openapi}.`,
    );
  }
  if (openapi.startsWith("2.")) {
    throw new TypeError(
      `Unsupported spec version: "${openapi}" is a Swagger 2.x document. Only OpenAPI 3.x is supported.`,
    );
  }
  if (!openapi.startsWith("3.")) {
    throw new TypeError(
      `Unsupported spec version: "${openapi}". Only OpenAPI 3.x (versions starting with "3.") is supported.`,
    );
  }

  // Rule 2: spec.info.title and spec.info.version must be non-empty strings
  const info = s["info"];
  const infoObj = info && typeof info === "object" ? (info as Record<string, unknown>) : {};

  const title = infoObj["title"];
  if (!title || typeof title !== "string" || title.trim() === "") {
    const warning: ValidationWarning = {
      code: "MISSING_TITLE",
      message:
        'spec.info.title is missing or empty; falling back to "Unknown Service".',
    };
    if (strict) {
      throw new TypeError(warning.message);
    }
    warnings.push(warning);
    infoObj["title"] = "Unknown Service";
  }

  const version = infoObj["version"];
  if (!version || typeof version !== "string" || String(version).trim() === "") {
    const warning: ValidationWarning = {
      code: "MISSING_VERSION",
      message: 'spec.info.version is missing or empty; falling back to "0.0.0".',
    };
    if (strict) {
      throw new TypeError(warning.message);
    }
    warnings.push(warning);
    infoObj["version"] = "0.0.0";
  }

  // Rule 3: spec.paths must be a non-empty object — always fatal
  const paths = s["paths"];
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    throw new TypeError(
      "Invalid spec: spec.paths is absent or not an object. At least one path is required.",
    );
  }
  if (Object.keys(paths).length === 0) {
    throw new TypeError(
      "Invalid spec: spec.paths is empty. At least one path entry is required.",
    );
  }

  // Rule 4: each path item must have at least one recognized HTTP method
  const pathsObj = paths as Record<string, unknown>;
  for (const [pathKey, pathItem] of Object.entries(pathsObj)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const item = pathItem as Record<string, unknown>;
    const hasMethod = HTTP_METHODS.some((m) => m in item);
    if (!hasMethod) {
      const warning: ValidationWarning = {
        code: "PATH_NO_METHODS",
        message: `Path "${pathKey}" has no recognized HTTP methods (get, put, post, delete, patch, options, head).`,
        path: pathKey,
      };
      if (strict) {
        throw new TypeError(warning.message);
      }
      warnings.push(warning);
    }
  }

  return warnings;
}
