import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SITE, call, clock, makeApp } from "./helpers.js";

const POST = "/2024/04/07/plotly-showcase/";
const ALL = { FEATURES: "comments,reactions,corrections,contact" };

async function approve(db, id) {
  await db.prepare("UPDATE comments SET status = 'approved' WHERE id = ?1").bind(id).run();
}

describe("comments", () => {
  it("holds a new comment for moderation and serves it once approved, without the email", async () => {
    const { app, db } = await makeApp({ env: ALL });
    const posted = await call(app, "POST", "/v1/comments", {
      headers: { "Idempotency-Key": "k1" },
      body: { path: POST, parent_id: null, author: { name: "Dana", email: "Dana@Example.org", url: "https://dana.example" }, body: "One question about the export step." }
    });

    assert.equal(posted.status, 202);
    assert.equal(posted.json.status, "pending");
    assert.equal(posted.json.comment.status, "pending");
    assert.deepEqual(posted.json.comment.author, { name: "Dana", url: "https://dana.example/" });
    assert.match(posted.json.comment.id, /^c_/);

    assert.deepEqual((await call(app, "GET", `/v1/comments?path=${encodeURIComponent(POST)}`)).json, { comments: [] }, "not before approval");
    await approve(db, posted.json.comment.id);
    const { json } = await call(app, "GET", `/v1/comments?path=${encodeURIComponent(POST)}`);
    assert.deepEqual(json.comments, [
      {
        id: posted.json.comment.id,
        parent_id: null,
        author: { name: "Dana", url: "https://dana.example/" },
        body: "One question about the export step.",
        created_at: posted.json.comment.created_at
      }
    ]);
    assert.doesNotMatch(JSON.stringify(json), /example\.org/i, "the email never leaves the service");
    const stored = await db.prepare("SELECT author_email_hash FROM comments").first();
    assert.ok(stored.author_email_hash && !stored.author_email_hash.includes("@"));
  });

  it("publishes at once with moderation off, oldest first, and nests replies by parent_id", async () => {
    const now = clock();
    const { app } = await makeApp({ env: { ...ALL, COMMENTS_MODERATION: "false" }, now });
    const first = await call(app, "POST", "/v1/comments", { body: { path: POST, author: { name: "Alice" }, body: "Clear charts." } });
    now.advance(1000);
    const reply = await call(app, "POST", "/v1/comments", { body: { path: POST, parent_id: first.json.comment.id, author: { name: "Bob" }, body: "Agreed." } });

    assert.deepEqual([first.status, first.json.status], [201, "published"]);
    assert.equal(first.json.comment.status, undefined);
    assert.equal(reply.json.comment.parent_id, first.json.comment.id);
    const { json } = await call(app, "GET", `/v1/comments?path=${encodeURIComponent(POST)}`);
    assert.deepEqual(json.comments.map((comment) => comment.author.name), ["Alice", "Bob"]);
  });

  it("names the fields at fault, with the keys the theme's form marks", async () => {
    const { app } = await makeApp({ env: ALL });
    const { status, json } = await call(app, "POST", "/v1/comments", {
      body: { path: "not-a-path", author: { name: "", email: "nope", url: "javascript:alert(1)" }, body: "x" }
    });

    assert.equal(status, 422);
    assert.equal(json.error.code, "invalid");
    assert.deepEqual(Object.keys(json.error.errors).sort(), ["body", "email", "name", "path", "url"]);
  });

  it("refuses a reply to a comment that is not a published one of the same page", async () => {
    const { app, db } = await makeApp({ env: ALL });
    const pending = await call(app, "POST", "/v1/comments", { body: { path: POST, author: { name: "Alice" }, body: "Held." } });
    const toPending = await call(app, "POST", "/v1/comments", { body: { path: POST, parent_id: pending.json.comment.id, author: { name: "Bob" }, body: "Reply." } });
    await approve(db, pending.json.comment.id);
    const elsewhere = await call(app, "POST", "/v1/comments", { body: { path: "/other/", parent_id: pending.json.comment.id, author: { name: "Bob" }, body: "Reply." } });

    assert.deepEqual([toPending.status, Object.keys(toPending.json.error.errors)], [422, ["parent_id"]]);
    assert.equal(elsewhere.status, 422);
  });

  it("limits links, and keeps markup as text", async () => {
    const { app, db } = await makeApp({ env: { ...ALL, COMMENTS_MODERATION: "false" } });
    const spam = await call(app, "POST", "/v1/comments", {
      body: { path: POST, author: { name: "Eve" }, body: "https://a.example https://b.example www.c.example" }
    });
    assert.deepEqual(spam.json.error.errors, { body: "At most 2 links." });

    await call(app, "POST", "/v1/comments", { body: { path: POST, author: { name: "Mal\u0000lory\u200b" }, body: "<script>alert(1)</script> is text" } });
    const row = await db.prepare("SELECT author_name, body FROM comments WHERE author_name LIKE 'Mal%'").first();
    assert.deepEqual(row, { author_name: "Mal lory", body: "<script>alert(1)</script> is text" });
  });

  it("requires the page path to read", async () => {
    const { app } = await makeApp({ env: ALL });
    const { status, json } = await call(app, "GET", "/v1/comments");
    assert.deepEqual([status, Object.keys(json.error.errors)], [422, ["path"]]);
  });

  it("stores a retried comment once", async () => {
    const { app, db } = await makeApp({ env: ALL });
    const request = { headers: { "Idempotency-Key": "retry-me" }, body: { path: POST, author: { name: "Dana" }, body: "Only once, please." } };
    const first = await call(app, "POST", "/v1/comments", request);
    const second = await call(app, "POST", "/v1/comments", request);

    assert.deepEqual(second.json, first.json);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM comments").first()).n, 1);
  });

  it("takes a reader's report on a published comment, for the moderators", async () => {
    const { app, db } = await makeApp({ env: ALL });
    const posted = await call(app, "POST", "/v1/comments", { body: { path: POST, author: { name: "Alice" }, body: "A comment." } });
    const early = await call(app, "POST", `/v1/comments/${posted.json.comment.id}/reports`, { body: { reason: "Spam link." } });
    await approve(db, posted.json.comment.id);
    const reported = await call(app, "POST", `/v1/comments/${posted.json.comment.id}/reports`, { body: { reason: "Spam link." } });

    assert.equal(early.status, 404, "only a published comment can be reported");
    assert.deepEqual([reported.status, reported.json.status], [202, "received"]);
    assert.equal((await db.prepare("SELECT status FROM abuse_reports").first()).status, "open");
  });

  it("rate-limits posting per client", async () => {
    const { app } = await makeApp({ env: { ...ALL, RATE_LIMITS: "comments=2/600" } });
    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await call(app, "POST", "/v1/comments", { body: { path: POST, author: { name: "Dana" }, body: `Comment ${index}` } })).status);
    }
    assert.deepEqual(statuses, [202, 202, 429]);
  });
});

