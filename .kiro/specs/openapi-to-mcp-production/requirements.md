# Requirements Document

## Introduction

`openapi-to-mcp` converts any OpenAPI 3.x specification into a Model Context Protocol (MCP) server, exposing each API endpoint as a callable tool for LLMs such as Claude and Codex. The project currently exists as a solid prototype (v0.1.0). This document captures all requirements needed to take the library and CLI to a production-quality 1.0 release, covering missing features, robustness, developer experience, documentation completeness, test coverage, security hardening, and npm publishing readiness.

---

## Glossary

- **CLI**: The `openapi-to-mcp` command-line interface entry point (`src/cli.ts`).
- **Library**: The programmatic API exported from `src/index.ts`.
- **Loader**: The subsystem in `src/openapi.ts` responsible for fetching and parsing specs.
- **Extractor**: The subsystem in `src/openapi.ts` responsible for turning a parsed spec into an `OpenApiDocument`.
- **Schema_Builder**: The subsystem in `src/schema.ts` that builds JSON Schema tool inputs and HTTP requests.
- **MCP_Server**: The MCP server instance created by `createServer()` in `src/server.ts`.
- **Transport**: A connection channel for the MCP_Server (stdio, HTTP/SSE).
- **Operation**: A single OpenAPI path + HTTP method pair extracted into a normalized object.
- **Tool**: The MCP representation of an Operation exposed to an LLM client.
- **$ref**: A JSON Reference pointer (`"$ref": "#/..."`) used in OpenAPI specs to reuse schema definitions.
- **External_Ref**: A `$ref` that points to a different file or URL (e.g., `./models.yaml#/Foo`, `https://example.com/schema.json`).
- **Round_Trip**: The property that parsing a serialized value and re-serializing it produces an equivalent result.
- **Spec_Validator**: A subsystem that checks a parsed OpenAPI object for structural correctness before processing.
- **Filter**: A mechanism for including or excluding specific Operations from the generated Tool set.
- **Prefix**: An optional string prepended to every Tool name to avoid collisions when multiple specs are served.
- **Rate_Limiter**: A subsystem that enforces a maximum number of outbound HTTP requests per unit of time.
- **Retry_Policy**: A strategy for automatically re-issuing a failed HTTP request with back-off.
- **CHANGELOG**: A `CHANGELOG.md` file tracking version history following Keep a Changelog conventions.
- **Contributing_Guide**: A `CONTRIBUTING.md` file explaining how to submit issues and pull requests.

---

## Requirements

### Requirement 1: External `$ref` Resolution

**User Story:** As a developer integrating a large enterprise API, I want external `$ref` pointers in the spec to be resolved, so that schemas split across multiple files or URLs are fully materialized into Tool inputs.

#### Acceptance Criteria

1. WHEN the Loader encounters a `$ref` value beginning with `./`, `../`, or an absolute file path, THE Loader SHALL read that file from the local filesystem and resolve the referenced JSON pointer within it.
2. WHEN the Loader encounters a `$ref` value beginning with `http://` or `https://`, THE Loader SHALL fetch that URL over the network and resolve the referenced JSON pointer within the response body.
3. WHEN an external `$ref` file or URL is not reachable, THE Loader SHALL return a descriptive error identifying the failing reference and its location in the spec.
4. WHEN an external `$ref` is resolved, THE Extractor SHALL inline the resolved schema identically to how inline `$ref`s are currently handled.
5. THE Extractor SHALL guard against circular external `$ref` chains by tracking visited references and stopping resolution at a depth limit of 16.

---

### Requirement 2: `multipart/form-data` and `application/x-www-form-urlencoded` Request Body Support

**User Story:** As a developer calling file-upload or form-based APIs, I want `multipart/form-data` and `application/x-www-form-urlencoded` request bodies to be supported, so that Tools can submit form data correctly.

#### Acceptance Criteria

1. WHEN an Operation's request body declares `multipart/form-data`, THE Schema_Builder SHALL map its schema fields into the Tool's input schema and construct a `FormData` body when the Tool is called.
2. WHEN an Operation's request body declares `application/x-www-form-urlencoded`, THE Schema_Builder SHALL map its schema fields into the Tool's input schema and encode the body as a URL-encoded string when the Tool is called.
3. WHEN an Operation's request body declares multiple media types, THE Schema_Builder SHALL prefer `application/json`, then `multipart/form-data`, then `application/x-www-form-urlencoded`, in that order.
4. IF a Tool call supplies a `body` argument for a `multipart/form-data` operation and the body is missing a required form field, THEN THE MCP_Server SHALL return an `isError: true` response describing the missing field.

---

