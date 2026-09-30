/**
 * Test hooks for the conformance suite, and nothing else. They exist only
 * when CONFORMANCE_TOKEN is set, and every call must carry it as a bearer
 * token; without the setting the routes answer 404 like any address the
 * service does not have. Never set CONFORMANCE_TOKEN on a deployment that
 * holds real data: `reset` deletes everything.
 *
 *   POST /_conformance/reset                  empties every table
 *   POST /_conformance/session { login }      { cookie }: a signed-in session, as GitHub's sign-in would give
 *   GET  /_conformance/outbox?to=<address>    { messages }: what MAIL_PROVIDER=outbox kept
 *   POST /_conformance/webmentions { ... }    stores a verified mention, as the receiver would after checking it
 *
 * A third-party implementation may offer the same four and let the suite run
 * every check; without them, the checks that need one are skipped and say so.
 */

import { sessionCookies } from "../auth.js";
import { HttpError, result } from "../http.js";
import { id, safeEqual } from "../security.js";
import { Fields } from "../validate.js";

function guard({ config, request }) {
  if (!config.conformanceToken) {
    throw new HttpError(404, "not_found", "There is nothing at this address.");
  }
  const sent = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(sent, config.conformanceToken)) {
    throw new HttpError(401, "unauthorized", "The conformance token is missing or wrong.");
  }
}

async function reset(ctx) {
  guard(ctx);
  const { results } = await ctx.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'")
    .all();
  await ctx.db.batch(results.map((row) => ctx.db.prepare(`DELETE FROM "${row.name.replace(/"/g, '""')}"`)));
  return result(204);
}

async function session(ctx) {
  guard(ctx);
  const fields = new Fields(ctx.body);
  const login = fields.text("login", { required: true, max: 100 });
  fields.done();
  const cookies = await sessionCookies(ctx.config, login, ctx.now);
  return result(200, { cookie: cookies.map((line) => line.split(";")[0]).join("; ") });
}

async function outbox(ctx) {
  guard(ctx);
  const to = String(ctx.query.get("to") || "").toLowerCase();
  const { results } = await ctx.db
    .prepare("SELECT to_address, reply_to, subject, text, headers, created_at FROM outbox WHERE to_address = ?1 ORDER BY created_at, id")
    .bind(to)
    .all();
  return result(200, {
    messages: results.map((row) => ({ to: row.to_address, reply_to: row.reply_to, subject: row.subject, text: row.text, headers: JSON.parse(row.headers), created_at: row.created_at }))
  });
}

async function seedWebmention(ctx) {
  guard(ctx);
  const body = ctx.body;
  const fields = new Fields(body);
  const source = fields.url("source", { required: true });
  const target = fields.url("target", { required: true });
  const type = fields.oneOf("type", ["mention", "reply", "repost", "like"]) || "mention";
  const title = fields.text("title", { max: 200 });
  const excerpt = fields.text("excerpt", { max: 280 });
  const publishedAt = fields.text("published_at", { max: 40 });
  const author = body.author && typeof body.author === "object" ? body.author : {};
  const authorName = fields.text("author", { from: author.name, max: 100 });
  const authorUrl = fields.url("author", { from: author.url });
  fields.done();
  const mentionId = id("wm", ctx.now);
  const stamp = new Date(ctx.now).toISOString();
  await ctx.db
    .prepare(
      "INSERT INTO webmentions (id, source, target, type, author_name, author_url, title, excerpt, published_at, status, received_at, verified_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'verified', ?10, ?10)"
    )
    .bind(mentionId, source, target, type, authorName || null, authorUrl || null, title || null, excerpt || null, publishedAt || null, stamp)
    .run();
  return result(201, { id: mentionId });
}

export const rootRoutes = [
  { method: "POST", path: "/_conformance/reset", write: true, body: "none", limit: null, handler: reset },
  { method: "POST", path: "/_conformance/session", write: true, limit: null, handler: session },
  { method: "GET", path: "/_conformance/outbox", limit: null, handler: outbox },
  { method: "POST", path: "/_conformance/webmentions", write: true, limit: null, handler: seedWebmention }
];
