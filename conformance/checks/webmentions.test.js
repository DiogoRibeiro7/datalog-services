/** Webmentions: the read route, and with the hooks, verified mentions newest first. */

import assert from "node:assert/strict";
import { before, describe } from "node:test";
import { NO_HOOKS, check, describe as show, expectError, expectSchema, expectStatus, hook, hooks, offers, pagePath, pageUrl, request, reset, should, v } from "../lib/suite.js";

const skip = !offers("webmentions") && "the service does not offer webmentions";

function mentions(target) {
  return request("GET", v(`/webmentions?target=${encodeURIComponent(target)}`));
}

describe("webmentions", { skip }, () => {
  before(reset);

  check("a page nobody mentioned reads as an empty list", async () => {
    const response = await mentions(pageUrl(pagePath()));
    expectStatus(response, 200);
    expectSchema(response, "listWebmentions");
    assert.deepEqual(response.json.mentions, [], show(response));
  });

  check("verified mentions are served, newest first, in the documented shape", async (t) => {
    if (!hooks) {
      t.skip(NO_HOOKS);
      return;
    }
    const target = pageUrl(pagePath());
    const seed = (id, publishedAt) =>
      hook("POST", "/webmentions", {
        body: { source: `https://source.conformance.invalid/${id}`, target, type: "reply", title: `Mention ${id}`, excerpt: "Plain text.", author: { name: "Author" }, published_at: publishedAt }
      });
    await seed("old", "2026-01-01T00:00:00Z");
    await seed("new", "2026-06-01T00:00:00Z");
    const response = await mentions(target);
    expectSchema(response, "listWebmentions");
    assert.deepEqual(response.json.mentions.map((mention) => mention.title), ["Mention new", "Mention old"], `Newest first. ${show(response)}`);
    assert.ok(response.json.mentions.every((mention) => mention.verified === true), "Only verified mentions, marked verified: true.");
  });

  should("reading without a target is a 422 naming target", async () => {
    expectError(await request("GET", v("/webmentions")), 422, { fields: ["target"] });
  });
});
