/**
 * Cross-origin rules. The site's pages call the service from the site's
 * origin, so every answer to an allowed origin names that origin exactly
 * (never `*`) and allows credentials, which the moderation inbox needs for its
 * session cookie. A request from any other origin is refused outright rather
 * than answered without the headers: that stops a page elsewhere from writing
 * to the service through a reader's browser, which CORS alone would not.
 */

export const ALLOWED_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
export const EXPOSED_HEADERS = "X-Request-Id, Retry-After";

/** Whether an Origin header may call the service. No Origin: not a browser's cross-origin call. */
export function originAllowed(config, origin) {
  return !origin || config.allowedOrigins.includes(origin);
}

/** The headers every answer to an allowed browser origin carries. */
export function corsHeaders(config, origin) {
  const headers = { Vary: "Origin" };
  if (origin && config.allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Access-Control-Expose-Headers"] = EXPOSED_HEADERS;
  }
  return headers;
}

/** What a preflight is told: the methods and headers the theme's client sends. */
export function preflightHeaders(config) {
  const allowed = ["Content-Type", "Idempotency-Key", "Accept"];
  if (config.csrf) {
    allowed.push(config.csrf.header);
  }
  return {
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": allowed.join(", "),
    "Access-Control-Max-Age": "600"
  };
}