### Requirement 3: Response Schema Exposure

**User Story:** As an LLM using a Tool, I want the Tool's description to include the response schema, so that I understand what to expect from a successful call and can reason about the result.

#### Acceptance Criteria

1. WHEN an Operation defines a `200` or `2xx` response with an `application/json` schema, THE Extractor SHALL capture that schema in the Operation's `responseSchema` field.
2. WHEN the MCP_Server builds the Tool list, THE MCP_Server SHALL include a human-readable summary of the `responseSchema` in the Tool's description when a `responseSchema` is present.
3. WHEN no `2xx` response schema is defined, THE MCP_Server SHALL omit the response schema section from the Tool's description without error.

---

### Requirement 4: Operation Filtering

**User Story:** As a developer serving a large API, I want to include or exclude specific operations from the generated MCP server, so that I can expose only the relevant subset of tools to an LLM.

#### Acceptance Criteria

1. WHEN `createServer()` is called with an `include` option containing operation IDs or tag names, THE MCP_Server SHALL expose only Tools whose `toolName` or OpenAPI tags match an entry in the `include` list.
2. WHEN `createServer()` is called with an `exclude` option containing operation IDs or tag names, THE MCP_Server SHALL suppress Tools whose `toolName` or OpenAPI tags match an entry in the `exclude` list.
3. WHEN both `include` and `exclude` are provided, THE MCP_Server SHALL apply `include` first and then `exclude` from the resulting set.
4. THE CLI SHALL accept `--include <id>` and `--exclude <id>` flags (repeatable) and forward them to `createServer()`.
5. WHEN `--list` is used with filter flags, THE CLI SHALL print only the filtered Tool set.
6. IF the final filtered Tool set is empty, THEN THE MCP_Server SHALL log a warning to stderr and continue serving (an empty tool list is valid).

---

### Requirement 5: Tool Name Prefix / Namespace

**User Story:** As a developer running multiple MCP servers or combining specs, I want a configurable prefix for all tool names, so that tool names remain unique across servers.

#### Acceptance Criteria

1. WHEN `createServer()` is called with a `toolPrefix` option, THE MCP_Server SHALL prepend the prefix and an underscore separator to every Tool name.
2. THE CLI SHALL accept a `--tool-prefix <string>` flag and forward it to `createServer()`.
3. WHEN a `toolPrefix` is applied, THE MCP_Server's `--list` output SHALL show the prefixed names.
4. IF a `toolPrefix` contains characters other than letters, digits, or underscores, THEN THE CLI SHALL exit with a non-zero status and a descriptive error message.

---

### Requirement 6: Retry Logic

**User Story:** As a developer integrating with unreliable upstream APIs, I want transient HTTP failures to be retried automatically, so that temporary network blips do not surface as LLM tool errors.

#### Acceptance Criteria

1. WHEN an HTTP request returns a 429, 502, 503, or 504 status code, THE MCP_Server SHALL retry the request up to the configured `maxRetries` count (default: 2) before returning an error.
2. WHEN retrying, THE MCP_Server SHALL wait an exponentially increasing delay starting at 200 ms, doubled on each retry, before issuing the next attempt.
3. WHEN `createServer()` is called with `maxRetries: 0`, THE MCP_Server SHALL not retry any failed request.
4. THE CLI SHALL accept a `--max-retries <n>` flag (non-negative integer, default 2) and forward it to `createServer()`.
5. WHEN all retries are exhausted, THE MCP_Server SHALL return an `isError: true` response that includes the final HTTP status and the total number of attempts made.

---

### Requirement 7: Rate Limiting

**User Story:** As a developer integrating with rate-limited APIs, I want the MCP server to enforce a request rate cap, so that the LLM cannot inadvertently exhaust API quotas.

#### Acceptance Criteria

1. WHEN `createServer()` is called with a `rateLimit` option specifying `requests` per `windowMs`, THE Rate_Limiter SHALL queue outbound requests so the rate never exceeds the configured limit.
2. WHEN a queued request must wait due to rate limiting, THE MCP_Server SHALL include the wait duration in the tool call result metadata.
3. THE CLI SHALL accept `--rate-limit <n>` (requests per second, positive integer) and enforce it via the Rate_Limiter.
4. WHEN `--rate-limit` is not specified, THE MCP_Server SHALL apply no rate limiting.

---

### Requirement 8: OpenAPI Spec Validation

**User Story:** As a developer supplying a spec, I want the tool to validate the spec's structure before serving, so that invalid specs produce clear errors instead of silent misbehavior at runtime.

#### Acceptance Criteria

