/**
 * What every check file shares: the run's settings, a way to call the service
 * under test, the OpenAPI document to validate answers against, the checks'
 * assertions, and the optional test hooks.
 *
 * The settings come from cli.js through DATALOG_CONFORMANCE, as JSON:
 *   baseUrl, origin, siteUrl, apiVersion, features (from capabilities),
 *   hooksToken, moderator, strict, rateLimitProbe, runId.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

export const settings = JSON.parse(process.env.DATALOG_CONFORMANCE || "{}");
if (!settings.baseUrl) {
  throw new Error("Run the checks through conformance/cli.js, which passes the settings in DATALOG_CONFORMANCE.");
}

export const OPENAPI = fileURLToPath(new URL("../../openapi/datalog-services.v1.yaml", import.meta.url));
const document = parse(readFileSync(OPENAPI, "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(document, "openapi");

const operations = new Map();
for (const [path, item] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (operation && operation.operationId) {
      operations.set(operation.operationId, { path, method, operation });
    }
  }
}

function pointer(...segments) {
  return segments.map((segment) => String(segment).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

const validators = new Map();

/** The validator for an operation's answer with a status, or null when the document gives no JSON schema for it. */
function validatorFor(operationId, status) {
  const key = `${operationId} ${status}`;
  if (validators.has(key)) {
    return validators.get(key);
  }
  const found = operations.get(operationId);
  assert.ok(found, `The OpenAPI document has no operation ${operationId}`);
  const responses = found.operation.responses || {};
  const name = responses[String(status)] ? String(status) : responses.default ? "default" : null;
  let validator = null;
  if (name) {
    let location = ["paths", found.path, found.method, "responses", name];
    let response = responses[name];
    if (response.$ref) {
      const component = response.$ref.split("/").pop();
      location = ["components", "responses", component];
      response = document.components.responses[component];
    }
    if (response.content && response.content["application/json"] && response.content["application/json"].schema) {
      validator = ajv.compile({ $ref: `openapi#/${pointer(...location, "content", "application/json", "schema")}` });
    }
  }
  const entry = { documented: name !== null, validator };
  validators.set(key, entry);
  return entry;
}

/** A short account of an answer, for failure messages. */
export function describe(response) {
  const body = response.text.length > 400 ? `${response.text.slice(0, 400)}…` : response.text;
  return `${response.method} ${response.path} answered ${response.status}${body ? `: ${body}` : " with no body"}`;
}

/**
 * Calls the service under test.
 * @param {string} method
 * @param {string} path - Under the base URL, such as /v1/capabilities
 * @param {Object} [options] - `body` (JSON), `form` (url-encoded), `raw`, `headers`,
 *   `origin` (default: the site's; null for none), `cookie`, `key` (Idempotency-Key)
 */
export async function request(method, path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  const origin = options.origin === undefined ? settings.origin : options.origin;
  if (origin) {
    headers.Origin = origin;
  }
  if (options.cookie) {
    headers.Cookie = options.cookie;
  }
  if (options.key) {
    headers["Idempotency-Key"] = options.key;
  }
  let body = options.raw;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  } else if (options.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  }
  const response = await fetch(`${settings.baseUrl}${path}`, { method, headers, body, redirect: "manual" });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { method, path, status: response.status, headers: response.headers, text, json };
}

/** A path under the versioned base. */
export function v(path) {
  return `/v${settings.apiVersion}${path}`;
}

/** A value no earlier run used: pages, emails and keys are unique per run. */
let counter = 0;
export function unique(prefix) {
  counter += 1;
  return `${prefix}-${settings.runId}-${counter}`;
}

export function pagePath(name = "page") {
  return `/conformance/${settings.runId}/${name}-${(counter += 1)}/`;
}

export function pageUrl(path) {
  return `${settings.siteUrl}${path}`;
}

// --- Assertions -------------------------------------------------------------

