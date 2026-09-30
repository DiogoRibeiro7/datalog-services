import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainText, privateHost, readSource } from "../src/features/webmentions.js";
import { SITE, call, makeApp } from "./helpers.js";

const TARGET = `${SITE}/2024/04/05/sql-optimization-guide/`;
const SOURCE = "https://example.org/bootstrap-uncertainty";

const REPLY = `<!doctype html><html><head><title>Ignored title</title></head><body>
<article class="h-entry">
  <a class="p-author h-card" href="https://example.org/">Jane Doe</a>
  <h1 class="p-name">Bootstrap uncertainty in small samples</h1>
  <time class="dt-published" datetime="2026-09-16T14:00:00Z">16 September</time>
  <p>In reply to <a class="u-in-reply-to" href="${TARGET}">the SQL notes</a>.</p>
  <div class="e-content"><p>Building on the clustering notes here&hellip; <script>alert(1)</script><b>bold</b> &amp; more.</p></div>
</article></body></html>`;

function source(pages) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const page = pages[String(url)];
    if (!page) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(page.body ?? "", { status: page.status ?? 200, headers: page.headers ?? { "Content-Type": "text/html" } });
  };
  return { fetch, requests };
}

async function receiver(pages, env = {}) {
  const { fetch, requests } = source(pages);
  const made = await makeApp({ env: { FEATURES: "webmentions", ...env }, services: { fetch } });
  const notify = (form) =>
    call(made.app, "POST", "/webmention", {
      origin: null,
      raw: new URLSearchParams(form).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      settle: made.settle
    });
  return { ...made, notify, requests };
}

describe("receiving a Webmention", () => {
  it("accepts at once, then verifies the source and shows what it says as text", async () => {
    const { app, notify, requests } = await receiver({ [SOURCE]: { body: REPLY } });
    const accepted = await notify({ source: SOURCE, target: TARGET });

    assert.equal(accepted.status, 202);
    assert.equal(requests[0].init.redirect, "manual");
    const { json } = await call(app, "GET", `/v1/webmentions?target=${encodeURIComponent(TARGET)}`);
    assert.deepEqual(json.mentions, [
      {
        id: accepted.json.id,
        source: SOURCE,
        target: TARGET,
        type: "reply",
        verified: true,
        author: { name: "Jane Doe", url: "https://example.org/" },
        title: "Bootstrap uncertainty in small samples",
        excerpt: "Building on the clustering notes here… bold & more.",
        published_at: "2026-09-16T14:00:00.000Z"
      }
    ]);
  });

  it("shows nothing from a source that does not link to the target, and takes a mention down when the source is gone", async () => {
    const pages = { [SOURCE]: { body: "<p>No link here.</p>" } };
    const { app, db, notify } = await receiver(pages);
    await notify({ source: SOURCE, target: TARGET });
    assert.equal((await db.prepare("SELECT status FROM webmentions").first()).status, "rejected");

    pages[SOURCE] = { body: REPLY };
    await notify({ source: SOURCE, target: TARGET });
    assert.equal((await call(app, "GET", `/v1/webmentions?target=${encodeURIComponent(TARGET)}`)).json.mentions.length, 1);

    pages[SOURCE] = { status: 410 };
    await notify({ source: SOURCE, target: TARGET });
    assert.deepEqual((await call(app, "GET", `/v1/webmentions?target=${encodeURIComponent(TARGET)}`)).json, { mentions: [] });
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM webmentions").first()).n, 1, "one row per source and target");
  });

  it("refuses what the specification refuses, and anything aimed at another site or a private address", async () => {
    const { notify } = await receiver({});
    const cases = [
      [{ source: SOURCE }, 422],
      [{ source: "ftp://example.org/x", target: TARGET }, 422],
      [{ source: TARGET, target: TARGET }, 400],
      [{ source: SOURCE, target: "https://elsewhere.example/post/" }, 400],
      [{ source: "http://127.0.0.1:8080/", target: TARGET }, 400],
      [{ source: "http://[::1]/", target: TARGET }, 400]
    ];
    for (const [form, status] of cases) {
      assert.equal((await notify(form)).status, status, JSON.stringify(form));
    }
  });

  it("takes only the form encoding the specification uses", async () => {
    const { app } = await receiver({});
    const { status } = await call(app, "POST", "/webmention", { origin: null, body: { source: SOURCE, target: TARGET } });
    assert.equal(status, 415);
  });

  it("does not follow a redirect to a private address", async () => {
    const { db, notify } = await receiver({ [SOURCE]: { status: 302, headers: { Location: "http://192.168.1.1/admin" } } });
    await notify({ source: SOURCE, target: TARGET });
    assert.equal((await db.prepare("SELECT status FROM webmentions").first()).status, "pending", "left unverified");
  });
});

