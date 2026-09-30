/**
 * The contact and collaboration form: a private message to the site's author.
 *
 *   POST /v1/contact
 *   { category, name, email, affiliation?, subject, message, source_url } → 202 { status: "received", id }
 *
 * A message is stored and never published. When CONTACT_TO is set and a mail
 * provider is configured, the author is also sent a copy.
 */

import { result } from "../http.js";
import { id } from "../security.js";
import { Fields } from "../validate.js";

export const MIN_MESSAGE = 20;

async function send({ db, body, config, now, services, waitUntil, requestId }) {
  const fields = new Fields(body);
  const category = fields.oneOf("category", config.contactCategories, { required: true });
  const name = fields.text("name", { required: true, max: 100 });
  const email = fields.email("email", { required: true });
  const affiliation = fields.text("affiliation", { max: 200 });
  const subject = fields.text("subject", { required: true, max: 200 });
  const message = fields.text("message", { required: true, min: MIN_MESSAGE, max: 10000, multiline: true });
  const sourceUrl = fields.url("source_url");
  fields.done();

  const messageId = id("m", now);
  const receivedAt = new Date(now).toISOString();
  await db
    .prepare(
      "INSERT INTO contact_messages (id, category, name, email, affiliation, subject, message, source_url, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
    )
    .bind(messageId, category, name, email, affiliation || null, subject, message, sourceUrl || null, receivedAt)
    .run();

  const recipient = config.env.CONTACT_TO;
  if (recipient && services.mailer) {
    waitUntil(
      services.mailer.send({
        to: recipient,
        replyTo: email,
        subject: `[${category}] ${subject}`,
        text: [
          `${name} <${email}>${affiliation ? `, ${affiliation}` : ""} wrote:`,
          "",
          message,
          "",
          `Sent from ${sourceUrl || "the site"} at ${receivedAt}. Reference: ${requestId}.`
        ].join("\n")
      })
    );
  }
  return result(202, { status: "received", id: messageId });
}

export const routes = [{ method: "POST", path: "/contact", feature: "contact", write: true, handler: send }];