1. WHEN a spec is loaded, THE Spec_Validator SHALL check that `openapi` starts with `"3."` and error if the version indicates Swagger 2.0 or an unsupported version.
2. WHEN a spec is loaded, THE Spec_Validator SHALL check that `info.title` and `info.version` are present non-empty strings and emit a warning to stderr if either is missing, using a fallback value.
3. WHEN a spec is loaded, THE Spec_Validator SHALL check that `paths` is a non-empty object and throw an error if it is absent or empty.
4. WHEN a spec contains a path item with no recognized HTTP methods, THE Spec_Validator SHALL emit a warning to stderr identifying that path item.
5. WHEN `--strict` is passed to the CLI, THE CLI SHALL treat Spec_Validator warnings as errors and exit with a non-zero status.

---

### Requirement 9: HTTP/SSE Transport

**User Story:** As a developer deploying the MCP server in a networked environment, I want an HTTP/SSE transport option, so that clients can connect over the network rather than only via stdio.

#### Acceptance Criteria

1. WHEN `createServer()` is called with `transport: "http"` and a `port` option, THE MCP_Server SHALL listen for MCP connections on the specified TCP port using the `@modelcontextprotocol/sdk` HTTP/SSE transport.
2. WHEN `--transport http --port <n>` flags are passed to the CLI, THE CLI SHALL start the MCP_Server with the HTTP/SSE Transport on that port.
3. WHEN the `--port` flag is omitted and `--transport http` is specified, THE CLI SHALL default to port `3000`.
4. WHEN the HTTP/SSE server starts, THE CLI SHALL log `openapi-to-mcp: listening on http://localhost:<port>` to stderr.
5. WHEN `--transport` is not specified, THE CLI SHALL default to stdio transport, preserving backward compatibility.

---

### Requirement 10: `--version` CLI Flag

**User Story:** As a developer or system integrator, I want a `--version` flag, so that I can confirm which version of `openapi-to-mcp` is installed.

#### Acceptance Criteria

1. WHEN `openapi-to-mcp --version` or `openapi-to-mcp -V` is invoked, THE CLI SHALL print the version string from `package.json` to stdout and exit with status 0.
2. THE CLI SHALL derive the version at build time (embedded into the compiled output) rather than reading `package.json` at runtime.

---

### Requirement 11: Server Test Coverage (`server.test.ts`)

**User Story:** As a contributor, I want complete test coverage for the MCP server logic, so that regressions in tool listing, HTTP dispatch, timeout, retry, and error handling are caught automatically.

#### Acceptance Criteria

1. THE MCP_Server's `ListTools` handler SHALL be tested with an in-memory spec, verifying the correct Tool count, names, and descriptions.
2. THE MCP_Server's `CallTool` handler SHALL be tested for a successful HTTP 200 response, verifying the `isError: false` result and response body propagation.
3. THE MCP_Server's `CallTool` handler SHALL be tested for HTTP 4xx/5xx responses, verifying the `isError: true` result and status code presence.
4. THE MCP_Server's `CallTool` handler SHALL be tested for request timeout, verifying the `isError: true` result and timeout message.
5. THE MCP_Server's `CallTool` handler SHALL be tested for an unknown tool name, verifying the `isError: true` result.
6. THE MCP_Server's retry behavior SHALL be tested by simulating transient 503 responses followed by a 200, verifying that the successful response is returned after retries.
7. THE MCP_Server's `CallTool` tests SHALL use an injected `fetchImpl` mock and SHALL NOT make real network requests.

---

### Requirement 12: CLI Test Coverage (`cli.test.ts`)

**User Story:** As a contributor, I want tests for CLI argument parsing and startup behavior, so that CLI flag regressions are caught without running the full server.

#### Acceptance Criteria

1. THE CLI's argument parser SHALL be tested for all flags: `--spec`, `--base-url`, `--header`, `--timeout`, `--list`, `--help`, `--version`, `--tool-prefix`, `--include`, `--exclude`, `--max-retries`, `--rate-limit`, `--transport`, `--port`, `--strict`.
2. WHEN an invalid `--timeout` value is supplied, THE CLI's argument parser SHALL throw an error with a message referencing `--timeout`.
3. WHEN `OPENAPI_MCP_TOKEN` is set, THE CLI's argument parser SHALL produce an `Authorization: Bearer <token>` header entry.
4. WHEN an invalid `--tool-prefix` is supplied, THE CLI SHALL produce an error with a descriptive message.

---

### Requirement 13: Property-Based Test Coverage

**User Story:** As a contributor, I want property-based tests for the core parsing and schema-building functions, so that edge cases across arbitrary inputs are systematically explored.

#### Acceptance Criteria

