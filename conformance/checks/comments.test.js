/**
 * Comments: the thread of a page, posting, the fields a 422 names, and a
 * retried post stored once.
 */

import assert from "node:assert/strict";
import { before, describe } from "node:test";
import {
  NO_HOOKS,
  check,
  describe as show,
  expectError,
  expectRequestId,
  expectSchema,
  expectStatus,
  hooks,
  offers,
  pagePath,
  request,
  reset,
  sessionFor,
  settings,
  should,
  unique,
  v
} from "../lib/suite.js";

const skip = !offers("comments") && "the service does not offer comments";

function post(path, extra = {}, options = {}) {
  return request("POST", v("/comments"), {
    key: options.key || unique("comment"),
    body: { path, parent_id: null, author: { name: "Conformance Reader", email: "reader@conformance.invalid" }, body: "A comment from the conformance suite.", ...extra }
  });
}

function thread(path) {
  return request("GET", v(`/comments?path=${encodeURIComponent(path)}`));
}

/** Publishes a held comment through the moderation API, when the service offers both. */
async function publish(t, answer) {
  if (answer.status === 201) {
    return true;
  }
  if (!hooks || !offers("moderation")) {
    t.skip(hooks ? "the comment is held and the service does not offer moderation" : NO_HOOKS);
    return false;
  }
  const cookie = await sessionFor(settings.moderator);
  const approved = await request("POST", v(`/moderation/items/${encodeURIComponent(answer.json.comment.id)}/actions`), {
    cookie,
    key: unique("approve"),
    body: { action: "approve" }
  });
  expectStatus(approved, 200);
  return true;
}

describe("comments", { skip }, () => {
  before(reset);

  check("a page with no comments reads as an empty list", async () => {
    const response = await thread(pagePath("empty"));
    expectStatus(response, 200);
    expectSchema(response, "listComments");
    assert.deepEqual(response.json.comments, [], `A new page has no comments. ${show(response)}`);
  });

  check("a comment is published (201) or held for moderation (202), in the documented shape and without the email", async () => {
    const response = await post(pagePath());
    expectStatus(response, 201, 202);
    expectSchema(response, "createComment");
    expectRequestId(response);
    assert.equal(response.json.status, response.status === 201 ? "published" : "pending", `status must say what happened. ${show(response)}`);
    assert.doesNotMatch(response.text, /reader@conformance\.invalid/, "The author's email must never be returned.");
  });

  check("a 422 names the fields the theme marks: name, email, url, body", async () => {
    const response = await request("POST", v("/comments"), {
      key: unique("invalid"),
      body: { path: pagePath(), parent_id: null, author: { name: "", email: "not-an-email", url: "javascript:alert(1)" }, body: "" }
    });
    expectError(response, 422, { fields: ["name", "email", "url", "body"] });
    expectSchema(response, "createComment");
  });

  check("a retried post with the same Idempotency-Key is stored once and answered the same", async (t) => {
    const path = pagePath("retry");
    const key = unique("same-key");
    const first = await post(path, {}, { key });
    const second = await post(path, {}, { key });
    expectStatus(first, 201, 202);
    assert.equal(second.status, first.status, `The retry must get the first answer's status. ${show(second)}`);
    assert.deepEqual(second.json, first.json, "The retry must get the first answer's body.");
    if (await publish(t, first)) {
      const listed = await thread(path);
      assert.equal(listed.json.comments.length, 1, `The comment was stored ${listed.json.comments.length} times. ${show(listed)}`);
    }
  });

  check("a published comment is served with public author fields only, oldest first, and replies name their parent", async (t) => {
    const path = pagePath("thread");
    const first = await post(path, { author: { name: "First", email: "first@conformance.invalid", url: "https://first.conformance.invalid/" } });
    if (!(await publish(t, first))) {
      return;
    }
    const reply = await post(path, { parent_id: first.json.comment.id, author: { name: "Second" }, body: "A reply from the conformance suite." });
    if (!(await publish(t, reply))) {
      return;
    }
    const listed = await thread(path);
    expectSchema(listed, "listComments");
    assert.deepEqual(listed.json.comments.map((comment) => comment.author.name), ["First", "Second"], `Oldest first. ${show(listed)}`);
    assert.equal(listed.json.comments[1].parent_id, first.json.comment.id, "The reply names its parent.");
    assert.doesNotMatch(listed.text, /first@conformance\.invalid/, "An email must never be served.");
  });

  check("a held comment is not served before it is approved", async (t) => {
    const path = pagePath("held");
    const answer = await post(path);
    if (answer.status !== 202) {
      t.skip(`the comment was not held for moderation (the service answered ${answer.status})`);
      return;
    }
    const listed = await thread(path);
    assert.deepEqual(listed.json.comments, [], `A pending comment was served. ${show(listed)}`);
  });

  should("reading without a path is a 422 naming path", async () => {
    expectError(await request("GET", v("/comments")), 422, { fields: ["path"] });
  });
});
