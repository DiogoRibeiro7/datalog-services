/**
 * Correction reports: private claims that an article is wrong, for the
 * moderation inbox.
 *
 *   POST /v1/corrections
 *   { category, section?, message, contact_email?, quote?, article: { url, title } } → 202 { status: "received", id }
 *
 * The article must be on the site (an origin in ALLOWED_ORIGINS or
 * SITE_URL), so the service cannot be used to collect reports about anyone
 * else's pages. The reporter's email is stored to answer them and shown only
 * to moderators.
 */

import { result } from "../http.js";
import { id } from "../security.js";
import { Fields } from "../validate.js";

export const MIN_MESSAGE = 20;

/** Whether an address is a page of the site this service serves. */
export function onSite(config, href) {
  const origin = new URL(href).origin;
  const site = config.siteUrl ? new URL(config.siteUrl).origin : null;
  return config.allowedOrigins.includes(origin) || origin === site;
}

async function report({ db, body, config, now }) {
  const fields = new Fields(body);
  const category = fields.oneOf("category", config.correctionCategories, { required: true });
  const section = fields.text("section", { max: 200 });
  const message = fields.text("message", { required: true, min: MIN_MESSAGE, max: 5000, multiline: true });
  const email = fields.email("contact_email");
  const quote = fields.text("quote", { max: 1000, multiline: true });
  const article = body.article && typeof body.article === "object" && !Array.isArray(body.article) ? body.article : {};
  const url = fields.url("article", { from: article.url, required: true });
  const title = fields.text("article", { from: article.title, max: 300 });
  if (url && !onSite(config, url)) {
    fields.fail("article", "Not an article on this site.");
  }
  fields.done();

  const reportId = id("r", now);
  await db
    .prepare(
      "INSERT INTO corrections (id, path, article_url, article_title, category, section, message, quote, contact_email, status, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'new', ?10)"
    )
    .bind(reportId, new URL(url).pathname, url, title || null, category, section || null, message, quote || null, email || null, new Date(now).toISOString())
    .run();
  return result(202, { status: "received", id: reportId });
}

export const routes = [{ method: "POST", path: "/corrections", feature: "corrections", write: true, handler: report }];
