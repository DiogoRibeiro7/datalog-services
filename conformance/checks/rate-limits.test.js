/**
 * Rate limits, last because they spend the client's allowance: writes to one
 * feature until the service answers 429, which must say how long to wait.
 */

import assert from "node:assert/strict";
import { after, before, describe } from "node:test";
import { check, expectError, expectRetryAfter, offers, pagePath, pageUrl, request, reset, settings, unique, v } from "../lib/suite.js";

const WRITES = {
  corrections: () => ({
    path: v("/corrections"),
    body: { category: "other", message: "A report for the rate-limit check, long enough.", article: { url: pageUrl(pagePath()), title: "Article" } }
  }),
  contact: () => ({
    path: v("/contact"),
    body: { category: "other", name: "Probe", email: "probe@conformance.invalid", subject: "Probe", message: "A message for the rate-limit check.", source_url: pageUrl("/") }
  }),
  comments: () => ({ path: v("/comments"), body: { path: pagePath(), parent_id: null, author: { name: "Probe" }, body: "A comment for the rate-limit check." } }),
  reactions: () => ({ path: v("/reactions"), body: { path: pagePath(), reaction: "useful" } })
};

const feature = Object.keys(WRITES).find(offers);

describe("rate limits", { skip: !feature && "the service offers no write to probe" }, () => {
  before(reset);
  after(reset);

  check(`writes beyond the allowance answer 429 with Retry-After (probing ${feature})`, async () => {
    for (let attempt = 1; attempt <= settings.rateLimitProbe; attempt += 1) {
      const write = WRITES[feature]();
      const response = await request("POST", write.path, { key: unique("probe"), body: write.body });
      if (response.status === 429) {
        expectError(response, 429);
        expectRetryAfter(response);
        return;
      }
      assert.ok(response.status < 500, `The service failed while being probed: ${response.status}.`);
    }
    assert.fail(
      `No 429 after ${settings.rateLimitProbe} writes to ${feature}. The contract leaves rate limiting to the service; set a lower limit on the test deployment, or raise --rate-limit-probe.`
    );
  });
});