describe("reactions", () => {
  it("counts a reaction and answers with the new counts", async () => {
    const { app } = await makeApp({ env: ALL });
    const posted = await call(app, "POST", "/v1/reactions", { headers: { "Idempotency-Key": "r1" }, body: { path: POST, reaction: "useful" } });
    await call(app, "POST", "/v1/reactions", { body: { path: POST, reaction: "needs-clarification" }, ip: "198.51.100.2" });

    assert.deepEqual(posted.json, { counts: { useful: 1 }, reaction: "useful" });
    assert.equal(posted.status, 201);
    assert.deepEqual((await call(app, "GET", `/v1/reactions?path=${encodeURIComponent(POST)}`)).json, {
      counts: { "needs-clarification": 1, useful: 1 }
    });
    assert.deepEqual((await call(app, "GET", "/v1/reactions?path=/unread/")).json, { counts: {} });
  });

  it("answers a second reaction from the same reader that day with a 409, and a replay with the first answer", async () => {
    const now = clock();
    const { app } = await makeApp({ env: ALL, now });
    const first = await call(app, "POST", "/v1/reactions", { headers: { "Idempotency-Key": "r2" }, body: { path: POST, reaction: "useful" } });
    const replay = await call(app, "POST", "/v1/reactions", { headers: { "Idempotency-Key": "r2" }, body: { path: POST, reaction: "useful" } });
    const again = await call(app, "POST", "/v1/reactions", { headers: { "Idempotency-Key": "r3" }, body: { path: POST, reaction: "clear" } });

    assert.deepEqual([replay.status, replay.json], [first.status, first.json]);
    assert.deepEqual([again.status, again.json.error.code], [409, "already_reacted"]);
    now.advance(24 * 60 * 60 * 1000);
    assert.equal((await call(app, "POST", "/v1/reactions", { body: { path: POST, reaction: "clear" } })).status, 201, "a new day");
  });

  it("takes only the site's reaction types", async () => {
    const { app } = await makeApp({ env: { ...ALL, REACTION_TYPES: "useful,clear" } });
    const { status, json } = await call(app, "POST", "/v1/reactions", { body: { path: POST, reaction: "interesting" } });
    assert.deepEqual([status, Object.keys(json.error.errors)], [422, ["reaction"]]);
  });
});

