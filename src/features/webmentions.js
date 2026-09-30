/**
 * Webmentions: the W3C receiver other sites notify, and the read route the
 * theme's "Mentioned elsewhere" section calls.
 *
 *   POST /webmention                        source=…&target=… (form-encoded, per the W3C spec) → 202
 *   GET  /v1/webmentions?target=<page URL>  { mentions: [...] }, verified ones, newest first
 *
 * A notification is only a claim. The receiver answers at once and checks it
 * afterwards: it fetches the source, confirms that it links to the target,
 * and reads the title, author, date, kind and an excerpt out of it as plain
 * text. Only then is the mention verified and shown. A source that answers
 * 410, or no longer links, takes its mention down again on the next
 * notification.
 *
 * Sources are fetched with a timeout and a size limit, never from a private
 * or loopback address unless WEBMENTION_ALLOW_PRIVATE=true (tests only), and
 * nothing from them is kept as HTML.
 */

import { onSite } from "./corrections.js";
import { HttpError, result } from "../http.js";
import { id } from "../security.js";
import { Fields } from "../validate.js";

const FETCH_TIMEOUT_MS = 8000;
const MAX_SOURCE_BYTES = 1024 * 1024;
const EXCERPT = 280;

async function list({ db, query, config }) {
  const fields = new Fields({ target: query.get("target") ?? undefined });
  const target = fields.url("target", { required: true });
  if (target && !onSite(config, target)) {
    fields.fail("target", "Not a page of this site.");
  }
  fields.done();
  const { results } = await db
    .prepare(
      "SELECT id, source, target, type, author_name, author_url, title, excerpt, published_at FROM webmentions " +
        "WHERE target = ?1 AND status = 'verified' ORDER BY COALESCE(published_at, received_at) DESC, id DESC LIMIT 200"
    )
    .bind(target)
    .all();
  return result(200, {
    mentions: results.map((row) => {
      const mention = { id: row.id, source: row.source, target: row.target, type: row.type, verified: true };
      if (row.author_name || row.author_url) {
        mention.author = { ...(row.author_name ? { name: row.author_name } : {}), ...(row.author_url ? { url: row.author_url } : {}) };
      }
      for (const key of ["title", "excerpt", "published_at"]) {
        if (row[key]) {
          mention[key] = row[key];
        }
      }
      return mention;
    })
  });
}

/** Whether a host names a private, loopback or link-local address. */
export function privateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
}

/** The named entities a blog post's text is likely to hold; numeric ones are decoded whatever they are. */
const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  deg: "°"
};

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Markup as a line of plain text. */
export function plainText(html, limit) {
  const text = decodeEntities(
    html
      .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
  return limit && [...text].length > limit ? `${[...text].slice(0, limit - 1).join("").trimEnd()}…` : text;
}

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function hasClass(tag, name) {
  const classes = attribute(tag, "class");
  return classes !== null && classes.split(/\s+/).includes(name);
}

/** The element with a class, as its opening tag and inner markup (to the first closing tag of its name). */
function elementWithClass(html, name) {
  const tags = html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*>/gi);
  for (const match of tags) {
    if (hasClass(match[0], name)) {
      const tagName = match[1].toLowerCase();
      const start = match.index + match[0].length;
      const end = html.toLowerCase().indexOf(`</${tagName}`, start);
      return { tag: match[0], inner: end === -1 ? "" : html.slice(start, end) };
    }
  }
  return null;
}

