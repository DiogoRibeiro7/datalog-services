/**
 * Fixed-window rate limits kept in the database, so every instance of the
 * service counts against the same numbers. A bucket is a rule and a client
 * key (a keyed hash of the address, never the address); the rules are
 * `config.rateLimits`, overridable with RATE_LIMITS.
 */

import { HttpError } from "./http.js";

const CONSUME = `
  INSERT INTO rate_limits (bucket, window_start, count) VALUES (?1, ?2, 1)
  ON CONFLICT(bucket) DO UPDATE SET
    count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
    window_start = excluded.window_start
  RETURNING count, window_start`;

/**
 * Counts one request against a rule, or throws a 429 with Retry-After in
 * seconds once the window's allowance is spent.
 * @param {Object} db - A D1 database, or the shim over node:sqlite
 * @param {Object} config
 * @param {string} rule - A key of config.rateLimits
 * @param {string} subject - Who is counted: a client key, or a hashed address
 * @param {number} [now]
 */
export async function consume(db, config, rule, subject, now = Date.now()) {
  const limits = config.rateLimits[rule];
  if (!limits) {
    return;
  }
  const windowMs = limits.window * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare(CONSUME).bind(`${rule}:${subject}`, windowStart).first();
  if (row && row.count > limits.limit) {
    const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
    throw new HttpError(429, "rate_limited", "Too many requests. Wait a little and try again.", {
      headers: { "Retry-After": String(retryAfter) }
    });
  }
}

/** Removes the windows that have ended, for the scheduled clean-up. */
export async function purge(db, now = Date.now(), maxWindowSeconds = 86400) {
  await db.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(now - maxWindowSeconds * 1000).run();
}