describe("correction reports", () => {
  const report = {
    category: "code",
    section: "optimization-checklist",
    message: "The clustering step names purchase_ts but the table clusters on customer_id.",
    contact_email: "reader@example.org",
    quote: "Cluster the fact table on purchase_ts",
    article: { url: `${SITE}/2024/04/05/sql-optimization-guide/`, title: "SQL Optimization Playbook" }
  };

  it("stores a report privately and answers 202", async () => {
    const { app, db } = await makeApp({ env: ALL });
    const { status, json } = await call(app, "POST", "/v1/corrections", { headers: { "Idempotency-Key": "c1" }, body: report });

    assert.equal(status, 202);
    assert.equal(json.status, "received");
    assert.doesNotMatch(JSON.stringify(json), /reader@example/);
    const row = await db.prepare("SELECT path, category, status, contact_email FROM corrections").first();
    assert.deepEqual(row, { path: "/2024/04/05/sql-optimization-guide/", category: "code", status: "new", contact_email: "reader@example.org" });
  });

  it("takes a report with only what the form requires", async () => {
    const { app } = await makeApp({ env: ALL });
    const { category, message, article } = report;
    assert.equal((await call(app, "POST", "/v1/corrections", { body: { category, message, article } })).status, 202);
  });

  it("names the fields at fault, and refuses a page of another site", async () => {
    const { app } = await makeApp({ env: ALL });
    const short = await call(app, "POST", "/v1/corrections", { body: { ...report, message: "Too short.", category: "rumour" } });
    const foreign = await call(app, "POST", "/v1/corrections", { body: { ...report, article: { url: "https://elsewhere.example/post/", title: "Other" } } });

    assert.deepEqual(Object.keys(short.json.error.errors).sort(), ["category", "message"]);
    assert.equal(short.json.error.errors.message, "At least 20 characters.");
    assert.deepEqual(foreign.json.error.errors, { article: "Not an article on this site." });
  });
});

describe("the contact form", () => {
  const message = {
    category: "research-collaboration",
    name: "Jane Doe",
    email: "jane@example.org",
    affiliation: "Example University",
    subject: "Potential collaboration on longitudinal models",
    message: "We have adherence data over five years and would like to model it together.",
    source_url: `${SITE}/contact/`
  };

  it("stores the message and tells the author when a mailer is set up", async () => {
    const sent = [];
    const mailer = { send: async (mail) => sent.push(mail) };
    const { app, db } = await makeApp({ env: { ...ALL, CONTACT_TO: "author@site.example" }, services: { mailer } });
    const { status, json, headers } = await call(app, "POST", "/v1/contact", { headers: { "Idempotency-Key": "m1" }, body: message });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual([status, json.status], [202, "received"]);
    assert.equal((await db.prepare("SELECT email FROM contact_messages").first()).email, "jane@example.org");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "author@site.example");
    assert.equal(sent[0].replyTo, "jane@example.org");
    assert.match(sent[0].text, new RegExp(headers.get("X-Request-Id")));
  });

  it("names the fields at fault", async () => {
    const { app } = await makeApp({ env: ALL });
    const { status, json } = await call(app, "POST", "/v1/contact", { body: { ...message, name: "", email: "x", message: "short" } });
    assert.deepEqual([status, Object.keys(json.error.errors).sort()], [422, ["email", "message", "name"]]);
  });

  it("is off, as every feature is, unless FEATURES names it", async () => {
    const { app } = await makeApp({ env: { FEATURES: "comments" } });
    const { status, json } = await call(app, "POST", "/v1/contact", { body: message });
    assert.deepEqual([status, json.error.code], [404, "feature_off"]);
  });
});
