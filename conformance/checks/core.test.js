/**
 * What every service must do, whatever features it offers: discovery, the
 * request id, the error body, versions, methods and CORS.
 */

import assert from "node:assert/strict";
import { before, describe } from "node:test";
import { check, describe as show, expectError, expectRequestId, expectSchema, expectStatus, offers, request, reset, settings, should, v } from "../lib/suite.js";

const FOREIGN = "https://conformance-foreign-origin.invalid";
const WRITES = [
  ["corrections", "/corrections"],
  ["contact", "/contact"],
  ["comments", "/comments"],
  ["reactions", "/reactions"],
  ["subscriptions", "/subscriptions"]
];

before(reset);

describe("discovery", () => {
  check("GET /capabilities answers 200 with api_version and a features object", async () => {
    const response = await request("GET", v("/capabilities"));
    expectStatus(response, 200);
    expectSchema(response, "getCapabilities");
  });

  check("capabilities report the API version the site expects", async () => {
    const response = await request("GET", v("/capabilities"));
    const actual = String(response.json?.api_version ?? "").replace(/^v/i, "");
    assert.equal(
      actual,
      settings.apiVersion,
      `Version mismatch: the site expects API version ${settings.apiVersion}, the service reports ${JSON.stringify(response.json?.api_version)}. The theme would show every feature as "expect different API versions".`
    );
  });

  check("another API version is not served as if it were this one", async () => {
    const other = Number(settings.apiVersion) + 1;
    const response = await request("GET", `/v${other}/capabilities`);
    assert.ok(
      response.status >= 400 || String(response.json?.api_version ?? "").replace(/^v/i, "") === String(other),
      `/v${other}/capabilities answered ${response.status} claiming version ${JSON.stringify(response.json?.api_version)}. A service must not answer a version it does not speak as another. ${show(response)}`
    );
  });
});

describe("request ids and errors", () => {
  check("a successful answer carries X-Request-Id", async () => {
    expectRequestId(await request("GET", v("/capabilities")));
  });

  check("an unknown address under the version answers 404 in the error body, with the request id", async () => {
    const response = await request("GET", v(`/conformance-no-such-route-${settings.runId}`));
    expectError(response, 404);
  });

  should("a method the address does not take answers 405 in the error body", async () => {
    expectError(await request("PUT", v("/capabilities"), { body: {} }), 405);
  });

  check("a write whose body is not JSON is refused with a 4xx in the error body, not a 5xx", async (t) => {
    const write = WRITES.find(([feature]) => offers(feature));
    if (!write) {
      t.skip("the service offers no write");
      return;
    }
    const response = await request("POST", v(write[1]), { raw: "{not json", headers: { "Content-Type": "application/json" } });
    assert.ok(response.status >= 400 && response.status < 500, `A malformed body must be the client's error. ${show(response)}`);
    expectError(response, response.status);
  });
});

describe("CORS", () => {
  check("an answer to the site names the site's origin and exposes X-Request-Id and Retry-After", async () => {
    const response = await request("GET", v("/capabilities"));
    const allowed = response.headers.get("Access-Control-Allow-Origin");
    assert.ok(allowed === settings.origin || allowed === "*", `Access-Control-Allow-Origin must allow ${settings.origin}; got ${allowed}.`);
    const exposed = (response.headers.get("Access-Control-Expose-Headers") || "").toLowerCase();
    assert.ok(exposed.includes("x-request-id"), `Access-Control-Expose-Headers must include X-Request-Id, or the theme cannot show the reference; got "${exposed}".`);
    assert.ok(exposed.includes("retry-after"), `Access-Control-Expose-Headers must include Retry-After, or the theme cannot show the wait; got "${exposed}".`);
  });

  check("with credentials, the origin is named exactly (never *) and credentials are allowed", async () => {
    const response = await request("GET", v("/capabilities"));
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      settings.origin,
      "With credentials: include or same-origin, browsers refuse a wildcard: the site's origin must be named exactly."
    );
    assert.equal(response.headers.get("Access-Control-Allow-Credentials"), "true", "Access-Control-Allow-Credentials must be true for the moderation inbox's session.");
  });

  check("a preflight allows the methods and headers the theme's client sends", async () => {
    const response = await request("OPTIONS", v("/comments"), {
      headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,idempotency-key" }
    });
    assert.ok(response.status >= 200 && response.status < 300, `A preflight must succeed. ${show(response)}`);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), settings.origin, "The preflight must name the site's origin.");
    const methods = (response.headers.get("Access-Control-Allow-Methods") || "").toUpperCase();
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      assert.ok(methods.includes(method), `Access-Control-Allow-Methods must include ${method} (subscriptions use PATCH and DELETE); got "${methods}".`);
    }
    const headers = (response.headers.get("Access-Control-Allow-Headers") || "").toLowerCase();
    for (const header of ["content-type", "idempotency-key"]) {
      assert.ok(headers.includes(header), `Access-Control-Allow-Headers must include ${header}; got "${headers}".`);
    }
  });

  check("another origin is not allowed", async () => {
    const response = await request("GET", v("/capabilities"), { origin: FOREIGN });
    const allowed = response.headers.get("Access-Control-Allow-Origin");
    assert.notEqual(allowed, FOREIGN, `The service echoed a foreign origin (${FOREIGN}) in Access-Control-Allow-Origin, which lets any site read and write through a reader's browser.`);
    if (allowed === "*") {
      assert.notEqual(response.headers.get("Access-Control-Allow-Credentials"), "true", "A wildcard origin with credentials allowed is refused by browsers and unsafe.");
    }
  });
});
