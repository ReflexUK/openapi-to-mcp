import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveToolName,
  extractDocument,
  parseSpecString,
  resolveBaseUrl,
  resolveRef,
  inlineRefs,
} from "../src/openapi.ts";

const PETSTORE = {
  openapi: "3.0.0",
  info: { title: "Petstore", version: "1.2.3" },
  servers: [{ url: "https://api.petstore.io/v1" }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List all pets",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
      },
      post: {
        operationId: "createPet",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { name: { type: "string" } } },
            },
          },
        },
      },
    },
    "/pets/{petId}": {
      get: {
        // no operationId -> name derived from method + path
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string" } },
        ],
      },
    },
  },
};

test("deriveToolName cleans path params and slashes", () => {
  assert.equal(deriveToolName("GET", "/pets/{petId}"), "get_pets_petId");
  assert.equal(deriveToolName("get", "/"), "get_root");
});

test("resolveBaseUrl prefers absolute server url", () => {
  assert.equal(
    resolveBaseUrl(PETSTORE as any),
    "https://api.petstore.io/v1",
  );
});

test("resolveBaseUrl resolves relative server against spec url", () => {
  const spec = { servers: [{ url: "/api" }] };
  assert.equal(
    resolveBaseUrl(spec as any, "https://example.com/openapi.json"),
    "https://example.com/api",
  );
});

test("extractDocument finds all operations", () => {
  const doc = extractDocument(PETSTORE);
  assert.equal(doc.title, "Petstore");
  assert.equal(doc.version, "1.2.3");
  assert.equal(doc.baseUrl, "https://api.petstore.io/v1");
  assert.equal(doc.operations.length, 3);

  const names = doc.operations.map((o) => o.toolName).sort();
  assert.deepEqual(names, ["createPet", "get_pets_petId", "listPets"]);
});

test("extractDocument captures request body requirement", () => {
  const doc = extractDocument(PETSTORE);
  const create = doc.operations.find((o) => o.toolName === "createPet")!;
  assert.ok(create.requestBodySchema);
  assert.equal(create.requestBodyRequired, true);
});

test("extractDocument throws on missing paths", () => {
  assert.throws(() => extractDocument({ info: {} }), /paths/);
});

test("parseSpecString handles JSON and YAML", () => {
  const json = parseSpecString('{"a": 1}') as any;
  assert.equal(json.a, 1);
  const yaml = parseSpecString("a: 1\nb: two\n") as any;
  assert.equal(yaml.a, 1);
  assert.equal(yaml.b, "two");
});

test("duplicate operationIds are made unique", () => {
  const spec = {
    info: { title: "Dup", version: "1" },
    paths: {
      "/a": { get: { operationId: "thing" } },
      "/b": { get: { operationId: "thing" } },
    },
  };
  const doc = extractDocument(spec);
  const names = doc.operations.map((o) => o.toolName).sort();
  assert.deepEqual(names, ["thing", "thing_2"]);
});

test("resolveRef follows a JSON pointer", () => {
  const root = { components: { schemas: { Pet: { type: "object" } } } };
  const result = resolveRef("#/components/schemas/Pet", root);
  assert.deepEqual(result, { type: "object" });
});

test("resolveRef returns undefined for unknown ref", () => {
  const root = { components: { schemas: {} } };
  assert.equal(resolveRef("#/components/schemas/Missing", root), undefined);
});

test("inlineRefs replaces $ref with referenced schema", () => {
  const root = {
    components: { schemas: { Tag: { type: "string", description: "a tag" } } },
  };
  const schema = { $ref: "#/components/schemas/Tag" };
  const result = inlineRefs(schema, root) as any;
  assert.equal(result.type, "string");
  assert.equal(result.description, "a tag");
});

test("inlineRefs resolves nested $refs in properties", () => {
  const root = {
    components: { schemas: { Id: { type: "integer" } } },
  };
  const schema = {
    type: "object",
    properties: { id: { $ref: "#/components/schemas/Id" } },
  };
  const result = inlineRefs(schema, root) as any;
  assert.equal(result.properties.id.type, "integer");
});

test("extractDocument inlines $ref schemas in parameters", () => {
  const spec = {
    info: { title: "T", version: "1" },
    components: { schemas: { PetId: { type: "string", format: "uuid" } } },
    paths: {
      "/pets/{id}": {
        get: {
          operationId: "getPet",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { $ref: "#/components/schemas/PetId" },
            },
          ],
        },
      },
    },
  };
  const doc = extractDocument(spec);
  const op = doc.operations[0];
  assert.equal(op.parameters[0].schema?.type, "string");
  assert.equal(op.parameters[0].schema?.format, "uuid");
});