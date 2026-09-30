import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SESSION_COOKIE, sessionCookies } from "../src/auth.js";
import { readConfig } from "../src/config.js";
import { BASE_ENV, SITE, call, clock, makeApp } from "./helpers.js";

const PATH = "/2024/04/05/sql-optimization-guide/";
const ENV = { FEATURES: "comments,corrections,moderation", MODERATORS: "Diogo, second-mod" };

/** The Cookie header of a session for a login, as the GitHub callback would have set it. */
async function session(login, env = ENV, now = Date.now()) {
  const config = readConfig({ ...BASE_ENV, ...env });
  const cookies = await sessionCookies(config, login, now);
  return cookies.map((line) => line.split(";")[0]).join("; ");
}

async function seed(app, db) {
  const comment = await call(app, "POST", "/v1/comments", { body: { path: PATH, author: { name: "Alice", email: "alice@example.org" }, body: "Does the clustering step hold for skewed keys?" } });
  const report = await call(app, "POST", "/v1/corrections", {
    body: {
      category: "code",
      section: "optimization-checklist",
      quote: "Cluster the fact table on purchase_ts",
      message: "The table clusters on customer_id, not purchase_ts.",
      contact_email: "reader@example.org",
      article: { url: `${SITE}${PATH}`, title: "SQL Optimization Playbook" }
    }
  });
  const published = await call(app, "POST", "/v1/comments", { body: { path: PATH, author: { name: "Bob" }, body: "Buy cheap watches at casino.example" } });
  await db.prepare("UPDATE comments SET status = 'approved' WHERE id = ?1").bind(published.json.comment.id).run();
  const abuse = await call(app, "POST", `/v1/comments/${published.json.comment.id}/reports`, { body: { reason: "Spam." } });
  return { comment: comment.json.comment.id, report: report.json.id, published: published.json.comment.id, abuse: abuse.json.id };
}

function act(app, cookie, itemId, payload, extra = {}) {
  return call(app, "POST", `/v1/moderation/items/${itemId}/actions`, { body: payload, headers: { Cookie: cookie, ...(extra.headers || {}) }, origin: extra.origin });
}

describe("who may moderate", () => {
  it("answers 401 without a session, 403 for someone who is not a moderator, and never an item", async () => {
    const { app, db } = await makeApp({ env: ENV });
    await seed(app, db);
    const signedOut = await call(app, "GET", "/v1/moderation/items");
    const stranger = await call(app, "GET", "/v1/moderation/items", { headers: { Cookie: await session("someone-else") } });
    const expired = await call(app, "GET", "/v1/moderation/items", { headers: { Cookie: await session("diogo", ENV, Date.now() - 9 * 3600 * 1000) } });

    assert.deepEqual([signedOut.status, signedOut.json.error.code, signedOut.json.items], [401, "unauthorized", undefined]);
    assert.deepEqual([stranger.status, stranger.json.error.code], [403, "forbidden"]);
    assert.equal(expired.status, 401, "sessions end after eight hours");
    assert.equal((await call(app, "GET", "/v1/moderation/items", { headers: { Cookie: `${SESSION_COOKIE}=forged.token` } })).status, 401);
  });

  it("takes a write only from the site, with the CSRF token when one is configured", async () => {
    const env = { ...ENV, CSRF_HEADER: "X-CSRF-Token", CSRF_COOKIE: "csrf_token" };
    const { app, db } = await makeApp({ env });
    const ids = await seed(app, db);
    const cookie = await session("diogo", env);
    const token = /csrf_token=([^;]+)/.exec(cookie)[1];

    const noOrigin = await act(app, cookie, ids.comment, { action: "approve" }, { origin: null });
    const noToken = await act(app, cookie, ids.comment, { action: "approve" });
    const wrongToken = await act(app, cookie, ids.comment, { action: "approve" }, { headers: { "X-CSRF-Token": "guess" } });
    const right = await act(app, cookie, ids.comment, { action: "approve" }, { headers: { "X-CSRF-Token": token } });

    assert.deepEqual([noOrigin.status, noOrigin.json.error.code], [403, "csrf_failed"]);
    assert.deepEqual([noToken.status, noToken.json.error.code], [403, "csrf_failed"]);
    assert.equal(wrongToken.status, 403);
    assert.equal(right.status, 200);
  });
});

