/**
 * Newsletter subscriptions, with double opt-in.
 *
 *   POST   /v1/subscriptions            { email, topics?, source_url?, locale? } → 202 { status: "pending" }
 *   POST   /v1/subscriptions/confirm    { token } → 200 { status: "confirmed" }
 *   GET    /v1/subscriptions/:token     → 200 { status, topics }
 *   PATCH  /v1/subscriptions/:token     { topics } → 200 { status, topics }
 *   DELETE /v1/subscriptions/:token     → 204
 *   POST   /mail/unsubscribe/:token     RFC 8058 one-click, for mail clients
 *
 * The links in the emails carry signed tokens (src/security.js): a confirm
 * token that expires in two days, and a manage token that lasts until the
 * subscriber leaves. Both name the subscriber and a version; unsubscribing
 * raises the version, so every earlier link stops working (410). Nothing
 * about a token is stored.
 *
 * Whether an address is already subscribed is not disclosed by default: a
 * second sign-up answers 202 like the first and mails the subscriber their
 * link instead. SUBSCRIPTIONS_DISCLOSE=true answers 409, which the theme
 * shows as "already subscribed".
 */

import { flag } from "../config.js";
import { HttpError, result } from "../http.js";
import { consume } from "../ratelimit.js";
import { id, keyedHash, signToken, verifyToken } from "../security.js";
import { Fields } from "../validate.js";

const CONFIRM_SECONDS = 2 * 24 * 60 * 60;
const RESEND_AFTER_MS = 5 * 60 * 1000;

function siteName(config) {
  return config.env.SITE_NAME || (config.siteUrl ? new URL(config.siteUrl).host : "the site");
}

function pageUrl(config, query) {
  const page = config.env.SUBSCRIPTIONS_PAGE || "/subscriptions/";
  return `${config.siteUrl}${page.startsWith("/") ? page : `/${page}`}?${query}`;
}

function topicsOf(row) {
  try {
    const topics = JSON.parse(row.topics || "[]");
    return Array.isArray(topics) ? topics : [];
  } catch {
    return [];
  }
}

async function linksFor(config, row, baseUrl) {
  const manage = await signToken(config.secretKey, "manage", { sub: row.id, v: row.token_version });
  return {
    manage: pageUrl(config, `manage=${manage}`),
    unsubscribe: pageUrl(config, `unsubscribe=${manage}`),
    oneClick: `${baseUrl}/mail/unsubscribe/${manage}`
  };
}

async function sendConfirmation(ctx, row) {
  const token = await signToken(ctx.config.secretKey, "confirm", {
    sub: row.id,
    v: row.token_version,
    exp: Math.floor(ctx.now / 1000) + CONFIRM_SECONDS
  });
  await ctx.services.mailer.send({
    to: row.email,
    subject: `Confirm your subscription to ${siteName(ctx.config)}`,
    text: [
      `Someone, hopefully you, asked to receive emails from ${siteName(ctx.config)} at this address.`,
      "",
      `Confirm within two days: ${pageUrl(ctx.config, `confirm=${token}`)}`,
      "",
      "If it was not you, ignore this email: nothing is sent until the address is confirmed."
    ].join("\n")
  });
  // Only once it has gone: a sign-up whose mail failed sends it again on the retry.
  await ctx.db.prepare("UPDATE subscribers SET last_mailed_at = ?2 WHERE id = ?1").bind(row.id, new Date(ctx.now).toISOString()).run();
}

