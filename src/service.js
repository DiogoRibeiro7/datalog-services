/**
 * The whole service: the core of src/app.js with every feature's routes.
 * src/worker.js and bin/serve.js both build it from here, so a feature added
 * here is served by both.
 */

import { createApp } from "./app.js";
import { rootRoutes as authRootRoutes } from "./auth.js";
import { readConfig } from "./config.js";
import { routes as comments } from "./features/comments.js";
import { routes as contact } from "./features/contact.js";
import { routes as corrections } from "./features/corrections.js";
import { routes as moderation } from "./features/moderation.js";
import { routes as reactions } from "./features/reactions.js";
import { rootRoutes as subscriptionRootRoutes, routes as subscriptions } from "./features/subscriptions.js";
import { rootRoutes as webmentionRootRoutes, routes as webmentions } from "./features/webmentions.js";
import { createMailer, mailProblem } from "./mail.js";

/** The feature routes under /v1, in the order they are matched. */
export const ROUTES = [...comments, ...reactions, ...corrections, ...contact, ...subscriptions, ...webmentions, ...moderation];

/** The routes outside /v1: the Webmention receiver, the one-click unsubscribe and the moderators' sign-in. */
export const ROOT_ROUTES = [...webmentionRootRoutes, ...subscriptionRootRoutes, ...authRootRoutes];

/**
 * @param {Object} options - As createApp's: `db`, `env`, `now`, `log`, and
 *   `services` (`mailer`, `fetch`), each built from the settings when not given
 */
export function createService(options) {
  const config = options.config || readConfig(options.env);
  if (config.features.subscriptions) {
    const problem = mailProblem(config.env);
    if (problem && !options.services?.mailer) {
      throw new Error(problem);
    }
  }
  const services = { ...(options.services || {}) };
  if (services.mailer === undefined) {
    services.mailer = createMailer(config.env, { db: options.db, fetch: services.fetch, now: options.now });
  }
  return createApp({ ...options, config, services, routes: ROUTES, rootRoutes: ROOT_ROUTES });
}
