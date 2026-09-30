/**
 * The OpenAPI description is valid OpenAPI 3.1, and names exactly the routes
 * the service has: a route added without its description, or a description
 * left behind by a removed route, fails here.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { Validator } from "@seriousme/openapi-schema-validator";
import { parse } from "yaml";
import { OPENAPI_PATH } from "./fixtures/openapi-path.js";
import { ROOT_ROUTES, ROUTES } from "../src/service.js";
import { CORE_ROUTES } from "../src/app.js";

const document = parse(await readFile(OPENAPI_PATH, "utf8"));

/** `/moderation/items/:id/actions` as OpenAPI writes it. */
function openapiPath(path) {
  return path.replace(/:([a-z_]+)/g, "{$1}");
}

describe("the OpenAPI description", () => {
  it("is valid OpenAPI 3.1", async () => {
    const validator = new Validator();
    const outcome = await validator.validate(document);
    assert.equal(outcome.valid, true, JSON.stringify(outcome.errors, null, 2));
    assert.equal(validator.version, "3.1");
  });

  it("describes every route of the service, and no other", () => {
    const served = [
      ...[...CORE_ROUTES, ...ROUTES].map((route) => `${route.method} /v1${openapiPath(route.path)}`),
      ...ROOT_ROUTES.map((route) => `${route.method} ${openapiPath(route.path)}`)
    ].sort();
    const described = Object.entries(document.paths)
      .flatMap(([path, item]) => Object.keys(item).filter((key) => ["get", "post", "patch", "delete", "put"].includes(key)).map((method) => `${method.toUpperCase()} ${path}`))
      .sort();

    assert.deepEqual(described, served);
  });

  it("gives every operation an id, which the conformance suite validates answers by", () => {
    const ids = Object.values(document.paths).flatMap((item) => Object.values(item).filter((operation) => operation && typeof operation === "object" && "responses" in operation).map((operation) => operation.operationId));
    assert.ok(ids.every(Boolean));
    assert.equal(new Set(ids).size, ids.length, "operation ids are unique");
  });
});