async function sendLinks(ctx, row, opening) {
  const links = await linksFor(ctx.config, row, ctx.url.origin);
  await ctx.services.mailer.send({
    to: row.email,
    subject: `Your subscription to ${siteName(ctx.config)}`,
    text: [opening, "", `Change what you receive: ${links.manage}`, `Unsubscribe: ${links.unsubscribe}`].join("\n"),
    headers: { "List-Unsubscribe": `<${links.oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
  });
}

function readTopics(fields, config, rules = {}) {
  if (config.subscriptionTopics.length > 0) {
    return fields.subset("topics", config.subscriptionTopics, { nonEmpty: true, ...rules });
  }
  const raw = fields.input.topics;
  if (raw === undefined && rules.required) {
    return fields.fail("topics", "Required.");
  }
  if (raw !== undefined && (!Array.isArray(raw) || raw.some((topic) => typeof topic !== "string" || topic.length > 60))) {
    return fields.fail("topics", "Must be a list of topics.");
  }
  return raw === undefined ? undefined : [...new Set(raw)];
}

async function subscribe(ctx) {
  const { db, body, config, now } = ctx;
  const fields = new Fields(body);
  const email = fields.email("email", { required: true });
  const topics = readTopics(fields, config);
  const locale = fields.text("locale", { max: 20 });
  const sourceUrl = fields.url("source_url");
  fields.done();

  // A second allowance per address, so the form cannot be used to flood someone's inbox.
  await consume(db, config, "subscriptions-address", await keyedHash(config.secretKey, "email", email), now);

  const stamp = new Date(now).toISOString();
  let row = await db.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first();
  const doubleOptIn = flag(config.env.SUBSCRIPTIONS_DOUBLE_OPT_IN, true);

  if (row && row.status === "confirmed") {
    if (flag(config.env.SUBSCRIPTIONS_DISCLOSE, false)) {
      throw new HttpError(409, "already_subscribed", "This address is already subscribed.");
    }
    await sendLinks(ctx, row, `This address is already subscribed to ${siteName(config)}.`);
    return result(202, { status: "pending" });
  }

  if (row) {
    const resend = row.status === "unsubscribed" || !row.last_mailed_at || now - Date.parse(row.last_mailed_at) > RESEND_AFTER_MS;
    const version = row.status === "unsubscribed" ? row.token_version + 1 : row.token_version;
    await db
      .prepare(
        "UPDATE subscribers SET status = 'pending', topics = ?2, locale = ?3, source_url = ?4, token_version = ?5, unsubscribed_at = NULL WHERE id = ?1"
      )
      .bind(row.id, JSON.stringify(topics || topicsOf(row)), locale || row.locale, sourceUrl || row.source_url, version)
      .run();
    row = { ...row, status: "pending", token_version: version };
    if (!doubleOptIn) {
      return confirmNow(ctx, row);
    }
    if (resend) {
      await sendConfirmation(ctx, row);
    }
    return result(202, { status: "pending" });
  }

  row = { id: id("s", now), email, token_version: 1, status: "pending" };
  await db
    .prepare(
      "INSERT INTO subscribers (id, email, status, topics, locale, source_url, token_version, created_at) " +
        "VALUES (?1, ?2, 'pending', ?3, ?4, ?5, 1, ?6)"
    )
    .bind(row.id, email, JSON.stringify(topics || []), locale || null, sourceUrl || null, stamp)
    .run();
  if (!doubleOptIn) {
    return confirmNow(ctx, row);
  }
  await sendConfirmation(ctx, row);
  return result(202, { status: "pending" });
}

async function confirmNow(ctx, row) {
  await ctx.db
    .prepare("UPDATE subscribers SET status = 'confirmed', confirmed_at = ?2 WHERE id = ?1")
    .bind(row.id, new Date(ctx.now).toISOString())
    .run();
  await sendLinks(ctx, { ...row, status: "confirmed" }, `You are subscribed to ${siteName(ctx.config)}.`);
  return result(201, { status: "confirmed" });
}

/** The subscriber a token stands for, or the 404 or 410 the theme reads as "not valid any more". */
async function subscriberFor(ctx, purpose, token) {
  const claims = await verifyToken(ctx.config.secretKey, purpose, token, ctx.now);
  if (!claims) {
    throw new HttpError(404, "invalid_token", "This link is not valid.");
  }
  if (claims.expired) {
    throw new HttpError(410, "token_expired", "This link has expired.");
  }
  const row = await ctx.db.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(claims.sub).first();
  if (!row || row.token_version !== claims.v || row.status === "unsubscribed") {
    throw new HttpError(410, "token_expired", "This link is not valid any more.");
  }
  return row;
}

async function confirm(ctx) {
  const fields = new Fields(ctx.body);
  const token = fields.text("token", { required: true, max: 1000 });
  fields.done();
  const row = await subscriberFor(ctx, "confirm", token);
  if (row.status !== "confirmed") {
    await confirmNow(ctx, row);
  }
  return result(200, { status: "confirmed" });
}

async function show(ctx) {
  const row = await subscriberFor(ctx, "manage", ctx.params.token);
  return result(200, { status: row.status, topics: topicsOf(row) });
}

async function update(ctx) {
  const row = await subscriberFor(ctx, "manage", ctx.params.token);
  const fields = new Fields(ctx.body);
  const topics = readTopics(fields, ctx.config, { required: true });
  fields.done();
  await ctx.db.prepare("UPDATE subscribers SET topics = ?2 WHERE id = ?1").bind(row.id, JSON.stringify(topics || [])).run();
  return result(200, { status: row.status, topics: topics || [] });
}

async function unsubscribe(ctx) {
  const row = await subscriberFor(ctx, "manage", ctx.params.token);
  await ctx.db
    .prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?2, token_version = token_version + 1 WHERE id = ?1")
    .bind(row.id, new Date(ctx.now).toISOString())
    .run();
  return result(204);
}

/** RFC 8058: a mail client's one-click POST. Answers plain success whatever the token, so it cannot be probed. */
async function oneClick(ctx) {
  try {
    await unsubscribe(ctx);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status >= 500) {
      throw error;
    }
  }
  return result(200, { status: "unsubscribed" });
}

export const routes = [
  { method: "POST", path: "/subscriptions", feature: "subscriptions", write: true, handler: subscribe },
  { method: "POST", path: "/subscriptions/confirm", feature: "subscriptions", write: true, limit: "subscriptions-token", handler: confirm },
  { method: "GET", path: "/subscriptions/:token", feature: "subscriptions", limit: "subscriptions-token", handler: show },
  { method: "PATCH", path: "/subscriptions/:token", feature: "subscriptions", write: true, limit: "subscriptions-token", handler: update },
  { method: "DELETE", path: "/subscriptions/:token", feature: "subscriptions", write: true, body: "none", limit: "subscriptions-token", handler: unsubscribe }
];

export const rootRoutes = [
  { method: "POST", path: "/mail/unsubscribe/:token", feature: "subscriptions", write: true, body: "none", limit: "subscriptions-token", handler: oneClick }
];
