import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError, invalid, result } from "../src/http.js";
import { BASE_ENV, SITE, call, clock, freshDb, makeApp } from "./helpers.js";

const REQUEST_ID = /^req_[0-9a-hjkmnp-tv-z]{26}$/;

/** A write and a read route to exercise the pipeline with. */
function testRoutes(calls = []) {
  return [
    {
      method: "POST",
      path: "/echo",
      write: true,
      feature: "comments",
      limit: "echo",
      handler: async ({ body }) => {
        calls.push(body);
        if (body.fail === "server") {
          throw new Error("boom");
        }
        if (body.fail === "invalid") {
          throw invalid({ name: "Required." });
        }
        return result(201, { echoed: body, count: calls.length });
      }
    },
    { method: "GET", path: "/items/:id", feature: "comments", handler: async ({ params }) => result(200, { id: params.id }) },
    { method: "DELETE", path: "/items/:id", write: true, body: "none", feature: "comments", handler: async () => result(204) }
  ];
}

async function echoApp(env = {}, calls = [], now) {
  return makeApp({ routes: testRoutes(calls), env: { FEATURES: "comments", RATE_LIMITS: "echo=3/60", ...env }, now });
}

describe("capabilities", () => {
  it("lists every feature, each on or off as FEATURES says", async () => {
    const { app } = await makeApp({ env: { FEATURES: "comments, reactions,corrections" } });
    const { status, json, headers } = await call(app, "GET", "/v1/capabilities");

    assert.equal(status, 200);
    assert.deepEqual(json, {
      api_version: "1",
      features: {
        comments: true,
        reactions: true,
        corrections: true,
        contact: false,
        subscriptions: false,
        webmentions: false,
        moderation: false
      }
    });
    assert.equal(headers.get("Cache-Control"), "public, max-age=300");
  });

  it("refuses to start with a feature it does not have", async () => {
    await assert.rejects(makeApp({ env: { FEATURES: "comments,chat" } }), /chat/);
  });

  it("answers health with the database's state", async () => {
    const { app } = await makeApp();
    assert.deepEqual((await call(app, "GET", "/v1/health")).json, { status: "ok", api_version: "1" });
  });
});

describe("request ids and the error model", () => {
  it("gives every answer an X-Request-Id, and every error body the same id", async () => {
    const { app } = await makeApp();
    const ok = await call(app, "GET", "/v1/capabilities");
    const missing = await call(app, "GET", "/v1/nothing-here");

    assert.match(ok.headers.get("X-Request-Id"), REQUEST_ID);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, {
      error: { code: "not_found", message: "There is nothing at this address." },
      request_id: missing.headers.get("X-Request-Id")
    });
    assert.notEqual(ok.headers.get("X-Request-Id"), missing.headers.get("X-Request-Id"));
  });

  it("answers another API version with a 404 that names its own", async () => {
    const { app } = await makeApp();
    const { status, json } = await call(app, "GET", "/v2/capabilities");

    assert.equal(status, 404);
    assert.equal(json.error.code, "unsupported_version");
    assert.match(json.error.message, /version 1/);
  });

  it("answers a known address with the wrong method with a 405 and Allow", async () => {
    const { app } = await echoApp();
    const { status, json, headers } = await call(app, "PUT", "/v1/items/7");

    assert.equal(status, 405);
    assert.equal(json.error.code, "method_not_allowed");
    assert.equal(headers.get("Allow"), "GET, DELETE, OPTIONS");
  });

  it("answers an unexpected failure with a bare 500 and logs it with the request id", async () => {
    const { app, logs } = await echoApp();
    const { status, json, headers } = await call(app, "POST", "/v1/echo", { body: { fail: "server" } });

    assert.equal(status, 500);
    assert.deepEqual(json.error, { code: "internal", message: "The service ran into a problem." });
    const logged = logs.find((entry) => entry.event === "unexpected_error");
    assert.equal(logged.requestId, headers.get("X-Request-Id"));
    assert.match(logged.error, /boom/);
  });

  it("logs a route's pattern, never its path", async () => {
    const { app, logs } = await echoApp();
    await call(app, "GET", "/v1/items/secret-token-in-the-path");

    const line = JSON.stringify(logs.filter((entry) => entry.event === "request"));
    assert.match(line, /GET \/items\/:id/);
    assert.doesNotMatch(line, /secret-token-in-the-path/);
  });
});

describe("feature switches", () => {
  it("answers a route of a feature that is off with a 404", async () => {
    const { app } = await echoApp({ FEATURES: "" });
    const { status, json } = await call(app, "GET", "/v1/items/1");

    assert.equal(status, 404);
    assert.equal(json.error.code, "feature_off");
  });
});

