/**
 * Comments (the theme's `api` provider): a thread per page path, read by
 * everyone, written by readers, and published only once a moderator approves
 * unless COMMENTS_MODERATION=false.
 *
 *   GET  /v1/comments?path=/2024/04/07/post/   approved comments, oldest first
 *   POST /v1/comments                          { path, parent_id?, author: { name, email?, url? }, body }
 *   POST /v1/comments/:id/reports              { reason }: a reader reports a published comment
 *
 * The reply's parent must be an approved comment of the same page. An email
 * is kept only as a keyed hash and never returned; nothing about the author
 * but the name and website leaves the service.
 */

import { flag } from "../config.js";
import { HttpError, result } from "../http.js";
import { id, keyedHash } from "../security.js";
import { Fields, countLinks, requirePath } from "../validate.js";

export const MAX_BODY = 5000;

/** The public shape of a stored row. */
export function publicComment(row) {
  const comment = {
    id: row.id,
    parent_id: row.parent_id ?? null,
    author: { name: row.author_name },
    body: row.body,
    created_at: row.created_at
  };
  if (row.author_url) {
    comment.author.url = row.author_url;
  }
  return comment;
}

async function list({ db, query }) {
  const path = requirePath(query);
  const { results } = await db
    .prepare(
      "SELECT id, parent_id, author_name, author_url, body, created_at FROM comments " +
        "WHERE path = ?1 AND status = 'approved' ORDER BY created_at, id"
    )
    .bind(path)
    .all();
  return result(200, { comments: results.map(publicComment) });
}

async function create({ db, body, config, now }) {
  const fields = new Fields(body);
  const path = fields.path("path", { required: true });
  const author = body.author && typeof body.author === "object" && !Array.isArray(body.author) ? body.author : {};
  const name = fields.text("name", { from: author.name, required: true, max: 80 });
  const email = fields.email("email", { from: author.email });
  const url = fields.url("url", { from: author.url, max: 500 });
  const text = fields.text("body", { required: true, min: 3, max: MAX_BODY, multiline: true });
  const parentId = fields.text("parent_id", { max: 64 });
  const maxLinks = Number(config.env.COMMENTS_MAX_LINKS ?? 2);
  if (text !== undefined && countLinks(text) > maxLinks) {
    fields.fail("body", maxLinks === 0 ? "Links are not allowed." : `At most ${maxLinks} links.`);
  }
  fields.done();

  if (parentId) {
    const parent = await db
      .prepare("SELECT 1 AS found FROM comments WHERE id = ?1 AND path = ?2 AND status = 'approved'")
      .bind(parentId, path)
      .first();
    if (!parent) {
      throw new HttpError(422, "invalid", "The comment being replied to is not on this page.", {
        errors: { parent_id: "The comment being replied to is not on this page." }
      });
    }
  }

  const held = flag(config.env.COMMENTS_MODERATION, true);
  const row = {
    id: id("c", now),
    path,
    parent_id: parentId || null,
    author_name: name,
    author_url: url || null,
    author_email_hash: email ? await keyedHash(config.secretKey, "email", email) : null,
    body: text,
    status: held ? "pending" : "approved",
    created_at: new Date(now).toISOString()
  };
  await db
    .prepare(
      "INSERT INTO comments (id, path, parent_id, author_name, author_url, author_email_hash, body, status, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
    )
    .bind(row.id, row.path, row.parent_id, row.author_name, row.author_url, row.author_email_hash, row.body, row.status, row.created_at)
    .run();

  const comment = publicComment(row);
  if (held) {
    return result(202, { comment: { ...comment, status: "pending" }, status: "pending" });
  }
  return result(201, { comment, status: "published" });
}

async function report({ db, body, params, now }) {
  const fields = new Fields(body);
  const reason = fields.text("reason", { required: true, min: 3, max: 1000, multiline: true });
  fields.done();
  const comment = await db.prepare("SELECT id FROM comments WHERE id = ?1 AND status = 'approved'").bind(params.id).first();
  if (!comment) {
    throw new HttpError(404, "not_found", "There is no published comment with this id.");
  }
  const reportId = id("a", now);
  await db
    .prepare("INSERT INTO abuse_reports (id, comment_id, reason, status, created_at) VALUES (?1, ?2, ?3, 'open', ?4)")
    .bind(reportId, params.id, reason, new Date(now).toISOString())
    .run();
  return result(202, { status: "received", id: reportId });
}

export const routes = [
  { method: "GET", path: "/comments", feature: "comments", handler: list },
  { method: "POST", path: "/comments", feature: "comments", write: true, handler: create },
  { method: "POST", path: "/comments/:id/reports", feature: "comments", write: true, limit: "comment-reports", handler: report }
];
