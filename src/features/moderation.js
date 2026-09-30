/**
 * The moderation inbox's API (docs/moderation.md in the theme): one queue
 * over comments, correction reports and readers' reports on comments, and the
 * actions a moderator takes on them. Every request needs a moderator's
 * session (src/auth.js); every action is recorded with the moderator the
 * session names, never a name the browser sends.
 *
 *   GET  /v1/moderation/items?type=&status=&path=&category=&since=&q=&cursor=
 *   POST /v1/moderation/items/:id/actions   { action, note?, link? } → 200 { item }
 *
 * Without `status` the listing is the queue: pending comments, new, reviewed
 * and accepted correction reports, open abuse reports. An action the item's
 * status does not allow, including one another moderator's action has just
 * made stale, is a 409, and changes nothing.
 */

import { requireModerator } from "../auth.js";
import { HttpError, invalid, result } from "../http.js";
import { base64url, fromBase64url } from "../security.js";
import { Fields } from "../validate.js";

export const TYPES = ["comment", "correction", "abuse"];

export const QUEUE = {
  comment: ["pending"],
  correction: ["new", "reviewed", "accepted"],
  abuse: ["open"]
};

/** What each action does from each status, per type. */
export const TRANSITIONS = {
  comment: {
    pending: { approve: "approved", spam: "spam", delete: "deleted" },
    approved: { hide: "hidden", spam: "spam", delete: "deleted" },
    spam: { approve: "approved", delete: "deleted" },
    hidden: { approve: "approved", delete: "deleted" }
  },
  correction: {
    new: { reviewed: "reviewed", accept: "accepted", reject: "rejected" },
    reviewed: { accept: "accepted", reject: "rejected" },
    accepted: { resolve: "resolved", reject: "rejected" }
  },
  abuse: {
    open: { dismiss: "dismissed", hide: "hidden", delete: "deleted" }
  }
};

const PREFIX = { c: "comment", r: "correction", a: "abuse" };
const PAGE = 20;

const ITEMS = `
  SELECT 'comment' AS type, c.id, c.status, c.created_at, c.path, NULL AS title, c.author_name, NULL AS author_email,
         c.body AS text, NULL AS category, NULL AS section, NULL AS quote, NULL AS reason, c.parent_id AS ref, NULL AS resolution_url
    FROM comments c
  UNION ALL
  SELECT 'correction', r.id, r.status, r.created_at, r.path, r.article_title, NULL, r.contact_email,
         r.message, r.category, r.section, r.quote, NULL, NULL, r.resolution_url
    FROM corrections r
  UNION ALL
  SELECT 'abuse', a.id, a.status, a.created_at, c.path, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, a.reason, a.comment_id, NULL
    FROM abuse_reports a JOIN comments c ON c.id = a.comment_id`;

function encodeCursor(row) {
  return base64url(new TextEncoder().encode(JSON.stringify([row.created_at, row.id])));
}

function decodeCursor(value) {
  try {
    const [createdAt, itemId] = JSON.parse(new TextDecoder().decode(fromBase64url(value)));
    if (typeof createdAt === "string" && typeof itemId === "string") {
      return { createdAt, itemId };
    }
  } catch {
    // An unreadable cursor is the caller's mistake, answered below.
  }
  throw invalid({ cursor: "Not a cursor this service gave." });
}

function readFilters(query) {
  const fields = new Fields(Object.fromEntries(query));
  const filters = {
    type: fields.oneOf("type", TYPES),
    status: fields.text("status", { max: 20 }),
    path: fields.path("path"),
    category: fields.text("category", { max: 100 }),
    since: fields.text("since", { max: 40 }),
    q: fields.text("q", { max: 200 })
  };
  if (filters.since && Number.isNaN(Date.parse(filters.since))) {
    fields.fail("since", "Must be a date, such as 2026-09-01.");
  }
  fields.done();
  return filters;
}

async function historyOf(db, itemId) {
  const { results } = await db
    .prepare("SELECT action, at, moderator, note, link FROM moderation_history WHERE item_id = ?1 ORDER BY at, id")
    .bind(itemId)
    .all();
  return results.map((step) => ({ action: step.action, at: step.at, moderator: step.moderator, note: step.note || "", ...(step.link ? { link: step.link } : {}) }));
}

/** A row of the union as the item the inbox reads. */
async function itemFrom(db, row) {
  const item = { id: row.id, type: row.type, status: row.status, created_at: row.created_at, path: row.path };
  if (row.title) {
    item.title = row.title;
  }
  if (row.type === "comment") {
    item.author = { name: row.author_name };
    item.body = row.text;
  } else if (row.type === "correction") {
    item.category = row.category;
    item.message = row.text;
    for (const key of ["section", "quote"]) {
      if (row[key]) {
        item[key] = row[key];
      }
    }
    if (row.author_email) {
      item.author = { email: row.author_email };
    }
    if (row.resolution_url) {
      item.resolution = { url: row.resolution_url };
    }
  } else {
    item.reason = row.reason;
  }
  if (row.ref) {
    const parent = await db.prepare("SELECT author_name, body, status FROM comments WHERE id = ?1").bind(row.ref).first();
    if (parent) {
      item.context = { parent: { author: { name: parent.author_name }, body: parent.body } };
    }
  }
  item.history = await historyOf(db, row.id);
  return item;
}

