/**
 * Sending mail: subscription confirmations and links, and the author's copy
 * of a contact message. MAIL_PROVIDER chooses how:
 *
 *   resend   Resend's HTTP API, with RESEND_API_KEY (a secret) and MAIL_FROM.
 *   outbox   Nothing leaves: each message is a row of the `outbox` table, for
 *            development and the conformance suite. Never for a real site,
 *            since a subscriber would wait for a confirmation that never comes.
 *
 * Without MAIL_PROVIDER there is no mailer, and the configuration check
 * refuses to switch subscriptions on.
 */

import { HttpError } from "./http.js";
import { id } from "./security.js";

export const PROVIDERS = ["resend", "outbox"];

/** Why a configuration cannot send mail, or null when it can. */
export function mailProblem(env) {
  const provider = String(env.MAIL_PROVIDER || "").toLowerCase();
  if (!provider) {
    return "subscriptions need a mail provider: set MAIL_PROVIDER to resend (or outbox for testing)";
  }
  if (!PROVIDERS.includes(provider)) {
    return `MAIL_PROVIDER must be one of ${PROVIDERS.join(", ")}; got "${env.MAIL_PROVIDER}"`;
  }
  if (provider === "resend" && (!env.RESEND_API_KEY || !env.MAIL_FROM)) {
    return "MAIL_PROVIDER=resend needs the RESEND_API_KEY secret and MAIL_FROM";
  }
  return null;
}

/**
 * @param {Object} env
 * @param {Object} deps - `db` for the outbox, `fetch` for Resend, `now`
 * @returns {{ send: Function, provider: string }|null}
 */
export function createMailer(env, deps) {
  const provider = String(env.MAIL_PROVIDER || "").toLowerCase();
  if (provider === "outbox") {
    return {
      provider,
      async send(message) {
        await deps.db
          .prepare("INSERT INTO outbox (id, to_address, reply_to, subject, text, headers, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
          .bind(
            id("mail"),
            message.to,
            message.replyTo || null,
            message.subject,
            message.text,
            JSON.stringify(message.headers || {}),
            new Date((deps.now || Date.now)()).toISOString()
          )
          .run();
      }
    };
  }
  if (provider === "resend") {
    const fetchImpl = deps.fetch || ((...args) => globalThis.fetch(...args));
    return {
      provider,
      async send(message) {
        const response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: env.MAIL_FROM,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.replyTo ? { reply_to: message.replyTo } : {}),
            ...(message.headers ? { headers: message.headers } : {})
          })
        });
        if (!response.ok) {
          throw new HttpError(502, "mail_failed", "The service could not send the email. Try again later.");
        }
      }
    };
  }
  return null;
}
