/** Reactions: counts, a reaction counted, a retry counted once, a second reaction refused. */

import assert from "node:assert/strict";
import { before, describe } from "node:test";
import { check, describe as show, expectError, expectSchema, expectStatus, offers, pagePath, request, reset, should, unique, v } from "../lib/suite.js";

const skip = !offers("reactions") && "the service does not offer reactions";

function counts(path) {
  return request("GET", v(`/reactions?path=${encodeURIComponent(path)}`));
}

/** The first reaction type the service takes: the theme's default types, in order. */
async function react(path, key = unique("react")) {
  let last;
  for (const reaction of ["useful", "clear", "interesting", "needs-clarification"]) {
    last = await request("POST", v("/reactions"), { key, body: { path, reaction } });
    if (last.status !== 422) {
      return { response: last, reaction };
    }
  }
  return { response: last, reaction: null };
}

describe("reactions", { skip }, () => {
  before(reset);

  check("a page nobody reacted to has empty counts", async () => {
    const response = await counts(pagePath());
    expectStatus(response, 200);
    expectSchema(response, "getReactions");
    assert.deepEqual(response.json.counts, {}, `No reactions yet. ${show(response)}`);
  });

  check("a reaction is counted, and the answer carries the new counts", async () => {
    const path = pagePath();
    const { response, reaction } = await react(path);
    assert.ok(reaction, "None of the theme's default reaction types (useful, clear, interesting, needs-clarification) was accepted.");
    expectStatus(response, 201);
    expectSchema(response, "react");
    assert.equal(response.json.reaction, reaction);
    assert.ok(response.json.counts[reaction] >= 1, `The answer's counts must include this reaction. ${show(response)}`);
    const read = await counts(path);
    assert.equal(read.json.counts[reaction], 1, `Reading the counts must show it. ${show(read)}`);
  });

  check("a retried reaction with the same Idempotency-Key is counted once and answered the same", async () => {
    const path = pagePath();
    const key = unique("same-key");
    const first = await react(path, key);
    const second = await request("POST", v("/reactions"), { key, body: { path, reaction: first.reaction } });
    assert.equal(second.status, first.response.status, `The retry must get the first answer. ${show(second)}`);
    assert.deepEqual(second.json, first.response.json, "The retry must get the first answer's body.");
    assert.equal((await counts(path)).json.counts[first.reaction], 1, "Counted once.");
  });

  should("a second reaction from the same reader is a 409, which the theme shows as counted", async () => {
    const path = pagePath();
    const first = await react(path);
    const second = await request("POST", v("/reactions"), { key: unique("again"), body: { path, reaction: first.reaction } });
    expectError(second, 409);
  });

  should("a type the service does not offer is a 422 naming reaction", async () => {
    const response = await request("POST", v("/reactions"), { key: unique("bad"), body: { path: pagePath(), reaction: "conformance-no-such-reaction" } });
    expectError(response, 422, { fields: ["reaction"] });
  });
});