async function list(ctx) {
  await requireModerator(ctx);
  const { db, query } = ctx;
  const filters = readFilters(query);
  const where = [];
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `?${params.length}`;
  };
  if (filters.type) {
    where.push(`type = ${bind(filters.type)}`);
  }
  if (filters.status) {
    where.push(`status = ${bind(filters.status)}`);
  } else {
    const queue = Object.entries(QUEUE).map(([type, statuses]) => `(type = ${bind(type)} AND status IN (${statuses.map(bind).join(", ")}))`);
    where.push(`(${queue.join(" OR ")})`);
  }
  if (filters.path) {
    where.push(`path = ${bind(filters.path)}`);
  }
  if (filters.category) {
    where.push(`category = ${bind(filters.category)}`);
  }
  if (filters.since) {
    where.push(`created_at >= ${bind(new Date(Date.parse(filters.since)).toISOString())}`);
  }
  if (filters.q) {
    const pattern = `%${filters.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const like = bind(pattern);
    where.push(
      `(${["text", "author_name", "quote", "title", "reason", "section"].map((column) => `${column} LIKE ${like} ESCAPE '\\'`).join(" OR ")})`
    );
  }
  const cursor = query.get("cursor");
  if (cursor) {
    const { createdAt, itemId } = decodeCursor(cursor);
    where.push(`(created_at < ${bind(createdAt)} OR (created_at = ${bind(createdAt)} AND id < ${bind(itemId)}))`);
  }
  const limit = bind(PAGE + 1);
  const sql = `SELECT * FROM (${ITEMS}) WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  const { results } = await db.prepare(sql).bind(...params).all();
  const page = results.slice(0, PAGE);
  const body = { items: await Promise.all(page.map((row) => itemFrom(db, row))) };
  if (results.length > PAGE) {
    body.next_cursor = encodeCursor(page.at(-1));
  }
  return result(200, body);
}

const TABLE = { comment: "comments", correction: "corrections", abuse: "abuse_reports" };

async function act(ctx) {
  const moderator = await requireModerator(ctx, { write: true });
  const { db, body, params, now } = ctx;
  const type = PREFIX[params.id.split("_")[0]];
  const row = type ? await db.prepare(`SELECT * FROM (${ITEMS}) WHERE id = ?1`).bind(params.id).first() : null;
  if (!row) {
    throw new HttpError(404, "not_found", "There is no item with this id.");
  }

  const fields = new Fields(body);
  const action = fields.text("action", { required: true, max: 20 });
  const note = fields.text("note", { max: 1000, multiline: true });
  const link = action === "resolve" ? fields.url("link", { required: true }) : undefined;
  fields.done();

  const next = TRANSITIONS[type][row.status]?.[action];
  if (!next) {
    throw new HttpError(409, "conflict", `A ${type} that is ${row.status} cannot be given "${action}".`);
  }

  // One transaction. The status changes only if it is still the one read above,
  // and the history line and side effects follow only if it did: two
  // moderators acting at once cannot both win, nor leave half an action.
  const at = new Date(now).toISOString();
  const statements = [
    type === "correction" && link
      ? db.prepare("UPDATE corrections SET status = ?1, resolution_url = ?2 WHERE id = ?3 AND status = ?4").bind(next, link, row.id, row.status)
      : db.prepare(`UPDATE ${TABLE[type]} SET status = ?1 WHERE id = ?2 AND status = ?3`).bind(next, row.id, row.status),
    db
      .prepare("INSERT INTO moderation_history (item_id, action, at, moderator, note, link) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() = 1")
      .bind(row.id, action, at, moderator, note || null, link || null)
  ];
  if (type === "abuse" && (next === "hidden" || next === "deleted")) {
    statements.push(
      db
        .prepare("UPDATE comments SET status = ?1, updated_at = ?2 WHERE id = ?3 AND EXISTS (SELECT 1 FROM abuse_reports WHERE id = ?4 AND status = ?1)")
        .bind(next, at, row.ref, row.id)
    );
  }
  if (type === "comment") {
    statements.push(db.prepare("UPDATE comments SET updated_at = ?1 WHERE id = ?2 AND status = ?3").bind(at, row.id, next));
  }
  const [changed] = await db.batch(statements);
  if (changed.meta.changes === 0) {
    throw new HttpError(409, "conflict", "Someone else acted on this item first.");
  }
  const updated = await db.prepare(`SELECT * FROM (${ITEMS}) WHERE id = ?1`).bind(row.id).first();
  return result(200, { item: await itemFrom(db, updated) });
}

export const routes = [
  { method: "GET", path: "/moderation/items", feature: "moderation", limit: "moderation", handler: list },
  { method: "POST", path: "/moderation/items/:id/actions", feature: "moderation", write: true, limit: "moderation", handler: act }
];