describe("CORS", () => {
  it("names the site's origin exactly, allows credentials and exposes the request id", async () => {
    const { app } = await makeApp();
    const { headers } = await call(app, "GET", "/v1/capabilities");

    assert.equal(headers.get("Access-Control-Allow-Origin"), SITE);
    assert.equal(headers.get("Access-Control-Allow-Credentials"), "true");
    assert.equal(headers.get("Access-Control-Expose-Headers"), "X-Request-Id, Retry-After");
    assert.equal(headers.get("Vary"), "Origin");
  });

  it("refuses another origin, and says nothing to it a browser could read", async () => {
    const { app } = await makeApp();
    const { status, json, headers } = await call(app, "GET", "/v1/capabilities", { origin: "https://elsewhere.example" });

    assert.equal(status, 403);
    assert.equal(json.error.code, "origin_not_allowed");
    assert.equal(headers.get("Access-Control-Allow-Origin"), null);
  });

  it("serves a request without an Origin, as a server's, with no CORS headers", async () => {
    const { app } = await makeApp();
    const { status, headers } = await call(app, "GET", "/v1/capabilities", { origin: null });

    assert.equal(status, 200);
    assert.equal(headers.get("Access-Control-Allow-Origin"), null);
  });

  it("answers a preflight with the methods and headers the theme's client sends", async () => {
    const { app } = await makeApp({ env: { CSRF_HEADER: "X-CSRF-Token", CSRF_COOKIE: "csrf_token" } });
    const { status, headers, text } = await call(app, "OPTIONS", "/v1/comments", {
      headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,idempotency-key" }
    });

    assert.equal(status, 204);
    assert.equal(text, "");
    assert.equal(headers.get("Access-Control-Allow-Origin"), SITE);
    assert.equal(headers.get("Access-Control-Allow-Methods"), "GET, POST, PATCH, DELETE, OPTIONS");
    assert.equal(headers.get("Access-Control-Allow-Headers"), "Content-Type, Idempotency-Key, Accept, X-CSRF-Token");
    assert.equal(headers.get("Access-Control-Allow-Credentials"), "true");
  });

  it("refuses a preflight from another origin", async () => {
    const { app } = await makeApp();
    const { status, headers } = await call(app, "OPTIONS", "/v1/comments", {
      origin: "https://elsewhere.example",
      headers: { "Access-Control-Request-Method": "POST" }
    });

    assert.equal(status, 403);
    assert.equal(headers.get("Access-Control-Allow-Methods"), null);
  });

  it("does not take an allowed origin with a path or another scheme", async () => {
    await assert.rejects(makeApp({ env: { ALLOWED_ORIGINS: "ftp://site.example" } }), /http or https/);
    const { app } = await makeApp({ env: { ALLOWED_ORIGINS: "https://site.example/blog/" } });
    assert.deepEqual(app.config.allowedOrigins, [SITE]);
  });
});

