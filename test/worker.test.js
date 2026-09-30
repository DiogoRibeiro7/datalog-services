import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULTS, runRetention } from "../src/retention.js";
import worker from "../src/worker.js";
import { BASE_ENV, SITE, freshDb } from "./helpers.js";

function context() {
  const pending = [];
  return { waitUntil: (promise) => pending.push(promise), settled: () => Promise.all(pending) };
}

function get(path, headers = {}) {
  return new Request(`https://datalog-services.example.workers.dev${path}`, { headers: { Origin: SITE, ...headers } });
}

describe("the Worker", () => {
  it("serves the service with its D1 binding and the settings in env", async () => {
    const env = { ...BASE_ENV, DB: await freshDb(), FEATURES: "comments" };
    const response = await worker.fetch(get("/v1/capabilities"), env, context());

    assert.equal(response.status, 200);
    assert.equal((await response.json()).features.comments, true);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), SITE);
  });

  it("counts a client by CF-Connecting-IP, which the edge sets and a caller cannot", async () => {
    const env = { ...BASE_ENV, DB: await freshDb(), FEATURES: "reactions", RATE_LIMITS: "reactions=1/600" };
    const react = (ip) =>
      worker.fetch(
        new Request("https://svc.example/v1/reactions", {
          method: "POST",
          headers: { Origin: SITE, "Content-Type": "application/json", "CF-Connecting-IP": ip },
          body: JSON.stringify({ path: `/p-${ip}/`, reaction: "useful" })
        }),
        env,
        context()
      );

    assert.equal((await react("198.51.100.1")).status, 201);
    assert.equal((await react("198.51.100.1")).status, 429);
    assert.equal((await react("198.51.100.2")).status, 201);
  });

  it("answers a setting it cannot run with as a 500 that names nothing, and logs the reason", async () => {
    const errors = [];
    const original = console.error;
    console.error = (line) => errors.push(line);
    try {
      const response = await worker.fetch(get("/v1/capabilities"), { ...BASE_ENV, DB: await freshDb(), FEATURES: "chat" }, context());
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: { code: "misconfigured", message: "The service is not set up correctly." } });
      assert.match(errors.join("\n"), /chat/);
    } finally {
      console.error = original;
    }
  });

  it("runs the retention clean-up on its cron trigger", async () => {
    const db = await freshDb();
    await db
      .prepare("INSERT INTO contact_messages (id, category, name, email, subject, message, created_at) VALUES ('m_old', 'other', 'N', 'n@x.example', 'S', 'M', '2000-01-01T00:00:00Z')")
      .run();
    const logs = [];
    const original = console.log;
    console.log = (line) => logs.push(line);
    try {
      const ctx = context();
      await worker.scheduled({}, { ...BASE_ENV, DB: db }, ctx);
      await ctx.settled();
    } finally {
      console.log = original;
    }
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM contact_messages").first()).n, 0);
    assert.match(logs.join("\n"), /"event":"retention"/);
  });
});

describe("retention", () => {
  const NOW = Date.parse("2026-09-30T12:00:00Z");
  const OLD = "2025-01-01T00:00:00Z";
  const RECENT = "2026-09-29T00:00:00Z";

  async function seeded() {
    const db = await freshDb();
    const run = (sql) => db.prepare(sql).run();
    for (const [id, at] of [["m_old", OLD], ["m_new", RECENT]]) {
      await run(`INSERT INTO contact_messages (id, category, name, email, subject, message, created_at) VALUES ('${id}', 'other', 'N', 'n@x.example', 'S', 'M', '${at}')`);
    }
    await run(`INSERT INTO comments (id, path, author_name, body, status, created_at) VALUES ('c_spam', '/p/', 'S', 'spam', 'spam', '${OLD}')`);
    await run(`INSERT INTO comments (id, path, author_name, body, status, created_at) VALUES ('c_kept', '/p/', 'K', 'kept', 'approved', '${OLD}')`);
    await run(`INSERT INTO comments (id, path, author_name, body, status, created_at) VALUES ('c_parent', '/p/', 'P', 'deleted but replied to', 'deleted', '${OLD}')`);
    await run(`INSERT INTO comments (id, path, parent_id, author_name, body, status, created_at) VALUES ('c_reply', '/p/', 'c_parent', 'R', 'reply', 'approved', '${OLD}')`);
    await run(`INSERT INTO abuse_reports (id, comment_id, reason, status, created_at) VALUES ('a_1', 'c_spam', 'spam', 'hidden', '${OLD}')`);
    await run(`INSERT INTO subscribers (id, email, status, created_at) VALUES ('s_pending', 'p@x.example', 'pending', '${OLD}')`);
    await run(`INSERT INTO subscribers (id, email, status, created_at, unsubscribed_at) VALUES ('s_left', 'l@x.example', 'unsubscribed', '${OLD}', '${OLD}')`);
    await run(`INSERT INTO subscribers (id, email, status, created_at, confirmed_at) VALUES ('s_kept', 'k@x.example', 'confirmed', '${OLD}', '${OLD}')`);
    await run(`INSERT INTO corrections (id, path, article_url, category, message, status, created_at) VALUES ('r_done', '/p/', 'https://s/p/', 'code', 'm', 'resolved', '${OLD}')`);
    return db;
  }

  async function ids(db, table) {
    return (await db.prepare(`SELECT id FROM ${table} ORDER BY id`).all()).results.map((row) => row.id);
  }

  it("forgets what its periods say, and keeps the rest", async () => {
    const db = await seeded();
    const removed = await runRetention(db, {}, NOW);

    assert.deepEqual(await ids(db, "contact_messages"), ["m_new"]);
    assert.deepEqual(await ids(db, "comments"), ["c_kept", "c_parent", "c_reply"], "a deleted comment with a reply stays, for the thread");
    assert.deepEqual(await ids(db, "abuse_reports"), []);
    assert.deepEqual(await ids(db, "subscribers"), ["s_kept"]);
    assert.deepEqual(await ids(db, "corrections"), ["r_done"], "resolved reports are kept unless a period is set");
    assert.equal(removed.CONTACT_RETENTION_DAYS, 1);
  });

  it("takes each period from the settings, 0 meaning forever", async () => {
    const db = await seeded();
    await runRetention(db, { CONTACT_RETENTION_DAYS: "0", CORRECTION_RETENTION_DAYS: "30" }, NOW);

    assert.deepEqual(await ids(db, "contact_messages"), ["m_new", "m_old"]);
    assert.deepEqual(await ids(db, "corrections"), []);
    await assert.rejects(runRetention(db, { OUTBOX_DAYS: "soon" }, NOW), /OUTBOX_DAYS/);
    assert.equal(DEFAULTS.CONTACT_RETENTION_DAYS, 365);
  });
});