export function expectStatus(response, ...statuses) {
  assert.ok(statuses.includes(response.status), `Expected ${statuses.join(" or ")}. ${describe(response)}`);
}

export function expectRequestId(response) {
  const header = response.headers.get("X-Request-Id");
  const inBody = response.json && typeof response.json === "object" ? response.json.request_id : undefined;
  assert.ok(header || inBody, `No request id: neither an X-Request-Id header nor request_id in the body. ${describe(response)}`);
  if (header && inBody) {
    assert.equal(inBody, header, `request_id in the body (${inBody}) is not the X-Request-Id header (${header}).`);
  }
}

/** The answer's body matches the OpenAPI schema for the operation and status. */
export function expectSchema(response, operationId) {
  const { documented, validator } = validatorFor(operationId, response.status);
  assert.ok(documented, `${operationId} does not document a ${response.status}. ${describe(response)}`);
  if (validator) {
    assert.ok(response.json !== undefined, `Expected a JSON body. ${describe(response)}`);
    const valid = validator(response.json);
    assert.ok(
      valid,
      `The body does not match the OpenAPI schema of ${operationId} ${response.status}: ${ajv.errorsText(validator.errors, { dataVar: "body" })}. ${describe(response)}`
    );
  }
}

/** A failure in the contract's error body, with the request id and, for a 422, the fields named. */
export function expectError(response, statuses, options = {}) {
  const wanted = [].concat(statuses);
  expectStatus(response, ...wanted);
  assert.ok(response.json && typeof response.json === "object", `A failure must answer JSON. ${describe(response)}`);
  assert.ok(response.json.error && typeof response.json.error === "object", `A failure's body must hold an "error" object. ${describe(response)}`);
  assert.equal(typeof response.json.error.code, "string", `error.code must be a string. ${describe(response)}`);
  expectRequestId(response);
  for (const field of options.fields || []) {
    assert.ok(
      response.json.error.errors && typeof response.json.error.errors[field] === "string",
      `A 422 must name the field "${field}" in error.errors. ${describe(response)}`
    );
  }
}

export function expectRetryAfter(response) {
  const value = response.headers.get("Retry-After");
  assert.ok(value, `A 429 must say when to try again in Retry-After. ${describe(response)}`);
  assert.ok(/^\d+$/.test(value) || !Number.isNaN(Date.parse(value)), `Retry-After must be seconds or a date; got "${value}".`);
}

// --- Checks -------------------------------------------------------------------

/**
 * A check the contract requires. `should` marks one it recommends: its
 * failure is reported but does not fail the run unless --strict.
 */
export function check(name, fn) {
  return it(name, fn);
}

export function should(name, fn) {
  return it(`(recommended) ${name}`, settings.strict ? {} : { todo: "recommended, not required" }, fn);
}

/** Skips a whole group when the service does not offer its feature. */
export function offers(feature) {
  return settings.features && settings.features[feature] === true;
}

export function skipUnless(t, condition, reason) {
  if (!condition) {
    t.skip(reason);
    return true;
  }
  return false;
}

// --- Hooks --------------------------------------------------------------------

export const hooks = Boolean(settings.hooksToken);
export const NO_HOOKS = "needs the conformance hooks: pass --hooks-token (see conformance/README.md)";

export async function hook(method, path, options = {}) {
  const response = await request(method, `/_conformance${path}`, {
    ...options,
    origin: null,
    headers: { Authorization: `Bearer ${settings.hooksToken}`, ...(options.headers || {}) }
  });
  assert.ok(response.status < 300, `The conformance hook ${method} ${path} failed. ${describe(response)}`);
  return response.json;
}

export async function reset() {
  if (hooks) {
    await hook("POST", "/reset");
  }
}

/** The Cookie header of a session for a login, from the hooks. */
export async function sessionFor(login) {
  return (await hook("POST", "/session", { body: { login } })).cookie;
}

export async function mailTo(address) {
  return (await hook("GET", `/outbox?to=${encodeURIComponent(address)}`)).messages;
}
