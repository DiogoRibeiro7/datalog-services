/**
 * The service as one `fetch(request)` function, on nothing but the Web
 * platform's Request and Response, so the same code runs as a Cloudflare
 * Worker (src/worker.js) and under Node (src/node.js).
 *
 * Every request under /v1 goes through the same steps, in order:
 *
 *   1. a request id, returned as X-Request-Id and in every error body;
 *   2. the origin check: a browser origin not in ALLOWED_ORIGINS is refused;
 *   3. the preflight answer for OPTIONS;
 *   4. the route, and whether its feature is switched on;
 *   5. for a write, the JSON body and the Idempotency-Key, which may answer
 *      from the stored result without running anything;
 *   6. the rate limit of the route's rule;
 *   7. the handler, whose result is stored against the key.
 *
 * Errors of any kind leave as the contract's error body; an unexpected one is
 * logged with the request id and answered with a 500 that says nothing more.
 */

import { API_VERSION, FEATURES, readConfig } from "./config.js";
import { corsHeaders, originAllowed, preflightHeaders } from "./cors.js";
import { HttpError, errorBody, readJsonText, result, toResponse } from "./http.js";
import * as idempotency from "./idempotency.js";
import { consume } from "./ratelimit.js";
import { id, keyedHash } from "./security.js";

const VERSIONED = /^\/v(\d+)(\/.*)?$/;

/** `/moderation/items/:id/actions` as a matcher that returns the params. */
export function compile(pattern) {
  const names = [];
  const source = pattern.replace(/\//g, "\\/").replace(/:([a-z_]+)/g, (_, name) => {
    names.push(name);
    return "([^/]+)";
  });
  const regex = new RegExp(`^${source}$`);
  return (path) => {
    const match = regex.exec(path);
    if (!match) {
      return null;
    }
    return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
  };
}

function capabilities({ config }) {
  return result(200, { api_version: API_VERSION, features: { ...config.features } }, { "Cache-Control": "public, max-age=300" });
}

async function health({ db }) {
  try {
    await db.prepare("SELECT 1 AS ok").first();
  } catch {
    throw new HttpError(503, "database_unavailable", "The service cannot reach its database.");
  }
  return result(200, { status: "ok", api_version: API_VERSION });
}

/** The routes every deployment has; each feature adds its own. */
export const CORE_ROUTES = [
  { method: "GET", path: "/capabilities", handler: capabilities },
  { method: "GET", path: "/health", handler: health }
];

function defaultLog(level, event, fields) {
  const line = JSON.stringify({ level, event, ...fields });
  (level === "error" ? console.error : console.log)(line);
}

/**
 * @param {Object} options
 * @param {Object} options.db - A D1 database (or the node:sqlite shim)
 * @param {Object.<string, string>} [options.env] - The settings, as strings
 * @param {Object[]} [options.routes] - The feature routes under /v1
 * @param {Object[]} [options.rootRoutes] - Routes outside /v1, such as the Webmention receiver
 * @param {Object} [options.services] - Anything the handlers share, such as the mailer
 * @param {Function} [options.now] - The clock, replaceable in tests
 * @param {Function} [options.log] - (level, event, fields), JSON lines by default
 * @returns {{ fetch: Function, config: Object }}
 */
