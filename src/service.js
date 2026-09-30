/**
 * The whole service: the core of src/app.js with every feature's routes.
 * src/worker.js and bin/serve.js both build it from here, so a feature added
 * here is served by both.
 */

import { createApp } from "./app.js";
import { routes as comments } from "./features/comments.js";
import { routes as contact } from "./features/contact.js";
import { routes as corrections } from "./features/corrections.js";
import { routes as reactions } from "./features/reactions.js";

/** The feature routes under /v1, in the order they are matched. */
export const ROUTES = [...comments, ...reactions, ...corrections, ...contact];

/** The routes outside /v1. */
export const ROOT_ROUTES = [];

/**
 * @param {Object} options - As createApp's: `db`, `env`, `now`, `log`, `services`
 */
export function createService(options) {
  return createApp({ ...options, routes: ROUTES, rootRoutes: ROOT_ROUTES });
}
