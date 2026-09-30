import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMailer, mailProblem } from "../src/mail.js";
import { SITE, call, clock, makeApp } from "./helpers.js";

const ENV = { FEATURES: "subscriptions", MAIL_PROVIDER: "outbox", SUBSCRIPTION_TOPICS: "new-articles,research-notes,datasets", SITE_NAME: "Test Site" };

async function outbox(db, to) {
  const { results } = await db.prepare("SELECT * FROM outbox WHERE to_address = ?1 ORDER BY created_at, id").bind(to).all();
  return results.map((row) => ({ ...row, headers: JSON.parse(row.headers) }));
}

/** The token after `?name=` in the last mail to an address. */
async function tokenFrom(db, to, name) {
  const mails = await outbox(db, to);
  const match = new RegExp(`[?&]${name}=([A-Za-z0-9_.-]+)`).exec(mails.at(-1)?.text || "");
  assert.ok(match, `no ${name} link in: ${mails.at(-1)?.text}`);
  return match[1];
}

const subscription = { email: "Reader@Example.org", topics: ["new-articles", "research-notes"], source_url: `${SITE}/`, locale: "en" };

describe("subscribing", () => {
  it("answers 202 pending and mails a confirmation link to the subscriptions page", async () => {
    const { app, db } = await makeApp({ env: ENV });
    const { status, json } = await call(app, "POST", "/v1/subscriptions", { headers: { "Idempotency-Key": "s1" }, body: subscription });

    assert.deepEqual([status, json], [202, { status: "pending" }]);
    const [mail] = await outbox(db, "reader@example.org");
    assert.equal(mail.subject, "Confirm your subscription to Test Site");
    assert.match(mail.text, /https:\/\/site\.example\/subscriptions\/\?confirm=/);
    const row = await db.prepare("SELECT status, topics, locale FROM subscribers").first();
    assert.deepEqual(row, { status: "pending", topics: '["new-articles","research-notes"]', locale: "en" });
  });

  it("confirms through the link, then serves, changes and ends the subscription with the manage link", async () => {
    const { app, db } = await makeApp({ env: ENV });
    await call(app, "POST", "/v1/subscriptions", { body: subscription });
    const confirmToken = await tokenFrom(db, "reader@example.org", "confirm");

    const confirmed = await call(app, "POST", "/v1/subscriptions/confirm", { body: { token: confirmToken } });
    assert.deepEqual([confirmed.status, confirmed.json], [200, { status: "confirmed" }]);
    assert.deepEqual((await call(app, "POST", "/v1/subscriptions/confirm", { body: { token: confirmToken } })).json, { status: "confirmed" }, "a second click is fine");

    const welcome = (await outbox(db, "reader@example.org")).at(-1);
    assert.equal(welcome.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.match(welcome.headers["List-Unsubscribe"], /^<https:\/\/api\.example\/mail\/unsubscribe\/.+>$/);
    const manage = await tokenFrom(db, "reader@example.org", "manage");

    assert.deepEqual((await call(app, "GET", `/v1/subscriptions/${manage}`)).json, { status: "confirmed", topics: ["new-articles", "research-notes"] });
    const changed = await call(app, "PATCH", `/v1/subscriptions/${manage}`, { body: { topics: ["datasets"] } });
    assert.deepEqual([changed.status, changed.json], [200, { status: "confirmed", topics: ["datasets"] }]);

    const ended = await call(app, "DELETE", `/v1/subscriptions/${manage}`);
    assert.equal(ended.status, 204);
    const after = await call(app, "GET", `/v1/subscriptions/${manage}`);
    assert.deepEqual([after.status, after.json.error.code], [410, "token_expired"], "every earlier link stops working");
  });

  it("answers a bad token with 404 and an expired confirmation with 410", async () => {
    const now = clock();
    const { app, db } = await makeApp({ env: ENV, now });
    await call(app, "POST", "/v1/subscriptions", { body: subscription });
    const token = await tokenFrom(db, "reader@example.org", "confirm");

    const bad = await call(app, "GET", "/v1/subscriptions/not-a-token");
    assert.deepEqual([bad.status, bad.json.error.code], [404, "invalid_token"]);
    const wrongPurpose = await call(app, "GET", `/v1/subscriptions/${token}`);
    assert.equal(wrongPurpose.status, 404, "a confirm token does not manage");

    now.advance(3 * 24 * 60 * 60 * 1000);
    const late = await call(app, "POST", "/v1/subscriptions/confirm", { body: { token } });
    assert.deepEqual([late.status, late.json.error.code], [410, "token_expired"]);
  });

  it("does not disclose a subscribed address unless told to", async () => {
    const quiet = await makeApp({ env: ENV });
    await call(quiet.app, "POST", "/v1/subscriptions", { body: subscription });
    await call(quiet.app, "POST", "/v1/subscriptions/confirm", { body: { token: await tokenFrom(quiet.db, "reader@example.org", "confirm") } });
    const again = await call(quiet.app, "POST", "/v1/subscriptions", { body: subscription });
    assert.deepEqual([again.status, again.json], [202, { status: "pending" }]);
    assert.match((await outbox(quiet.db, "reader@example.org")).at(-1).text, /already subscribed/);

    const open = await makeApp({ env: { ...ENV, SUBSCRIPTIONS_DISCLOSE: "true" } });
    await call(open.app, "POST", "/v1/subscriptions", { body: subscription });
    await call(open.app, "POST", "/v1/subscriptions/confirm", { body: { token: await tokenFrom(open.db, "reader@example.org", "confirm") } });
    const duplicate = await call(open.app, "POST", "/v1/subscriptions", { body: subscription });
    assert.deepEqual([duplicate.status, duplicate.json.error.code], [409, "already_subscribed"]);
  });

  it("confirms at once without double opt-in", async () => {
    const { app, db } = await makeApp({ env: { ...ENV, SUBSCRIPTIONS_DOUBLE_OPT_IN: "false" } });
    const { status, json } = await call(app, "POST", "/v1/subscriptions", { body: subscription });
    assert.deepEqual([status, json], [201, { status: "confirmed" }]);
    assert.ok(await tokenFrom(db, "reader@example.org", "manage"));
  });

  it("does not mail a pending address again within five minutes, and welcomes back one that left", async () => {
    const now = clock();
    const { app, db } = await makeApp({ env: { ...ENV, RATE_LIMITS: "subscriptions-address=10/3600" }, now });
    await call(app, "POST", "/v1/subscriptions", { body: subscription });
    await call(app, "POST", "/v1/subscriptions", { body: subscription });
    assert.equal((await outbox(db, "reader@example.org")).length, 1);
    now.advance(6 * 60 * 1000);
    await call(app, "POST", "/v1/subscriptions", { body: subscription });
    assert.equal((await outbox(db, "reader@example.org")).length, 2);

    await call(app, "POST", "/v1/subscriptions/confirm", { body: { token: await tokenFrom(db, "reader@example.org", "confirm") } });
    await call(app, "DELETE", `/v1/subscriptions/${await tokenFrom(db, "reader@example.org", "manage")}`);
    const back = await call(app, "POST", "/v1/subscriptions", { body: subscription });
    assert.deepEqual(back.json, { status: "pending" });
    assert.equal((await db.prepare("SELECT status, token_version FROM subscribers").first()).token_version, 3);
  });

  it("names the fields at fault", async () => {
    const { app } = await makeApp({ env: ENV });
    const { status, json } = await call(app, "POST", "/v1/subscriptions", { body: { email: "nope", topics: ["gossip"] } });
    assert.deepEqual([status, Object.keys(json.error.errors).sort()], [422, ["email", "topics"]]);
    const none = await call(app, "POST", "/v1/subscriptions", { body: { email: "a@b.example", topics: [] } });
    assert.equal(none.json.error.errors.topics, "Choose at least one.");
  });

  it("limits sign-ups per address as well as per client", async () => {
    const { app } = await makeApp({ env: { ...ENV, RATE_LIMITS: "subscriptions-address=2/3600" } });
    const statuses = [];
    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
      statuses.push((await call(app, "POST", "/v1/subscriptions", { body: subscription, ip })).status);
    }
    assert.deepEqual(statuses, [202, 202, 429]);
  });

  it("unsubscribes with one click from a mail client, and says nothing about a bad token", async () => {
    const { app, db } = await makeApp({ env: ENV });
    await call(app, "POST", "/v1/subscriptions", { body: subscription });
    await call(app, "POST", "/v1/subscriptions/confirm", { body: { token: await tokenFrom(db, "reader@example.org", "confirm") } });
    const oneClick = (await outbox(db, "reader@example.org")).at(-1).headers["List-Unsubscribe"].slice(1, -1);
    const path = new URL(oneClick).pathname;

    const done = await call(app, "POST", path, { origin: null, raw: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    assert.deepEqual([done.status, done.json], [200, { status: "unsubscribed" }]);
    assert.equal((await db.prepare("SELECT status FROM subscribers").first()).status, "unsubscribed");
    assert.equal((await call(app, "POST", "/mail/unsubscribe/garbage", { origin: null })).status, 200);
  });
});

describe("mail", () => {
  it("refuses to switch subscriptions on without a way to send mail", async () => {
    await assert.rejects(makeApp({ env: { FEATURES: "subscriptions" } }), /MAIL_PROVIDER/);
    await assert.rejects(makeApp({ env: { FEATURES: "subscriptions", MAIL_PROVIDER: "resend" } }), /RESEND_API_KEY/);
    assert.equal(mailProblem({ MAIL_PROVIDER: "pigeon" }), 'MAIL_PROVIDER must be one of resend, outbox; got "pigeon"');
  });

  it("sends through Resend's API with the key from the environment", async () => {
    const requests = [];
    const fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    };
    const mailer = createMailer({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test", MAIL_FROM: "Site <news@site.example>" }, { fetch });
    await mailer.send({ to: "a@b.example", subject: "Hello", text: "Body", replyTo: "c@d.example", headers: { "List-Unsubscribe": "<x>" } });

    assert.equal(requests[0].url, "https://api.resend.com/emails");
    assert.equal(requests[0].init.headers.Authorization, "Bearer re_test");
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      from: "Site <news@site.example>",
      to: ["a@b.example"],
      subject: "Hello",
      text: "Body",
      reply_to: "c@d.example",
      headers: { "List-Unsubscribe": "<x>" }
    });

    const failing = createMailer({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "k", MAIL_FROM: "f@s.example" }, { fetch: async () => new Response("", { status: 500 }) });
    await assert.rejects(failing.send({ to: "a@b.example", subject: "s", text: "t" }), { code: "mail_failed", status: 502 });
  });

  it("answers a sign-up the mail provider could not send with a 502, and stores nothing twice on the retry", async () => {
    let fail = true;
    const sent = [];
    const mailer = { send: async (mail) => {
      sent.push(mail);
      if (fail) {
        const { HttpError } = await import("../src/http.js");
        throw new HttpError(502, "mail_failed", "The service could not send the email.");
      }
    } };
    const { app, db } = await makeApp({ env: ENV, services: { mailer } });
    const first = await call(app, "POST", "/v1/subscriptions", { body: subscription, headers: { "Idempotency-Key": "k" } });
    fail = false;
    const retried = await call(app, "POST", "/v1/subscriptions", { body: subscription, headers: { "Idempotency-Key": "k" } });

    assert.deepEqual([first.status, first.json.error.code], [502, "mail_failed"]);
    assert.equal(retried.status, 202);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM subscribers").first()).n, 1);
    assert.equal(sent.length, 2, "the retry sends the confirmation that failed");
  });
});