describe("reading Webmentions", () => {
  it("lists verified mentions of a page of the site, newest first", async () => {
    const { app, db } = await makeApp({ env: { FEATURES: "webmentions" } });
    const insert = (id, status, published) =>
      db
        .prepare("INSERT INTO webmentions (id, source, target, type, status, published_at, received_at) VALUES (?1, ?2, ?3, 'mention', ?4, ?5, ?5)")
        .bind(id, `https://example.org/${id}`, TARGET, status, published)
        .run();
    await insert("wm_old", "verified", "2026-01-01T00:00:00Z");
    await insert("wm_new", "verified", "2026-06-01T00:00:00Z");
    await insert("wm_pending", "pending", "2026-07-01T00:00:00Z");

    const { json } = await call(app, "GET", `/v1/webmentions?target=${encodeURIComponent(TARGET)}`);
    assert.deepEqual(json.mentions.map((mention) => mention.id), ["wm_new", "wm_old"]);
    assert.ok(json.mentions.every((mention) => mention.verified === true));
  });

  it("requires a target on the site", async () => {
    const { app } = await makeApp({ env: { FEATURES: "webmentions" } });
    const missing = await call(app, "GET", "/v1/webmentions");
    const foreign = await call(app, "GET", `/v1/webmentions?target=${encodeURIComponent("https://elsewhere.example/")}`);
    assert.deepEqual([missing.status, Object.keys(missing.json.error.errors)], [422, ["target"]]);
    assert.equal(foreign.json.error.errors.target, "Not a page of this site.");
  });
});

describe("reading a source page", () => {
  it("falls back to the page's title, meta author and description without microformats", () => {
    const html = `<html><head><title>A &amp; B</title><meta name="author" content="Sam"><meta name="description" content="About the post."></head>
      <body><a href="${TARGET.replace(/\/$/, "")}#section">link</a></body></html>`;
    assert.deepEqual(readSource(html, SOURCE, TARGET), {
      type: "mention",
      title: "A & B",
      author_name: "Sam",
      author_url: null,
      published_at: null,
      excerpt: "About the post."
    });
  });

  it("resolves relative links and tells likes and reposts", () => {
    assert.equal(readSource(`<a class="u-like-of" href="${TARGET}">x</a>`, SOURCE, TARGET).type, "like");
    assert.equal(readSource(`<a class="u-repost-of" href="${TARGET}">x</a>`, SOURCE, TARGET).type, "repost");
    assert.equal(readSource('<a href="/2024/04/05/sql-optimization-guide/">x</a>', `${SITE}/elsewhere`, TARGET).type, "mention");
    assert.equal(readSource('<a href="https://example.org/other">x</a>', SOURCE, TARGET), null);
  });

  it("keeps text only, and cuts it", () => {
    assert.equal(plainText("<p>Hi <img src=x onerror=alert(1)> &lt;b&gt; &#x41;</p>"), "Hi <b> A");
    assert.equal([...plainText("word ".repeat(100), 20)].length, 20);
  });

  it("knows private addresses", () => {
    for (const host of ["localhost", "10.0.0.1", "172.16.5.4", "192.168.0.1", "169.254.1.1", "127.0.0.1", "[::1]", "fd00::1", "api.internal"]) {
      assert.equal(privateHost(host), true, host);
    }
    for (const host of ["example.org", "8.8.8.8", "172.32.0.1", "[2001:db8::1]"]) {
      assert.equal(privateHost(host), false, host);
    }
  });
});
