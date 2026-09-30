/**
 * What the service forgets, and when: the daily clean-up the Worker's cron
 * trigger runs (src/worker.js), and `npm run retention` for a database kept
 * elsewhere. Each period is a setting, in days; 0 keeps that kind forever.
 *
 *   CONTACT_RETENTION_DAYS       365   contact messages
 *   CORRECTION_RETENTION_DAYS      0   correction reports that are resolved or rejected
 *   COMMENT_TRASH_DAYS            90   comments marked spam or deleted, and the reports on them
 *   PENDING_SUBSCRIPTION_DAYS      7   sign-ups never confirmed
 *   UNSUBSCRIBED_DAYS             30   subscribers who left: the row, address and all
 *   WEBMENTION_REJECT_DAYS        30   mentions whose source did not link, or is gone
 *   OUTBOX_DAYS                   30   mail kept by MAIL_PROVIDER=outbox
 *
 * Rate-limit windows and idempotency keys go after a day whatever the settings.
 */

import { purge as purgeIdempotency } from "./idempotency.js";
import { purge as purgeRateLimits } from "./ratelimit.js";

export const DEFAULTS = {
  CONTACT_RETENTION_DAYS: 365,
  CORRECTION_RETENTION_DAYS: 0,
  COMMENT_TRASH_DAYS: 90,
  PENDING_SUBSCRIPTION_DAYS: 7,
  UNSUBSCRIBED_DAYS: 30,
  WEBMENTION_REJECT_DAYS: 30,
  OUTBOX_DAYS: 30
};

const DAY = 24 * 60 * 60 * 1000;

function days(env, name) {
  const value = env[name] === undefined || env[name] === "" ? DEFAULTS[name] : Number(env[name]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a number of days, 0 to keep forever; got "${env[name]}"`);
  }
  return value;
}

/** The statements of one clean-up, each with its setting, for the log. */
function plan(env, now) {
  const before = (name) => new Date(now - days(env, name) * DAY).toISOString();
  const rules = [
    ["CONTACT_RETENTION_DAYS", "DELETE FROM contact_messages WHERE created_at < ?1"],
    ["CORRECTION_RETENTION_DAYS", "DELETE FROM corrections WHERE status IN ('resolved', 'rejected') AND created_at < ?1"],
    ["COMMENT_TRASH_DAYS", "DELETE FROM abuse_reports WHERE comment_id IN (SELECT id FROM comments WHERE status IN ('spam', 'deleted') AND created_at < ?1)"],
    ["COMMENT_TRASH_DAYS", "DELETE FROM comments WHERE status IN ('spam', 'deleted') AND created_at < ?1 AND id NOT IN (SELECT parent_id FROM comments WHERE parent_id IS NOT NULL)"],
    ["PENDING_SUBSCRIPTION_DAYS", "DELETE FROM subscribers WHERE status = 'pending' AND created_at < ?1"],
    ["UNSUBSCRIBED_DAYS", "DELETE FROM subscribers WHERE status = 'unsubscribed' AND unsubscribed_at < ?1"],
    ["WEBMENTION_REJECT_DAYS", "DELETE FROM webmentions WHERE status IN ('rejected', 'deleted') AND received_at < ?1"],
    ["OUTBOX_DAYS", "DELETE FROM outbox WHERE created_at < ?1"]
  ];
  return rules.filter(([name]) => days(env, name) > 0).map(([name, sql]) => ({ name, sql, before: before(name) }));
}

/**
 * Runs one clean-up and answers how many rows each rule removed.
 * @param {Object} db - D1, or the node:sqlite stand-in
 * @param {Object} env
 * @param {number} [now]
 */
export async function runRetention(db, env, now = Date.now()) {
  const removed = {};
  for (const { name, sql, before } of plan(env, now)) {
    const outcome = await db.prepare(sql).bind(before).run();
    removed[name] = (removed[name] || 0) + outcome.meta.changes;
  }
  await purgeRateLimits(db, now);
  await purgeIdempotency(db, now);
  return removed;
}