describe("the queue", () => {
  it("lists what awaits a decision, each item in the shape the inbox reads", async () => {
    const { app, db } = await makeApp({ env: ENV });
    const ids = await seed(app, db);
    const { status, json } = await call(app, "GET", "/v1/moderation/items", { headers: { Cookie: await session("diogo") } });

    assert.equal(status, 200);
    assert.deepEqual(json.items.map((item) => item.type).sort(), ["abuse", "comment", "correction"]);
    const byType = Object.fromEntries(json.items.map((item) => [item.type, item]));
    assert.deepEqual(byType.comment, {
      id: ids.comment, type: "comment", status: "pending", created_at: byType.comment.created_at, path: PATH,
      author: { name: "Alice" }, body: "Does the clustering step hold for skewed keys?", history: []
    });
    assert.doesNotMatch(JSON.stringify(byType.comment), /alice@example/, "a comment's email is only a hash");
    assert.deepEqual(byType.correction, {
      id: ids.report, type: "correction", status: "new", created_at: byType.correction.created_at, path: PATH,
      title: "SQL Optimization Playbook", category: "code", message: "The table clusters on customer_id, not purchase_ts.",
      section: "optimization-checklist", quote: "Cluster the fact table on purchase_ts", author: { email: "reader@example.org" }, history: []
    });
    assert.deepEqual(byType.abuse, {
      id: ids.abuse, type: "abuse", status: "open", created_at: byType.abuse.created_at, path: PATH, reason: "Spam.",
      context: { parent: { author: { name: "Bob" }, body: "Buy cheap watches at casino.example" } }, history: []
    });
    assert.equal(json.next_cursor, undefined);
  });

  it("filters by type, status, path, category, date and text", async () => {
    const { app, db } = await makeApp({ env: ENV });
    const ids = await seed(app, db);
    const cookie = await session("diogo");
    const idsOf = async (query) => (await call(app, "GET", `/v1/moderation/items?${query}`, { headers: { Cookie: cookie } })).json.items.map((item) => item.id);

    assert.deepEqual(await idsOf("type=correction"), [ids.report]);
    assert.deepEqual(await idsOf("status=approved"), [ids.published]);
    assert.deepEqual(await idsOf("category=code"), [ids.report]);
    assert.deepEqual(await idsOf("q=casino"), [], "the queue alone: the comment that says casino is approved, so not in it");
    assert.deepEqual(await idsOf("q=casino&status=approved"), [ids.published]);
    assert.deepEqual(await idsOf("q=100%25"), [], "a % in the text is literal");
    assert.deepEqual((await idsOf(`path=${encodeURIComponent("/other/")}`)), []);
    assert.deepEqual((await idsOf("since=2999-01-01")), []);
    const bad = await call(app, "GET", "/v1/moderation/items?type=chat&since=soon", { headers: { Cookie: cookie } });
    assert.deepEqual([bad.status, Object.keys(bad.json.error.errors).sort()], [422, ["since", "type"]]);
  });

  it("pages with a cursor, newest first", async () => {
    const now = clock();
    const { app } = await makeApp({ env: { ...ENV, RATE_LIMITS: "comments=100/600" }, now });
    for (let index = 0; index < 23; index += 1) {
      now.advance(1000);
      await call(app, "POST", "/v1/comments", { body: { path: PATH, author: { name: `Reader ${index}` }, body: `Comment number ${index}` } });
    }
    const cookie = await session("diogo", ENV, now());
    const first = await call(app, "GET", "/v1/moderation/items", { headers: { Cookie: cookie } });
    const second = await call(app, "GET", `/v1/moderation/items?cursor=${first.json.next_cursor}`, { headers: { Cookie: cookie } });

    assert.equal(first.json.items.length, 20);
    assert.equal(first.json.items[0].author.name, "Reader 22");
    assert.deepEqual(second.json.items.map((item) => item.author.name), ["Reader 2", "Reader 1", "Reader 0"]);
    assert.equal(second.json.next_cursor, undefined);
    assert.equal((await call(app, "GET", "/v1/moderation/items?cursor=nonsense", { headers: { Cookie: cookie } })).status, 422);
  });
});

