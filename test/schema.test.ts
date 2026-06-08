import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInputSchema, buildRequest } from "../src/schema.ts";
import type { Operation } from "../src/openapi.ts";

const op: Operation = {
  toolName: "getUser",
  method: "GET",
  path: "/users/{id}",
  parameters: [
    { name: "id", in: "path", required: true, schema: { type: "string" } },
    { name: "expand", in: "query", schema: { type: "string" } },
    { name: "X-Trace", in: "header", schema: { type: "string" } },
  ],
  requestBodyRequired: false,
};

const postOp: Operation = {
  toolName: "createUser",
  method: "POST",
  path: "/users",
  parameters: [],
  requestBodySchema: { type: "object", properties: { name: { type: "string" } } },
  requestBodyRequired: true,
};

test("buildInputSchema lists params and marks required", () => {
  const schema = buildInputSchema(op);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "X-Trace",
    "expand",
    "id",
  ]);
  assert.deepEqual(schema.required, ["id"]);
  assert.equal(schema.properties.id["x-in"], "path");
});

test("buildInputSchema adds body for request bodies", () => {
  const schema = buildInputSchema(postOp);
  assert.ok(schema.properties.body);
  assert.deepEqual(schema.required, ["body"]);
});

test("buildInputSchema param description overrides schema description", () => {
  const o: Operation = {
    toolName: "t",
    method: "GET",
    path: "/",
    parameters: [
      {
        name: "q",
        in: "query",
        description: "The search query",
        schema: { type: "string", description: "internal schema desc" },
      },
    ],
    requestBodyRequired: false,
  };
  const schema = buildInputSchema(o);
  assert.equal(schema.properties.q.description, "The search query");
});

test("buildInputSchema includes cookie params as optional with note", () => {
  const o: Operation = {
    toolName: "t",
    method: "GET",
    path: "/",
    parameters: [{ name: "session", in: "cookie", schema: { type: "string" } }],
    requestBodyRequired: false,
  };
  const schema = buildInputSchema(o);
  assert.ok(schema.properties.session, "cookie param should be in schema");
  assert.ok(
    schema.properties.session.description?.includes("cookie parameter"),
    "should note it is a cookie",
  );
  // Cookie params should not be in required array.
  assert.ok(!schema.required.includes("session"));
});

test("buildRequest substitutes path, query, headers", () => {
  const req = buildRequest(op, "https://api.test.io", {
    id: "42",
    expand: "profile",
    "X-Trace": "abc",
  });
  assert.equal(req.method, "GET");
  assert.equal(req.url, "https://api.test.io/users/42?expand=profile");
  assert.equal(req.headers["X-Trace"], "abc");
  assert.equal(req.body, undefined);
});

test("buildRequest serializes JSON body", () => {
  const req = buildRequest(postOp, "https://api.test.io/", { body: { name: "Ada" } });
  assert.equal(req.url, "https://api.test.io/users");
  assert.equal(req.body, JSON.stringify({ name: "Ada" }));
  assert.equal(req.headers["content-type"], "application/json");
});

test("buildRequest throws when required path param missing", () => {
  assert.throws(() => buildRequest(op, "https://api.test.io", {}), /Missing required/);
});

test("buildRequest encodes path values and repeats array query params", () => {
  const arrOp: Operation = {
    toolName: "search",
    method: "GET",
    path: "/search/{q}",
    parameters: [
      { name: "q", in: "path", required: true, schema: { type: "string" } },
      { name: "tag", in: "query", schema: { type: "array" } },
    ],
    requestBodyRequired: false,
  };
  const req = buildRequest(arrOp, "https://x.io", { q: "a/b c", tag: ["x", "y"] });
  assert.equal(req.url, "https://x.io/search/a%2Fb%20c?tag=x&tag=y");
});

test("buildRequest forwards cookie params via Cookie header", () => {
  const cookieOp: Operation = {
    toolName: "t",
    method: "GET",
    path: "/secure",
    parameters: [
      { name: "session", in: "cookie", schema: { type: "string" } },
      { name: "pref", in: "cookie", schema: { type: "string" } },
    ],
    requestBodyRequired: false,
  };
  const req = buildRequest(cookieOp, "https://api.io", {
    session: "abc123",
    pref: "dark mode",
  });
  assert.ok(req.headers["cookie"].includes("session=abc123"));
  assert.ok(req.headers["cookie"].includes("pref=dark%20mode"));
});