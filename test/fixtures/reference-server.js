/**
 * The reference service, set up the way a conformance run wants it: every
 * feature on, mail kept in the outbox, the test hooks on, a known moderator,
 * and limits high enough that the functional checks do not trip them, except
 * on correction reports, which the rate-limit check probes.
 */

import { createNodeServer } from "../../src/node.js";
import { createService } from "../../src/service.js";
import { migrate } from "../../src/store/migrate.js";
import { openDatabase } from "../../src/store/sqlite-d1.js";

export const ORIGIN = "https://site.conformance.test";
export const HOOKS_TOKEN = "conformance-hooks-token";

export const ENV = {
  SECRET_KEY: "conformance-secret-key-for-the-reference-run",
  ALLOWED_ORIGINS: ORIGIN,
  FEATURES: "comments,reactions,corrections,contact,subscriptions,webmentions,moderation",
  MAIL_PROVIDER: "outbox",
  CONFORMANCE_TOKEN: HOOKS_TOKEN,
  MODERATORS: "conformance-moderator",
  RATE_LIMITS: "comments=100/600,reactions=100/600,contact=100/600,subscriptions=100/600,subscriptions-address=100/600,moderation=1000/600,corrections=20/600"
};

export async function createReferenceServer(env = {}) {
  const db = openDatabase(":memory:");
  await migrate(db);
  const service = createService({ db, env: { ...ENV, ...env }, log: () => {} });
  return createNodeServer(service);
}
