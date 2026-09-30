#!/usr/bin/env node
/**
 * The theme's own demo site against this service, with nothing written but
 * configuration: the Worker build runs locally in workerd with a fresh D1,
 * the demo is built with `dynamic_services.base_url` pointing at it, and a
 * browser uses comments, reactions and correction reports on a post.
 *
 *   node scripts/theme-e2e.js --theme ../analytics-blog-jekyll
 *
 * The theme checkout needs `bundle install`, `npm ci` and `npm run build:js`
 * done first. Nothing is deployed and the theme's files are not changed: the
 * site is built into a temporary directory with one extra config file.
 */

import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { startWorker } from "./lib/worker-dev.js";

const { values } = parseArgs({
  options: {
    theme: { type: "string", default: process.env.THEME_DIR || "" },
    post: { type: "string", default: "/2024/04/05/sql-optimization-guide/" },
    headed: { type: "boolean", default: false }
  }
});
if (!values.theme) {
  console.error("Usage: node scripts/theme-e2e.js --theme <path to an analytics-blog-jekyll checkout>");
  process.exit(2);
}

const SITE_PORT = 4010;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const TOKEN = "theme-e2e-hooks";
const theme = resolve(values.theme);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".woff2": "font/woff2", ".xml": "application/xml" };

/** A static server for the built site, as GitHub Pages would serve it. */
function serveSite(dir) {
  return createServer(async (request, reply) => {
    let path = decodeURIComponent(new URL(request.url, SITE).pathname);
    if (path.endsWith("/")) {
      path += "index.html";
    }
    const file = join(dir, path);
    try {
      const info = await stat(file);
      const target = info.isDirectory() ? join(file, "index.html") : file;
      reply.writeHead(200, { "Content-Type": TYPES[extname(target)] || "application/octet-stream" });
      createReadStream(target).pipe(reply);
    } catch {
      reply.writeHead(404, { "Content-Type": "text/plain" });
      reply.end("Not found");
    }
  });
}

async function step(name, fn) {
  process.stdout.write(`- ${name} … `);
  try {
    const detail = await fn();
    console.log(`ok${detail ? ` (${detail})` : ""}`);
  } catch (error) {
    console.log("FAILED");
    throw error;
  }
}

