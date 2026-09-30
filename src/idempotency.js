/**
 * Idempotency keys, after the IETF draft "The Idempotency-Key HTTP Header
 * Field". A write that carries `Idempotency-Key` is performed once: a retry
 * with the same key and the same body gets the first answer again, marked
 * `Idempotent-Replayed: true`; the same key with another body is a 422; a
 * retry that arrives while the first is still running is a 409. Keys are kept
 * for a day, per method and path, so one key cannot reach another route.
 */

import { HttpError } from "./http.js";
import { digest } from "./security.js";

export const TTL_MS = 24 * 60 * 60 * 1000;
const KEY = /^[\x21-\x7e]{1,255}$/;

/** The header's value, checked; null without one. */
export function readKey(request) {
  const key = request.headers.get("Idempotency-Key");
  if (key === null) {
    return null;
  }
  if (!KEY.test(key)) {
    throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 1 to 255 visible ASCII characters.");
  }
  return key;
}

/**
 * Claims a key for this request. Resolves `{ replay }` with the stored answer
 * when the same request was already answered, `{ claimed: true }` when this
 * request should run; throws for a reused key or one still in flight.
 */
export async function claim(db, key, scope, bodyText, now = Date.now()) {
  const fingerprint = await digest(bodyText);
  await db
    .prepare("DELETE FROM idempotency_keys WHERE key = ?1 AND scope = ?2 AND created_at < ?3")
    .bind(key, scope, now - TTL_MS)
    .run();
  const inserted = await db
    .prepare(
      "INSERT INTO idempotency_keys (key, scope, fingerprint, state, created_at) VALUES (?1, ?2, ?3, 'running', ?4) " +
        "ON CONFLICT(key, scope) DO NOTHING"
    )
    .bind(key, scope, fingerprint, now)
    .run();
  if (inserted.meta.changes === 1) {
    return { claimed: true };
  }
  const row = await db
    .prepare("SELECT fingerprint, state, status, body FROM idempotency_keys WHERE key = ?1 AND scope = ?2")
    .bind(key, scope)
    .first();
  if (!row) {
    return claim(db, key, scope, bodyText, now);
  }
  if (row.fingerprint !== fingerprint) {
    throw new HttpError(422, "idempotency_key_reused", "This Idempotency-Key was already used for a different request.");
  }
  if (row.state !== "done") {
    throw new HttpError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed.");
  }
  return { replay: { status: row.status, body: row.body === null ? undefined : JSON.parse(row.body) } };
}

/** Stores the answer, so a retry gets it back. */
export async function complete(db, key, scope, outcome) {
  await db
    .prepare("UPDATE idempotency_keys SET state = 'done', status = ?3, body = ?4 WHERE key = ?1 AND scope = ?2")
    .bind(key, scope, outcome.status, outcome.body === undefined ? null : JSON.stringify(outcome.body))
    .run();
}

/** Lets the key go: the request failed in a way a retry may not repeat. */
export async function release(db, key, scope) {
  await db.prepare("DELETE FROM idempotency_keys WHERE key = ?1 AND scope = ?2").bind(key, scope).run();
}

export async function purge(db, now = Date.now()) {
  await db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?1").bind(now - TTL_MS).run();
}
