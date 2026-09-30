/**
 * "Was this useful?": counts per page, and one reaction per reader per page
 * per day.
 *
 *   GET  /v1/reactions?path=/2024/04/05/post/   { counts: { useful: 42 } }
 *   POST /v1/reactions                          { path, reaction } → 201 { counts, reaction }
 *
 * A reader is a keyed hash of their address, the page and the day, which is
 * what the theme's docs suggest: nothing is stored that identifies anyone,
 * and readers who share an address (a university network) can each react on
 * another day, not twice on the same one. A second reaction the same day is
 * a 409, which the theme shows as already counted.
 */

import { HttpError, result } from "../http.js";
import { keyedHash } from "../security.js";
import { Fields, requirePath } from "../validate.js";

async function countsFor(db, path) {
  const { results } = await db
    .prepare("SELECT reaction, COUNT(*) AS total FROM reactions WHERE path = ?1 GROUP BY reaction ORDER BY reaction")
    .bind(path)
    .all();
  return Object.fromEntries(results.map((row) => [row.reaction, Number(row.total)]));
}

async function read({ db, query }) {
  return result(200, { counts: await countsFor(db, requirePath(query)) });
}

async function react({ db, body, config, now, clientIp }) {
  const fields = new Fields(body);
  const path = fields.path("path", { required: true });
  const reaction = fields.oneOf("reaction", config.reactionTypes, { required: true });
  fields.done();

  const day = new Date(now).toISOString().slice(0, 10);
  const reader = await keyedHash(config.secretKey, "reader", `${clientIp}\u0000${path}\u0000${day}`);
  const inserted = await db
    .prepare("INSERT INTO reactions (path, reader_hash, reaction, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING")
    .bind(path, reader, reaction, new Date(now).toISOString())
    .run();
  if (inserted.meta.changes === 0) {
    throw new HttpError(409, "already_reacted", "Your reaction to this page is already counted.");
  }
  return result(201, { counts: await countsFor(db, path), reaction });
}

export const routes = [
  { method: "GET", path: "/reactions", feature: "reactions", handler: read },
  { method: "POST", path: "/reactions", feature: "reactions", write: true, handler: react }
];
