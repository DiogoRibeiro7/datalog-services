/**
 * The service's settings, read from its environment: `[vars]` in
 * wrangler.toml and `wrangler secret put` on Cloudflare, `.dev.vars` or the
 * process environment for the Node server. Everything is a string there, so
 * lists are comma-separated and limits are `count/seconds`.
 */

export const API_VERSION = "1";

/** Every feature of the contract, in the order capabilities lists them. */
export const FEATURES = ["comments", "reactions", "corrections", "contact", "subscriptions", "webmentions", "moderation"];

/** Requests per client address per window, unless RATE_LIMITS says otherwise. */
export const DEFAULT_RATE_LIMITS = {
  read: "600/600",
  comments: "5/600",
  reactions: "20/600",
  corrections: "5/600",
  contact: "3/600",
  subscriptions: "5/600",
  "subscriptions-address": "3/3600",
  "subscriptions-token": "30/600",
  "comment-reports": "5/600",
  moderation: "300/600",
  webmention: "30/3600"
};

export const DEFAULT_LISTS = {
  REACTION_TYPES: "useful,clear,interesting,needs-clarification",
  CORRECTION_CATEGORIES: "mathematical-error,factual-error,citation,code,reproducibility,typo,accessibility,other",
  CONTACT_CATEGORIES: "research-collaboration,consulting,speaking,mentoring,reproducibility,media,other",
  SUBSCRIPTION_TOPICS: ""
};

function list(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function flag(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

/** `5/600` as five requests per 600 seconds. */
export function parseLimit(value) {
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(value));
  if (!match || Number(match[2]) === 0) {
    throw new Error(`A rate limit is written count/seconds, such as 5/600; got "${value}"`);
  }
  return { limit: Number(match[1]), window: Number(match[2]) };
}

/** An origin as the browser sends it: scheme, host and port, no path. */
export function normalizeOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`An allowed origin must be http or https; got "${value}"`);
  }
  return url.origin;
}

/**
 * @param {Object.<string, string>} env
 * @returns {Object} The settings every part of the service reads
 */
export function readConfig(env = {}) {
  const enabled = new Set(list(env.FEATURES).map((name) => name.toLowerCase()));
  const unknown = [...enabled].filter((name) => !FEATURES.includes(name));
  if (unknown.length > 0) {
    throw new Error(`FEATURES names features the service does not have: ${unknown.join(", ")}`);
  }
  const features = Object.fromEntries(FEATURES.map((name) => [name, enabled.has(name)]));

  const allowedOrigins = list(env.ALLOWED_ORIGINS).map(normalizeOrigin);
  const siteUrl = String(env.SITE_URL || allowedOrigins[0] || "").replace(/\/+$/, "");

  const limits = Object.fromEntries(Object.entries(DEFAULT_RATE_LIMITS).map(([name, value]) => [name, parseLimit(value)]));
  for (const entry of list(env.RATE_LIMITS)) {
    const [name, value] = entry.split("=").map((part) => part.trim());
    if (!name || !value) {
      throw new Error(`RATE_LIMITS entries are name=count/seconds; got "${entry}"`);
    }
    limits[name] = parseLimit(value);
  }

  const lists = Object.fromEntries(
    Object.entries(DEFAULT_LISTS).map(([name, fallback]) => [name, list(env[name] ?? fallback)])
  );

  return {
    apiVersion: API_VERSION,
    features,
    allowedOrigins,
    siteUrl,
    rateLimits: limits,
    reactionTypes: lists.REACTION_TYPES,
    correctionCategories: lists.CORRECTION_CATEGORIES,
    contactCategories: lists.CONTACT_CATEGORIES,
    subscriptionTopics: lists.SUBSCRIPTION_TOPICS,
    csrf: env.CSRF_HEADER && env.CSRF_COOKIE ? { header: String(env.CSRF_HEADER), cookie: String(env.CSRF_COOKIE) } : null,
    secretKey: env.SECRET_KEY ? String(env.SECRET_KEY) : "",
    conformanceToken: env.CONFORMANCE_TOKEN ? String(env.CONFORMANCE_TOKEN) : "",
    env
  };
}

export { flag, list };
