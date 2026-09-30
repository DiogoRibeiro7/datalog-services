/**
 * Moderators sign in with GitHub, and the service keeps them signed in with a
 * cookie it signs itself. The theme's moderation page protects nothing; this
 * is where the protection is (docs/moderation.md in the theme).
 *
 *   GET  /auth/login?return_to=<page>   → GitHub, then back to the page
 *   GET  /auth/callback                 GitHub's redirect: the session starts here
 *   POST /auth/logout                   ends it
 *
 * Anyone with a GitHub account can sign in; only the logins in MODERATORS
 * may moderate, and everyone else gets the 403 the inbox shows as "may not
 * moderate". The session is `HttpOnly; Secure`, eight hours by default
 * (SESSION_HOURS), and `SameSite=None` unless COOKIE_SAMESITE says otherwise,
 * since the site and the service are usually on different domains.
 *
 * Settings: GITHUB_CLIENT_ID, the GITHUB_CLIENT_SECRET secret, MODERATORS,
 * and, when the service shares a registrable domain with the site,
 * COOKIE_DOMAIN and COOKIE_SAMESITE=Lax.
 */

import { HttpError, result } from "./http.js";
import { randomToken, safeEqual, signToken, verifyToken } from "./security.js";

export const SESSION_COOKIE = "datalog_session";
const STATE_COOKIE = "datalog_oauth_state";
const STATE_SECONDS = 10 * 60;

export function readCookies(request) {
  const cookies = {};
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return cookies;
}

function cookie(config, name, value, options = {}) {
  const sameSite = config.env.COOKIE_SAMESITE || "None";
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "Secure", `SameSite=${options.sameSite || sameSite}`];
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (config.env.COOKIE_DOMAIN && options.domain !== false) {
    parts.push(`Domain=${config.env.COOKIE_DOMAIN}`);
  }
  parts.push(`Max-Age=${options.maxAge ?? 0}`);
  return parts.join("; ");
}

export function moderators(config) {
  return String(config.env.MODERATORS || "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
}

function sessionSeconds(config) {
  const hours = Number(config.env.SESSION_HOURS || 8);
  return Math.round((Number.isFinite(hours) && hours > 0 ? hours : 8) * 3600);
}

/** The cookies that start a session for a login: the session, and the CSRF token when configured. */
export async function sessionCookies(config, login, now) {
  const maxAge = sessionSeconds(config);
  const token = await signToken(config.secretKey, "session", { login, exp: Math.floor(now / 1000) + maxAge });
  const cookies = [cookie(config, SESSION_COOKIE, token, { maxAge })];
  if (config.csrf) {
    // Readable by the site's script, which sends it back in the header: the double-submit pattern.
    cookies.push(cookie(config, config.csrf.cookie, randomToken(24), { maxAge, httpOnly: false }));
  }
  return cookies;
}

/**
 * The moderator a request comes from. No valid session is a 401, a session
 * whose login is not a moderator a 403. For a write, the request must also
 * come from the site (its Origin) and, with CSRF_HEADER and CSRF_COOKIE set,
 * echo the CSRF cookie in the header; otherwise it is a 403 `csrf_failed`.
 */
export async function requireModerator(ctx, { write = false } = {}) {
  const { request, config, now } = ctx;
  const cookies = readCookies(request);
  const claims = await verifyToken(config.secretKey, "session", cookies[SESSION_COOKIE], now);
  if (!claims || claims.expired || typeof claims.login !== "string") {
    throw new HttpError(401, "unauthorized", "Sign in to moderate.");
  }
  if (!moderators(config).includes(claims.login.toLowerCase())) {
    throw new HttpError(403, "forbidden", "This account may not moderate.");
  }
  if (write) {
    const origin = request.headers.get("Origin");
    if (!origin || !config.allowedOrigins.includes(origin)) {
      throw new HttpError(403, "csrf_failed", "The request did not come from the site.");
    }
    if (config.csrf) {
      const sent = request.headers.get(config.csrf.header) || "";
      const expected = cookies[config.csrf.cookie] || "";
      if (!expected || !safeEqual(sent, expected)) {
        throw new HttpError(403, "csrf_failed", "The request's CSRF token does not match.");
      }
    }
  }
  return claims.login;
}

function returnTo(config, value) {
  const fallback = `${config.siteUrl}/admin/moderation/`;
  if (!value) {
    return fallback;
  }
  try {
    const url = new URL(value);
    return config.allowedOrigins.includes(url.origin) ? url.href : null;
  } catch {
    return null;
  }
}

function redirect(location, cookies = []) {
  return result(302, undefined, { Location: location, "Set-Cookie": cookies });
}

function requireOAuth(config) {
  if (!config.env.GITHUB_CLIENT_ID || !config.env.GITHUB_CLIENT_SECRET) {
    throw new HttpError(500, "misconfigured", "Sign-in is not set up: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are missing.");
  }
}

async function login(ctx) {
  const { config, query, url, now } = ctx;
  requireOAuth(config);
  const target = returnTo(config, query.get("return_to"));
  if (!target) {
    throw new HttpError(400, "invalid", "return_to must be a page of the site.");
  }
  const nonce = randomToken(16);
  const state = await signToken(config.secretKey, "oauth-state", { rt: target, n: nonce, exp: Math.floor(now / 1000) + STATE_SECONDS });
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", config.env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");
  // The state is tied to this browser: GitHub's redirect must come back with the cookie it was issued with.
  return redirect(authorize.href, [cookie(config, STATE_COOKIE, nonce, { maxAge: STATE_SECONDS, sameSite: "Lax", domain: false })]);
}