const work = await mkdtemp(join(tmpdir(), "datalog-theme-e2e-"));
const siteDir = join(work, "site");
let worker;
let server;
let browser;
let failed = false;
try {
  worker = await startWorker(
    {
      SECRET_KEY: "theme-e2e-secret-key-long-enough",
      ALLOWED_ORIGINS: SITE,
      FEATURES: "comments,reactions,corrections,moderation",
      MODERATORS: "e2e-moderator",
      CONFORMANCE_TOKEN: TOKEN
    },
    { port: 8791, origin: SITE }
  );
  console.log(`Worker (workerd, local D1) at ${worker.base}`);

  const overlay = join(work, "services.yml");
  await writeFile(
    overlay,
    [
      "# The only change to the demo: where its dynamic services are.",
      `url: ${SITE}`,
      'baseurl: ""',
      "dynamic_services:",
      `  base_url: ${worker.base}`,
      "  api_version: v1",
      "  features:",
      "    comments: true",
      "    reactions: true",
      "    corrections: true",
      "datalog_plugins:",
      "  options:",
      "    datalog-comments:",
      "      provider: api",
      "      enabled_by_default: true",
      "      replies: true",
      "      moderation: true",
      ""
    ].join("\n")
  );
  console.log(`Building the demo from ${theme} with ${overlay} …`);
  const built = spawnSync("bundle", ["exec", "jekyll", "build", "--config", `_config.yml,${overlay}`, "--destination", siteDir], {
    cwd: theme,
    shell: process.platform === "win32",
    encoding: "utf8"
  });
  if (built.status !== 0) {
    throw new Error(`The demo did not build:\n${built.stdout}\n${built.stderr}`);
  }
  server = serveSite(siteDir);
  await new Promise((done) => server.listen(SITE_PORT, "127.0.0.1", done));
  console.log(`Demo served at ${SITE}\n`);

  browser = await chromium.launch({ headless: !values.headed });
  const page = await browser.newPage();
  const calls = [];
  page.on("request", (request) => {
    if (request.url().startsWith(worker.base)) {
      calls.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  const hook = async (method, path, body) => {
    const response = await fetch(`${worker.base}/_conformance${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    return response.json();
  };
  const moderator = (await hook("POST", "/session", { login: "e2e-moderator" })).cookie;
  const moderate = (path, init = {}) =>
    fetch(`${worker.base}/v1/moderation${path}`, { ...init, headers: { Cookie: moderator, Origin: SITE, "Content-Type": "application/json", ...(init.headers || {}) } }).then((response) => response.json());

  await page.goto(`${SITE}${values.post}`, { waitUntil: "load" });

  await step("the comments thread loads from the service", async () => {
    await page.locator("[data-comments-thread]").scrollIntoViewIfNeeded();
    await page.waitForSelector('[data-comments-thread][data-state="empty"], [data-comments-thread][data-state="loaded"]', { timeout: 15000 });
    return await page.getAttribute("[data-comments-thread]", "data-state");
  });

  const body = `Posted by the end-to-end run at ${new Date().toISOString()}.`;
  await step("a comment is posted and held for moderation", async () => {
    await page.fill("#comments-name", "E2E Reader");
    await page.fill("#comments-body", body);
    await page.click("#comments-form button[type=submit]");
    await page.waitForSelector('#comments-form[data-state="success"]', { timeout: 15000 });
    await page.waitForSelector(".comment--pending", { timeout: 5000 });
    return await page.textContent(".comment--pending .comment__pending");
  });

  await step("a moderator approves it, and a reload shows it published", async () => {
    const queue = await moderate("/items?type=comment");
    const item = queue.items.find((entry) => entry.body === body);
    if (!item) {
      throw new Error(`The comment is not in the moderation queue: ${JSON.stringify(queue)}`);
    }
    const acted = await moderate(`/items/${item.id}/actions`, { method: "POST", body: JSON.stringify({ action: "approve" }), headers: { "Idempotency-Key": crypto.randomUUID() } });
    if (acted.item?.status !== "approved") {
      throw new Error(`Approval failed: ${JSON.stringify(acted)}`);
    }
    await page.reload({ waitUntil: "load" });
    await page.locator("[data-comments-thread]").scrollIntoViewIfNeeded();
    await page.waitForSelector('[data-comments-thread][data-state="loaded"]', { timeout: 15000 });
    const texts = await page.locator(".comment__body").allTextContents();
    if (!texts.includes(body) || (await page.locator(".comment--pending").count()) > 0) {
      throw new Error(`The approved comment is not shown as published: ${JSON.stringify(texts)}`);
    }
    return "published";
  });

  await step("a reaction is counted by the service", async () => {
    await page.locator("[data-reactions]").scrollIntoViewIfNeeded();
    await page.waitForSelector('[data-reactions][data-state="loaded"]', { timeout: 15000 });
    await page.click('[data-reaction="useful"]');
    await page.waitForSelector('[data-reactions][data-state="selected"]', { timeout: 15000 });
    const count = (await page.textContent('[data-reaction="useful"] [data-reaction-count]')).trim();
    if (count !== "1") {
      throw new Error(`Expected the service's count, 1; the strip shows ${count}`);
    }
    return `useful: ${count}`;
  });

  await step("a correction report is received", async () => {
    await page.locator("[data-correction-report] summary").click();
    await page.selectOption("#correction-category", "code");
    await page.fill("#correction-message", "The end-to-end run reports that the clustering step names the wrong column.");
    await page.locator("[data-correction-report] button[type=submit]").click();
    await page.waitForSelector('#correction-report-form[data-state="success"]', { timeout: 15000 });
    const queue = await moderate("/items?type=correction");
    const report = queue.items.find((entry) => entry.message?.startsWith("The end-to-end run reports"));
    if (!report || report.path !== values.post) {
      throw new Error(`The report is not in the moderation queue for ${values.post}: ${JSON.stringify(queue)}`);
    }
    return `stored as ${report.id}, category ${report.category}`;
  });

  console.log(`\nRequests the page made to the service:\n${[...new Set(calls)].map((call) => `  ${call}`).join("\n")}`);
} catch (error) {
  failed = true;
  console.error(`\n${error.stack || error}`);
} finally {
  await browser?.close();
  server?.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
process.exitCode = failed ? 1 : 0;
