/**
 * Identifiers, keyed hashes and signed tokens, on the Web Crypto API that
 * both Cloudflare Workers and Node provide.
 *
 * One secret, SECRET_KEY, feeds every keyed operation; each use derives its
 * own key from it with a label, so a hash of an address can never be replayed
 * as a session signature.
 */

import { HttpError } from "./http.js";

const encoder = new TextEncoder();
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base64url(bytes) {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/**
 * An identifier that sorts by time: the milliseconds, then randomness.
 * `id("c")` is `c_01j8…`.
 */
export function id(prefix, now = Date.now()) {
  const time = new Uint8Array(6);
  let rest = now;
  for (let index = 5; index >= 0; index -= 1) {
    time[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  const random = crypto.getRandomValues(new Uint8Array(10));
  return `${prefix}_${base32(time)}${base32(random)}`;
}

export function randomToken(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Equal strings, compared in time that does not depend on where they differ. */
export function safeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

const keys = new Map();

async function keyFor(secret, label) {
  const cacheKey = `${label}\u0000${secret}`;
  if (!keys.has(cacheKey)) {
    keys.set(
      cacheKey,
      crypto.subtle.importKey("raw", encoder.encode(`${label}:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign"
      ])
    );
  }
  return keys.get(cacheKey);
}

/** HMAC-SHA-256 of a value under a label's key, as base64url. */
export async function keyedHash(secret, label, value) {
  if (!secret) {
    throw new HttpError(500, "misconfigured", "The service is missing its SECRET_KEY.");
  }
  const key = await keyFor(secret, label);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(value)));
  return base64url(new Uint8Array(signature));
}

/** SHA-256 of a value, for fingerprints that need no secret. */
export async function digest(value) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return base64url(new Uint8Array(hash));
}

/**
 * A token that carries its own claims and a signature: `claims.signature`,
 * both base64url. Used for sessions and for the links in subscription emails,
 * so nothing but the secret has to be stored to check one.
 */
export async function signToken(secret, purpose, claims) {
  const payload = base64url(encoder.encode(JSON.stringify({ ...claims, p: purpose })));
  return `${payload}.${await keyedHash(secret, `token:${purpose}`, payload)}`;
}

/**
 * The claims of a token signed for `purpose`, or null when it is not one: a
 * bad signature, another purpose, or an `exp` (seconds) that has passed.
 * `expired: true` tells a token that was genuine but has run out.
 */
export async function verifyToken(secret, purpose, token, now = Date.now()) {
  const [payload, signature, extra] = String(token || "").split(".");
  if (!payload || !signature || extra !== undefined) {
    return null;
  }
  const expected = await keyedHash(secret, `token:${purpose}`, payload);
  if (!safeEqual(expected, signature)) {
    return null;
  }
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
  } catch {
    return null;
  }
  if (!claims || claims.p !== purpose) {
    return null;
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 < now) {
    return { ...claims, expired: true };
  }
  return claims;
}
