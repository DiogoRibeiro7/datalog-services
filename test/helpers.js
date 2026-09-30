/**
 * An app over a fresh in-memory database with the migrations applied, and a
 * way to call it the way a browser on the site would.
 */

import { createApp } from "../src/app.js";
import { createService } from "../src/service.js";
import { migrate } from "../src/store/migrate.js";
import { openDatabase } from "../src/store/sqlite-d1.js";

export const SITE = "https://site.example";

export const BASE_ENV = {
  ALLOWED_ORIGINS: SITE,
  SECRET_KEY: "test-secret-key-that-is-long-enough",
  FEATURES: ""
};

export async function freshDb() {
  const db = openDatabase(":memory:");
  await migrate(db);
  return db;
}

/** A clock the test moves by hand. */
export function clock(start = Date.parse("2026-09-30T12:00:00Z")) {
  let time = start;
  const now = () => time;
  now.advance = (ms) => {
    time += ms;
  };
  return now;
}

/**
 * @param {Object} [options] - `env` over BASE_ENV; `routes` for createApp alone, else the whole service
 */
export async function makeApp(options = {}) {
  const db = options.db || (await freshDb());
  const logs = [];
  const settings = {
    ...options,
    db,
    env: { ...BASE_ENV, ...(options.env || {}) },
    log: (level, event, fields) => logs.push({ level, event, ...fields })
  };
  const inner = options.routes ? createApp(settings) : createService(settings);
  // Work a handler hands to waitUntil, such as verifying a Webmention, is kept so a test can wait for it.
  const pending = [];
  const app = {
    config: inner.config,
    fetch: (request, context = {}) => inner.fetch(request, { waitUntil: (promise) => pending.push(promise), ...context })
  };
  const settle = async () => {
    while (pending.length > 0) {
      await pending.shift();
    }
  };
  return { app, db, logs, settle };
}

/**
 * Calls the app. `origin` defaults to the site; pass null for a request with
 * no Origin, as a server makes. A `body` object is sent as JSON.
 */
export async function call(app, method, path, options = {}) {
  const headers = new Headers(options.headers || {});
  const origin = options.origin === undefined ? SITE : options.origin;
  if (origin) {
    headers.set("Origin", origin);
  }
  let body = options.raw;
  if (options.body !== undefined) {
    headers.set("Content-Type", headers.get("Content-Type") || "application/json");
    body = JSON.stringify(options.body);
  }
  const request = new Request(`https://api.example${path}`, { method, headers, body });
  const response = await app.fetch(request, { clientIp: options.ip || "203.0.113.7" });
  if (options.settle) {
    await options.settle();
  }
  const text = await response.text();
  let json = null;
  if (text) {
    json = JSON.parse(text);
  }
  return { status: response.status, headers: response.headers, json, text };
}