1. THE Schema_Builder's `buildInputSchema` function SHALL be covered by a property test verifying that for any valid Operation, every required parameter appears in the `required` array and every parameter appears in `properties` (size invariant).
2. THE Schema_Builder's `buildRequest` function SHALL be covered by a property test verifying that path parameters are always substituted and never appear as literal `{name}` tokens in the resulting URL.
3. THE Extractor's `deriveToolName` function SHALL be covered by a property test verifying that the output contains only alphanumeric characters and underscores and is at most 64 characters long (output invariant).
4. THE Loader's `parseSpecString` function SHALL be covered by a round-trip property test: for any JSON-serializable object, `JSON.parse(JSON.stringify(x))` shall equal `x`, confirming the JSON parse path is lossless.

---

### Requirement 14: Security Hardening

**User Story:** As a security-conscious operator, I want the tool to apply defensive practices, so that it cannot be used to exfiltrate secrets or make unintended requests.

#### Acceptance Criteria

1. WHEN the MCP_Server makes an outbound HTTP request, THE MCP_Server SHALL include only headers explicitly configured via `options.headers` or the tool call's parameter headers, and SHALL NOT forward any MCP client-supplied headers outside of these.
2. WHEN `--header` values are parsed, THE CLI SHALL reject header names containing control characters or CRLF sequences and exit with a non-zero status and descriptive error.
3. WHEN the `OPENAPI_MCP_TOKEN` environment variable is set, THE CLI SHALL not echo its value to stdout or include it in log output.
4. WHEN a response body exceeds 1 MB in size, THE MCP_Server SHALL truncate the content to 1 MB and append a `[response truncated]` note in the returned text.
5. WHEN a spec is loaded from a URL, THE Loader SHALL follow at most 5 HTTP redirects before returning an error.

---

### Requirement 15: npm Publishing Readiness

**User Story:** As the package maintainer, I want the package to be fully configured for npm publication, so that `npm publish` produces a correct, complete, and verifiable release.

#### Acceptance Criteria

1. THE `package.json` SHALL declare an `exports` field mapping the package root (`.`) to the ESM `dist/index.js` entry point and its corresponding type declaration.
2. THE `package.json` SHALL declare `"sideEffects": false` to enable tree-shaking for library consumers.
3. THE `package.json` version SHALL follow Semantic Versioning; the 1.0.0 release SHALL be tagged `v1.0.0` in the repository.
4. THE `files` array in `package.json` SHALL include `dist`, `README.md`, `LICENSE`, and `CHANGELOG.md`.
5. THE CI workflow SHALL include a publish step that runs on `push` to a `v*` tag, authenticates to npm via `NODE_AUTH_TOKEN`, and runs `npm publish --access public`.
6. THE `prepublishOnly` script SHALL run both `npm run build` and `npm test` to prevent publishing a broken build.

---

### Requirement 16: CHANGELOG and Contributing Guide

**User Story:** As an open-source contributor or adopter, I want a CHANGELOG and Contributing Guide, so that I can understand the project's history and know how to contribute effectively.

#### Acceptance Criteria

1. THE repository SHALL contain a `CHANGELOG.md` file at the root, following the Keep a Changelog format, with an entry for the 1.0.0 release.
2. THE repository SHALL contain a `CONTRIBUTING.md` file at the root documenting: how to fork and clone, how to install dependencies, how to run tests, how to run the CLI locally, and the pull request process.
3. THE `CONTRIBUTING.md` SHALL document the EARS requirement format used in spec documents, so future contributors can write compliant requirements.
4. WHEN a `CONTRIBUTING.md` is present, THE README SHALL link to it in the Development section.

---

### Requirement 17: README Completeness

**User Story:** As a new user or evaluator, I want the README to be complete and accurate for the 1.0 release, so that I can quickly understand what the tool does and how to use all its features.

#### Acceptance Criteria

1. THE README SHALL document all CLI flags added in the 1.0 release: `--version`, `--tool-prefix`, `--include`, `--exclude`, `--max-retries`, `--rate-limit`, `--transport`, `--port`, `--strict`.
2. THE README SHALL include a "Supported Content Types" section listing `application/json`, `multipart/form-data`, and `application/x-www-form-urlencoded`.
3. THE README SHALL remove or update the Limitations section to reflect resolved limitations and retain only those still present in the 1.0 release.
4. THE README SHALL include a "Security" section describing how credentials are managed and what the tool does not forward.
5. WHEN the programmatic API section documents `createServer()`, THE README SHALL include examples of the `include`, `exclude`, `toolPrefix`, `maxRetries`, `rateLimit`, and `transport` options.
