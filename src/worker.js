/**
 * The service as a Cloudflare Worker, with its data in D1: the deployment
 * target docs/deploy-cloudflare.md describes. wrangler.toml binds the
 * database as DB, sets the public settings as [vars], and holds no secret;
 * SECRET_KEY and the others are set with `wrangler secret put`.
 *
 * The client's address is the one Cloudflare's edge puts in
 * CF-Connecting-IP, which a caller cannot set. A daily cron trigger runs the
 * retention clean-up (src/retention.js).
 */

import { runRetention } from "./retention.js";
import { createService } from "./service.js";

let cached = null;

/** One service per set of bindings: an isolate keeps it between requests. */
function serviceFor(env) {
  if (!cached || cached.env !== env) {
    cached = { env, service: createService({ db: env.DB, env }) };
  }
  return cached.service;
}

export default {
  async fetch(request, env, ctx) {
    let service;
    try {
      service = serviceFor(env);
    } catch (error) {
      // A setting the service cannot run with: say so in the logs, not to the reader.
      console.error(JSON.stringify({ level: "error", event: "misconfigured", error: String(error.message || error) }));
      return new Response(JSON.stringify({ error: { code: "misconfigured", message: "The service is not set up correctly." } }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
      });
    }
    return service.fetch(request, {
      clientIp: request.headers.get("CF-Connecting-IP") || "unknown",
      waitUntil: (promise) => ctx.waitUntil(promise)
    });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runRetention(env.DB, env).then((removed) => console.log(JSON.stringify({ level: "info", event: "retention", removed })))
    );
  }
};