function sameUrl(href, target) {
  const strip = (url) => url.replace(/#.*$/, "").replace(/\/+$/, "");
  return strip(href) === strip(target);
}

/**
 * What a source page says about the target, or null when it does not link to it.
 * @param {string} html
 * @param {string} sourceUrl - For resolving relative links
 * @param {string} target
 */
export function readSource(html, sourceUrl, target) {
  let type = null;
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attribute(match[0], "href");
    if (!href) {
      continue;
    }
    let absolute;
    try {
      absolute = new URL(href, sourceUrl).href;
    } catch {
      continue;
    }
    if (!sameUrl(absolute, target)) {
      continue;
    }
    const kind = hasClass(match[0], "u-in-reply-to") ? "reply" : hasClass(match[0], "u-repost-of") ? "repost" : hasClass(match[0], "u-like-of") ? "like" : "mention";
    if (type === null || type === "mention") {
      type = kind;
    }
  }
  if (type === null) {
    return null;
  }

  // The post's own microformats when it marks them up (an h-entry), else the page's.
  const entry = elementWithClass(html, "h-entry");
  const scope = entry ? entry.inner : html;
  const author = elementWithClass(scope, "p-author") || elementWithClass(html, "h-card");
  const outsideAuthor = author ? scope.replace(author.tag + author.inner, " ") : scope;

  const name = elementWithClass(outsideAuthor, "p-name");
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = plainText(name ? name.inner : titleTag ? titleTag[1] : "", 200) || null;

  let authorName;
  let authorUrl = null;
  if (author) {
    const nameInside = elementWithClass(author.inner, "p-name");
    authorName = plainText(nameInside ? nameInside.inner : author.inner, 100) || null;
    const link = author.tag.toLowerCase().startsWith("<a") ? [author.tag] : /<a\b[^>]*>/i.exec(author.inner);
    const href = link ? attribute(link[0], "href") : null;
    authorUrl = href ? safeUrl(href, sourceUrl) : null;
  } else {
    const meta = /<meta\b[^>]*name\s*=\s*["']author["'][^>]*>/i.exec(html);
    authorName = meta ? plainText(attribute(meta[0], "content") || "", 100) || null : null;
  }

  const published = elementWithClass(scope, "dt-published");
  const timeTag = /<time\b[^>]*>/i.exec(scope);
  const stamp = published
    ? attribute(published.tag, "datetime") || plainText(published.inner)
    : timeTag
      ? attribute(timeTag[0], "datetime")
      : null;
  const publishedAt = stamp && !Number.isNaN(Date.parse(stamp)) ? new Date(Date.parse(stamp)).toISOString() : null;

  const summary = elementWithClass(scope, "p-summary") || elementWithClass(scope, "e-content");
  const description = /<meta\b[^>]*name\s*=\s*["']description["'][^>]*>/i.exec(html);
  const excerpt = plainText(summary ? summary.inner : description ? attribute(description[0], "content") || "" : "", EXCERPT) || null;

  return { type, title, author_name: authorName, author_url: authorUrl, published_at: publishedAt, excerpt };
}

function safeUrl(href, base) {
  try {
    const url = new URL(href, base);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const MAX_REDIRECTS = 3;

/**
 * GET the source, following at most three redirects by hand so that each
 * hop is checked like the first, and reading at most a megabyte of it.
 */
async function fetchSource(fetchImpl, source, allowPrivate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let url = source;
    let response;
    for (let hop = 0; ; hop += 1) {
      if (!allowPrivate && privateHost(new URL(url).hostname)) {
        throw new Error(`refused to fetch a private address: ${new URL(url).host}`);
      }
      response = await fetchImpl(url, {
        headers: { Accept: "text/html, application/xhtml+xml", "User-Agent": "datalog-services Webmention verifier" },
        redirect: "manual",
        signal: controller.signal
      });
      const location = response.headers.get("Location");
      if (response.status < 300 || response.status >= 400 || !location) {
        break;
      }
      if (hop >= MAX_REDIRECTS) {
        throw new Error("too many redirects");
      }
      url = safeUrl(location, url);
      if (!url) {
        throw new Error("redirected to an address that is not http(s)");
      }
    }
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const piece = value.subarray(0, MAX_SOURCE_BYTES - size);
      chunks.push(piece);
      size += piece.length;
      if (size >= MAX_SOURCE_BYTES) {
        await reader.cancel();
        break;
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { status: response.status, html: new TextDecoder().decode(bytes) };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches a source and records what it says; run in the background after the 202. */
export async function verify({ db, services, log, config }, mentionId, source, target, now) {
  const fetchImpl = services.fetch || ((...args) => globalThis.fetch(...args));
  let outcome;
  try {
    outcome = await fetchSource(fetchImpl, source, allowsPrivate(config));
  } catch (error) {
    log("info", "webmention_unreachable", { mentionId, error: String(error) });
    return;
  }
  const stamp = new Date(now).toISOString();
  if (outcome.status === 410) {
    await db.prepare("UPDATE webmentions SET status = 'deleted', verified_at = ?2 WHERE id = ?1").bind(mentionId, stamp).run();
    return;
  }
  const found = outcome.status >= 200 && outcome.status < 300 ? readSource(outcome.html, source, target) : null;
  if (!found) {
    await db.prepare("UPDATE webmentions SET status = 'rejected', verified_at = ?2 WHERE id = ?1").bind(mentionId, stamp).run();
    return;
  }
  await db
    .prepare(
      "UPDATE webmentions SET status = 'verified', type = ?2, title = ?3, author_name = ?4, author_url = ?5, published_at = ?6, excerpt = ?7, verified_at = ?8 WHERE id = ?1"
    )
    .bind(mentionId, found.type, found.title, found.author_name, found.author_url, found.published_at, found.excerpt, stamp)
    .run();
}

function allowsPrivate(config) {
  return ["1", "true"].includes(String(config.env.WEBMENTION_ALLOW_PRIVATE).toLowerCase());
}

async function receive(ctx) {
  const type = (ctx.request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    throw new HttpError(415, "unsupported_media_type", "Send source and target as application/x-www-form-urlencoded.");
  }
  const form = new URLSearchParams(ctx.rawBody);
  const fields = new Fields({ source: form.get("source") ?? undefined, target: form.get("target") ?? undefined });
  const source = fields.url("source", { required: true });
  const target = fields.url("target", { required: true });
  fields.done();
  if (source === target) {
    throw new HttpError(400, "invalid", "The source and the target are the same.");
  }
  if (!onSite(ctx.config, target)) {
    throw new HttpError(400, "invalid", "The target is not a page of this site.");
  }
  if (!allowsPrivate(ctx.config) && privateHost(new URL(source).hostname)) {
    throw new HttpError(400, "invalid", "The source is not a public address.");
  }

  const stamp = new Date(ctx.now).toISOString();
  const existing = await ctx.db.prepare("SELECT id FROM webmentions WHERE source = ?1 AND target = ?2").bind(source, target).first();
  const mentionId = existing ? existing.id : id("wm", ctx.now);
  if (existing) {
    await ctx.db.prepare("UPDATE webmentions SET received_at = ?2 WHERE id = ?1").bind(mentionId, stamp).run();
  } else {
    await ctx.db
      .prepare("INSERT INTO webmentions (id, source, target, type, status, received_at) VALUES (?1, ?2, ?3, 'mention', 'pending', ?4)")
      .bind(mentionId, source, target, stamp)
      .run();
  }
  ctx.waitUntil(verify(ctx, mentionId, source, target, ctx.now));
  return result(202, { status: "accepted", id: mentionId });
}

export const routes = [{ method: "GET", path: "/webmentions", feature: "webmentions", handler: list }];

export const rootRoutes = [
  { method: "POST", path: "/webmention", feature: "webmentions", write: true, body: "none", limit: "webmention", handler: receive }
];