export function createApp(options) {
  const config = options.config || readConfig(options.env);
  const now = options.now || (() => Date.now());
  const log = options.log || defaultLog;
  const routes = [...CORE_ROUTES, ...(options.routes || [])].map((route) => ({ ...route, match: compile(route.path) }));
  const rootRoutes = (options.rootRoutes || []).map((route) => ({ ...route, match: compile(route.path) }));
  for (const route of routes) {
    if (route.feature && !FEATURES.includes(route.feature)) {
      throw new Error(`Route ${route.method} ${route.path} names an unknown feature "${route.feature}"`);
    }
  }

  function find(table, method, path) {
    const matching = table.map((route) => ({ route, params: route.match(path) })).filter((entry) => entry.params);
    if (matching.length === 0) {
      return null;
    }
    const exact = matching.find((entry) => entry.route.method === method);
    if (exact) {
      return exact;
    }
    const allow = [...new Set(matching.map((entry) => entry.route.method)), "OPTIONS"].join(", ");
    throw new HttpError(405, "method_not_allowed", `This address does not take ${method}.`, { headers: { Allow: allow } });
  }

  async function run(entry, request, url, context, requestId, trace) {
    const { route, params } = entry;
    trace.route = `${route.method} ${route.path}`;
    if (route.feature && !config.features[route.feature]) {
      throw new HttpError(404, "feature_off", `This service does not offer ${route.feature}.`);
    }
    const time = now();
    let clientKeyValue = null;
    const ctx = {
      request,
      url,
      params,
      query: url.searchParams,
      config,
      db: options.db,
      services: options.services || {},
      requestId,
      now: time,
      log,
      waitUntil: context.waitUntil || ((promise) => promise.catch((error) => log("error", "background_failed", { requestId, error: String(error) }))),
      clientIp: context.clientIp || "unknown",
      async clientKey() {
        clientKeyValue = clientKeyValue || (await keyedHash(config.secretKey, "client", ctx.clientIp));
        return clientKeyValue;
      }
    };

    let key = null;
    let scope = null;
    if (route.write) {
      const text = await request.text();
      ctx.rawBody = text;
      ctx.body = route.body === "none" ? null : readJsonText(request, text, route.body === "optional");
      key = idempotency.readKey(request);
      if (key) {
        scope = `${route.method} ${url.pathname}`;
        const claimed = await idempotency.claim(options.db, key, scope, text, time);
        if (claimed.replay) {
          return { ...claimed.replay, headers: { "Idempotent-Replayed": "true" } };
        }
      }
    }

    try {
      if (route.limit !== null) {
        await consume(options.db, config, route.limit || (route.write ? route.feature : "read"), await ctx.clientKey(), time);
      }
      const outcome = await route.handler(ctx);
      if (key) {
        await idempotency.complete(options.db, key, scope, outcome);
      }
      return outcome;
    } catch (error) {
      if (key) {
        if (error instanceof HttpError && error.status < 500 && error.status !== 429) {
          await idempotency.complete(options.db, key, scope, { status: error.status, body: errorBody(error, requestId) });
        } else {
          await idempotency.release(options.db, key, scope);
        }
      }
      throw error;
    }
  }

  async function dispatch(request, url, context, requestId, origin, trace) {
    const versioned = VERSIONED.exec(url.pathname);
    if (!versioned) {
      const entry = find(rootRoutes, request.method, url.pathname);
      if (!entry) {
        throw new HttpError(404, "not_found", "There is nothing at this address.");
      }
      return run(entry, request, url, context, requestId, trace);
    }
    if (versioned[1] !== API_VERSION) {
      throw new HttpError(404, "unsupported_version", `This service speaks API version ${API_VERSION}.`);
    }
    if (!originAllowed(config, origin)) {
      throw new HttpError(403, "origin_not_allowed", "This origin may not call the service.");
    }
    const path = versioned[2] || "/";
    if (request.method === "OPTIONS") {
      return result(204, undefined, origin ? preflightHeaders(config) : { Allow: "GET, POST, PATCH, DELETE, OPTIONS" });
    }
    const entry = find(routes, request.method, path);
    if (!entry) {
      throw new HttpError(404, "not_found", "There is nothing at this address.");
    }
    return run(entry, request, url, context, requestId, trace);
  }

  async function fetch(request, context = {}) {
    const started = now();
    const requestId = id("req", started);
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const headers = { "X-Request-Id": requestId, ...corsHeaders(config, origin) };
    // The route's pattern is logged, never the path: a subscription's path holds its token.
    const trace = { route: null };
    let response;
    try {
      response = toResponse(await dispatch(request, url, context, requestId, origin, trace), headers);
    } catch (error) {
      const known = error instanceof HttpError;
      if (!known) {
        log("error", "unexpected_error", { requestId, route: trace.route, error: error?.stack || String(error) });
      }
      const failure = known ? error : new HttpError(500, "internal", "The service ran into a problem.");
      response = toResponse({ status: failure.status, body: errorBody(failure, requestId), headers: failure.headers }, headers);
    }
    log("info", "request", { requestId, method: request.method, route: trace.route, status: response.status, ms: now() - started });
    return response;
  }

  return { fetch, config };
}