describe("writes", () => {
  it("takes JSON only, and says what is wrong with the rest", async () => {
    const { app } = await echoApp();
    const form = await call(app, "POST", "/v1/echo", { raw: "a=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const broken = await call(app, "POST", "/v1/echo", { raw: "{", headers: { "Content-Type": "application/json" } });
    const list = await call(app, "POST", "/v1/echo", { body: [1, 2] });
    const huge = await call(app, "POST", "/v1/echo", { body: { text: "x".repeat(70 * 1024) } });

    assert.deepEqual([form.status, form.json.error.code], [415, "unsupported_media_type"]);
    assert.deepEqual([broken.status, broken.json.error.code], [400, "invalid_json"]);
    assert.deepEqual([list.status, list.json.error.code], [400, "invalid_json"]);
    assert.deepEqual([huge.status, huge.json.error.code], [413, "payload_too_large"]);
  });

  it("maps a handler's 422 onto the fields", async () => {
    const { app } = await echoApp();
    const { status, json } = await call(app, "POST", "/v1/echo", { body: { fail: "invalid" } });

    assert.equal(status, 422);
    assert.deepEqual(json.error.errors, { name: "Required." });
  });

  it("takes a write with no body when the route has none", async () => {
    const { app } = await echoApp();
    assert.equal((await call(app, "DELETE", "/v1/items/3")).status, 204);
  });
});

describe("idempotency", () => {
  it("performs a keyed write once and replays its answer", async () => {
    const calls = [];
    const { app } = await echoApp({}, calls);
    const headers = { "Idempotency-Key": "key-1" };
    const first = await call(app, "POST", "/v1/echo", { body: { text: "hello" }, headers });
    const again = await call(app, "POST", "/v1/echo", { body: { text: "hello" }, headers });

    assert.equal(calls.length, 1);
    assert.deepEqual([again.status, again.json], [first.status, first.json]);
    assert.equal(again.headers.get("Idempotent-Replayed"), "true");
    assert.equal(first.headers.get("Idempotent-Replayed"), null);
  });

  it("refuses the same key with another body", async () => {
    const { app } = await echoApp();
    const headers = { "Idempotency-Key": "key-2" };
    await call(app, "POST", "/v1/echo", { body: { text: "one" }, headers });
    const { status, json } = await call(app, "POST", "/v1/echo", { body: { text: "two" }, headers });

    assert.equal(status, 422);
    assert.equal(json.error.code, "idempotency_key_reused");
  });

  it("replays a refusal too, but lets a failed attempt be tried again", async () => {
    const calls = [];
    const { app } = await echoApp({}, calls);
    const refused = await call(app, "POST", "/v1/echo", { body: { fail: "invalid" }, headers: { "Idempotency-Key": "key-3" } });
    const replayed = await call(app, "POST", "/v1/echo", { body: { fail: "invalid" }, headers: { "Idempotency-Key": "key-3" } });
    assert.deepEqual([replayed.status, replayed.json], [refused.status, refused.json]);

    const failed = await call(app, "POST", "/v1/echo", { body: { fail: "server" }, headers: { "Idempotency-Key": "key-4" } });
    const retried = await call(app, "POST", "/v1/echo", { body: { fail: "server" }, headers: { "Idempotency-Key": "key-4" } });
    assert.equal(failed.status, 500);
    assert.equal(retried.status, 500);
    assert.equal(calls.length, 3, "the 422 ran once; each 500 ran, since a retry may succeed");
  });

  it("keeps keys apart per path, and refuses a key that is not one", async () => {
    const { app } = await echoApp();
    const bad = await call(app, "POST", "/v1/echo", { body: {}, headers: { "Idempotency-Key": "has space" } });
    assert.deepEqual([bad.status, bad.json.error.code], [400, "invalid_idempotency_key"]);

    const one = await call(app, "DELETE", "/v1/items/1", { headers: { "Idempotency-Key": "shared" } });
    const two = await call(app, "DELETE", "/v1/items/2", { headers: { "Idempotency-Key": "shared" } });
    assert.equal(one.status, 204);
    assert.equal(two.headers.get("Idempotent-Replayed"), null);
  });

  it("answers a retry that arrives while the first is still running with a 409", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const routes = [{ method: "POST", path: "/slow", write: true, handler: async () => (await gate, result(201, { done: true })) }];
    const { app } = await makeApp({ routes, env: { FEATURES: "" } });
    const headers = { "Idempotency-Key": "key-5" };
    const first = call(app, "POST", "/v1/slow", { body: {}, headers });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await call(app, "POST", "/v1/slow", { body: {}, headers });
    release();

    assert.deepEqual([second.status, second.json.error.code], [409, "idempotency_in_progress"]);
    assert.equal((await first).status, 201);
  });
});

describe("rate limits", () => {
  it("answers 429 with Retry-After once a client spends its window, and not before", async () => {
    const now = clock(Date.parse("2026-09-30T12:00:10Z"));
    const { app } = await echoApp({}, [], now);
    const statuses = [];
    for (let index = 0; index < 4; index += 1) {
      statuses.push((await call(app, "POST", "/v1/echo", { body: { index } })).status);
    }
    const limited = await call(app, "POST", "/v1/echo", { body: { index: 9 } });

    assert.deepEqual(statuses, [201, 201, 201, 429]);
    assert.equal(limited.json.error.code, "rate_limited");
    assert.equal(limited.headers.get("Retry-After"), "50");

    const other = await call(app, "POST", "/v1/echo", { body: {}, ip: "198.51.100.1" });
    assert.equal(other.status, 201, "another client has its own window");

    now.advance(50_000);
    assert.equal((await call(app, "POST", "/v1/echo", { body: {} })).status, 201, "a new window starts afresh");
  });

  it("does not count a replay against the limit", async () => {
    const { app } = await echoApp({ RATE_LIMITS: "echo=1/60" });
    const headers = { "Idempotency-Key": "key-6" };
    await call(app, "POST", "/v1/echo", { body: {}, headers });
    assert.equal((await call(app, "POST", "/v1/echo", { body: {}, headers })).status, 201);
  });

  it("refuses to count without SECRET_KEY rather than count addresses in the clear", async () => {
    const { app } = await echoApp({ SECRET_KEY: "" });
    const { status, json } = await call(app, "POST", "/v1/echo", { body: {} });

    assert.equal(status, 500);
    assert.equal(json.error.code, "misconfigured");
  });

  it("rejects a limit that is not count/seconds", async () => {
    await assert.rejects(makeApp({ env: { RATE_LIMITS: "comments=lots" } }), /count\/seconds/);
  });
});

describe("the helpers", () => {
  it("keeps HttpError's details", () => {
    const error = new HttpError(429, "rate_limited", "Wait.", { headers: { "Retry-After": "5" } });
    assert.deepEqual([error.status, error.code, error.headers["Retry-After"]], [429, "rate_limited", "5"]);
  });

  it("starts from a database with the core tables", async () => {
    const db = await freshDb();
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).results.map((row) => row.name);
    assert.ok(tables.includes("rate_limits") && tables.includes("idempotency_keys"), tables.join(", "));
    assert.equal(BASE_ENV.ALLOWED_ORIGINS, SITE);
  });
});