describe("acting", () => {
  it("approves a comment, records who did it, and publishes it", async () => {
    const { app, db } = await makeApp({ env: ENV });
    const ids = await seed(app, db);
    const cookie = await session("Diogo");
    const { status, json } = await act(app, cookie, ids.comment, { action: "approve", note: "Fine." }, { headers: { "Idempotency-Key": "a1" } });

    assert.equal(status, 200);
    assert.equal(json.item.status, "approved");
    assert.deepEqual(json.item.history.map(({ action, moderator, note }) => ({ action, moderator, note })), [{ action: "approve", moderator: "Diogo", note: "Fine." }]);
    const thread = await call(app, "GET", `/v1/comments?path=${encodeURIComponent(PATH)}`);
    assert.ok(thread.json.comments.some((comment) => comment.id === ids.comment));

    const replay = await act(app, cookie, ids.comment, { action: "approve", note: "Fine." }, { headers: { "Idempotency-Key": "a1" } });
    assert.deepEqual(replay.json, json, "a retried action is not applied twice");
    const again = await act(app, cookie, ids.comment, { action: "approve" });
    assert.deepEqual([again.status, again.json.error.code], [409, "conflict"], "approved already");
  });

  it("walks a correction through review, acceptance and resolution with a link", async () => {
    const { app, db } = await makeApp({ env: ENV });
    const ids = await seed(app, db);
    const cookie = await session("second-mod");

    assert.equal((await act(app, cookie, ids.report, { action: "reviewed", note: "Checking the DDL." })).json.item.status, "reviewed");
    assert.equal((await act(app, cookie, ids.report, { action: "accept" })).json.item.status, "accepted");
    const missing = await act(app, cookie, ids.report, { action: "resolve" });
    assert.deepEqual([missing.status, Object.keys(missing.json.error.errors)], [422, ["link"]]);
    const resolved = await act(app, cookie, ids.report, { action: "resolve", link: "https://github.com/example/site/pull/42" });
    assert.equal(resolved.json.item.status, "resolved");
    assert.deepEqual(resolved.json.item.resolution, { url: "https://github.com/example/site/pull/42" });
    assert.deepEqual(resolved.json.item.history.map((step) => step.action), ["reviewed", "accept", "resolve"]);
    assert.equal(resolved.json.item.history[2].link, "https://github.com/example/site/pull/42");
  });

  it("hides the reported comment when an abuse report is upheld", async () => {
    const { app, db } = await makeApp({ env: ENV });
    const ids = await seed(app, db);
    const { json } = await act(app, await session("diogo"), ids.abuse, { action: "hide" });

    assert.equal(json.item.status, "hidden");
    assert.equal((await db.prepare("SELECT status FROM comments WHERE id = ?1").bind(ids.published).first()).status, "hidden");
    const thread = await call(app, "GET", `/v1/comments?path=${encodeURIComponent(PATH)}`);
    assert.ok(!thread.json.comments.some((comment) => comment.id === ids.published));
  });

  it("refuses an action the item's status does not allow, and an item that does not exist", async () => {
    const { app, db } = await makeApp({ env: ENV });
    const ids = await seed(app, db);
    const cookie = await session("diogo");

    assert.equal((await act(app, cookie, ids.comment, { action: "resolve", link: "https://x.example" })).status, 409);
    assert.equal((await act(app, cookie, ids.report, { action: "approve" })).status, 409);
    assert.equal((await act(app, cookie, "c_nothing", { action: "approve" })).status, 404);
    assert.equal((await act(app, cookie, "zz_1", { action: "approve" })).status, 404);
    const history = await db.prepare("SELECT COUNT(*) AS n FROM moderation_history").first();
    assert.equal(history.n, 0, "a refused action leaves no trace");
  });
});

