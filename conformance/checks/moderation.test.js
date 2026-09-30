/**
 * The moderation inbox's API: authentication on every request, CORS with
 * credentials, the queue, actions that follow the documented transitions,
 * and CSRF protection on its cookie-authenticated writes.
 */

import assert from "node:assert/strict";
import { before, describe } from "node:test";
import {
  NO_HOOKS,
  check,
  describe as show,
  expectError,
  expectSchema,
  expectStatus,
  hooks,
  offers,
  pagePath,
  pageUrl,
  request,
  reset,
  sessionFor,
  settings,
  should,
  unique,
  v
} from "../lib/suite.js";

const skip = !offers("moderation") && "the service does not offer moderation";

describe("moderation", { skip }, () => {
  let moderator;
  let stranger;

  before(async () => {
    await reset();
    if (hooks) {
      moderator = await sessionFor(settings.moderator);
      stranger = await sessionFor(`not-a-moderator-${settings.runId}`);
    }
  });

  const items = (query = "", cookie = moderator) => request("GET", v(`/moderation/items${query}`), { cookie });
  const act = (id, body, options = {}) =>
    request("POST", v(`/moderation/items/${encodeURIComponent(id)}/actions`), { cookie: moderator, key: unique("act"), body, ...options });

  check("without a session the queue is a 401, and no item is sent", async () => {
    const response = await request("GET", v("/moderation/items"));
    expectError(response, 401);
    assert.equal(response.json.items, undefined, "A refusal must carry no items.");
  });

  check("a signed-in account that may not moderate gets a 403, and no item", async (t) => {
    if (!hooks) {
      t.skip(NO_HOOKS);
      return;
    }
    const response = await items("", stranger);
    expectError(response, 403);
    assert.equal(response.json.items, undefined, "A refusal must carry no items.");
  });

  check("the queue answers the site's origin with credentials allowed", async (t) => {
    if (!hooks) {
      t.skip(NO_HOOKS);
      return;
    }
    const response = await items();
    expectStatus(response, 200);
    expectSchema(response, "listModerationItems");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), settings.origin, "The origin must be named exactly for a credentialed request.");
    assert.equal(response.headers.get("Access-Control-Allow-Credentials"), "true");
  });

  check("a held comment is in the queue, and approving it follows the documented transition", async (t) => {
    if (!hooks || !offers("comments")) {
      t.skip(hooks ? "the service does not offer comments" : NO_HOOKS);
      return;
    }
    const posted = await request("POST", v("/comments"), {
      key: unique("comment"),
      body: { path: pagePath(), parent_id: null, author: { name: "Queued" }, body: "A comment for the moderation checks." }
    });
    if (posted.status !== 202) {
      t.skip("the service publishes comments without moderation");
      return;
    }
    const queue = await items("?type=comment");
    expectSchema(queue, "listModerationItems");
    const item = queue.json.items.find((entry) => entry.id === posted.json.comment.id);
    assert.ok(item, `The held comment is not in the queue. ${show(queue)}`);
    assert.equal(item.status, "pending");

    const key = unique("approve");
    const approved = await act(item.id, { action: "approve", note: "Conformance." }, { key });
    expectStatus(approved, 200);
    expectSchema(approved, "actOnModerationItem");
    assert.equal(approved.json.item.status, "approved", show(approved));
    assert.ok(approved.json.item.history.some((step) => step.action === "approve"), "The action must be in the item's history.");

    const replay = await act(item.id, { action: "approve", note: "Conformance." }, { key });
    assert.deepEqual([replay.status, replay.json], [approved.status, approved.json], "A retried action with the same key must get the first answer.");
    expectError(await act(item.id, { action: "approve" }), 409);
  });

  check("a correction report cannot be resolved without a link (422), and is with one", async (t) => {
    if (!hooks || !offers("corrections")) {
      t.skip(hooks ? "the service does not offer corrections" : NO_HOOKS);
      return;
    }
    const reported = await request("POST", v("/corrections"), {
      key: unique("report"),
      body: { category: "other", message: "A report for the moderation checks, long enough.", article: { url: pageUrl(pagePath()), title: "Article" } }
    });
    const queue = await items("?type=correction");
    const item = queue.json.items.find((entry) => entry.id === reported.json?.id) || queue.json.items[0];
    assert.ok(item, `The report is not in the queue. ${show(queue)}`);
    expectStatus(await act(item.id, { action: "accept" }), 200);
    expectError(await act(item.id, { action: "resolve" }), 422, { fields: ["link"] });
    const resolved = await act(item.id, { action: "resolve", link: "https://github.com/example/site/pull/1" });
    expectStatus(resolved, 200);
    assert.equal(resolved.json.item.status, "resolved", show(resolved));
  });

  check("an action sent from another origin is refused (CSRF)", async (t) => {
    if (!hooks) {
      t.skip(NO_HOOKS);
      return;
    }
    const response = await act(`c_${settings.runId}`, { action: "approve" }, { origin: "https://conformance-foreign-origin.invalid" });
    expectError(response, 403);
  });

  should("an action with no Origin at all is refused (CSRF)", async (t) => {
    if (!hooks) {
      t.skip(NO_HOOKS);
      return;
    }
    expectError(await act(`c_${settings.runId}`, { action: "approve" }, { origin: null }), 403);
  });
});