async function callback(ctx) {
  const { config, query, url, request, now, services } = ctx;
  requireOAuth(config);
  const state = await verifyToken(config.secretKey, "oauth-state", query.get("state"), now);
  const nonce = readCookies(request)[STATE_COOKIE];
  if (!state || state.expired || !nonce || !safeEqual(state.n, nonce)) {
    throw new HttpError(400, "invalid_state", "The sign-in could not be verified. Start again.");
  }
  const code = query.get("code");
  if (!code) {
    throw new HttpError(400, "invalid", "GitHub did not send a code.");
  }
  const fetchImpl = services.fetch || ((...args) => globalThis.fetch(...args));
  const exchange = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.env.GITHUB_CLIENT_ID,
      client_secret: config.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/auth/callback`
    })
  });
  const grant = exchange.ok ? await exchange.json() : null;
  if (!grant || !grant.access_token) {
    throw new HttpError(502, "sign_in_failed", "GitHub did not confirm the sign-in.");
  }
  const profile = await fetchImpl("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${grant.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "datalog-services" }
  });
  const user = profile.ok ? await profile.json() : null;
  if (!user || typeof user.login !== "string") {
    throw new HttpError(502, "sign_in_failed", "GitHub did not say who signed in.");
  }
  const cookies = await sessionCookies(config, user.login, now);
  cookies.push(cookie(config, STATE_COOKIE, "", { maxAge: 0, sameSite: "Lax", domain: false }));
  return redirect(state.rt, cookies);
}

async function logout(ctx) {
  const origin = ctx.request.headers.get("Origin");
  if (origin && !ctx.config.allowedOrigins.includes(origin)) {
    throw new HttpError(403, "csrf_failed", "The request did not come from the site.");
  }
  const cookies = [cookie(ctx.config, SESSION_COOKIE, "", { maxAge: 0 })];
  if (ctx.config.csrf) {
    cookies.push(cookie(ctx.config, ctx.config.csrf.cookie, "", { maxAge: 0, httpOnly: false }));
  }
  return result(204, undefined, { "Set-Cookie": cookies });
}

export const rootRoutes = [
  { method: "GET", path: "/auth/login", feature: "moderation", limit: "moderation", handler: login },
  { method: "GET", path: "/auth/callback", feature: "moderation", limit: "moderation", handler: callback },
  { method: "POST", path: "/auth/logout", feature: "moderation", write: true, body: "none", limit: "moderation", handler: logout }
];