describe("signing in with GitHub", () => {
  const OAUTH = { ...ENV, GITHUB_CLIENT_ID: "Iv1.client", GITHUB_CLIENT_SECRET: "github-secret" };

  function github(login) {
    const requests = [];
    const fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).startsWith("https://github.com/login/oauth/access_token")) {
        return Response.json({ access_token: "gho_test" });
      }
      return Response.json({ login });
    };
    return { fetch, requests };
  }

  it("sends a moderator to GitHub and back, starting a session", async () => {
    const { fetch, requests } = github("diogo");
    const { app } = await makeApp({ env: OAUTH, services: { fetch } });
    const start = await call(app, "GET", `/auth/login?return_to=${encodeURIComponent(`${SITE}/admin/moderation/`)}`, { origin: null });

    assert.equal(start.status, 302);
    const location = new URL(start.headers.get("Location"));
    assert.equal(location.origin + location.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(location.searchParams.get("client_id"), "Iv1.client");
    assert.equal(location.searchParams.get("redirect_uri"), "https://api.example/auth/callback");
    const stateCookie = start.headers.getSetCookie()[0];
    assert.match(stateCookie, /^datalog_oauth_state=.+; Path=\/; Secure; SameSite=Lax; HttpOnly; Max-Age=600$/);

    const back = await call(app, "GET", `/auth/callback?code=abc&state=${location.searchParams.get("state")}`, {
      origin: null,
      headers: { Cookie: stateCookie.split(";")[0] }
    });
    assert.equal(back.status, 302);
    assert.equal(back.headers.get("Location"), `${SITE}/admin/moderation/`);
    const sessionLine = back.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`));
    assert.match(sessionLine, /; Path=\/; Secure; SameSite=None; HttpOnly; Max-Age=28800$/);
    assert.equal(JSON.parse(requests[0].init.body).client_secret, "github-secret");

    const inbox = await call(app, "GET", "/v1/moderation/items", { headers: { Cookie: sessionLine.split(";")[0] } });
    assert.equal(inbox.status, 200);
  });

  it("refuses a callback whose state this browser was not given, and a return address off the site", async () => {
    const { fetch } = github("diogo");
    const { app } = await makeApp({ env: OAUTH, services: { fetch } });
    const start = await call(app, "GET", "/auth/login", { origin: null });
    const state = new URL(start.headers.get("Location")).searchParams.get("state");

    const withoutCookie = await call(app, "GET", `/auth/callback?code=abc&state=${state}`, { origin: null });
    assert.deepEqual([withoutCookie.status, withoutCookie.json.error.code], [400, "invalid_state"]);
    const elsewhere = await call(app, "GET", `/auth/login?return_to=${encodeURIComponent("https://evil.example/")}`, { origin: null });
    assert.equal(elsewhere.status, 400);
  });

  it("says sign-in is not set up without GitHub's credentials, and signs out", async () => {
    const { app } = await makeApp({ env: ENV });
    const login = await call(app, "GET", "/auth/login", { origin: null });
    assert.deepEqual([login.status, login.json.error.code], [500, "misconfigured"]);

    const out = await call(app, "POST", "/auth/logout");
    assert.equal(out.status, 204);
    assert.match(out.headers.getSetCookie()[0], /^datalog_session=; .*Max-Age=0$/);
  });
});
