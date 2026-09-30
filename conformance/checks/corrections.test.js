/** Correction reports: received privately, the fields a 422 names, a retry stored once. */

import assert from "node:assert/strict";
import { before, describe } from "node:test";
import { check, describe as show, expectError, expectRequestId, expectSchema, expectStatus, offers, pagePath, pageUrl, request, reset, should, unique, v } from "../lib/suite.js";

const skip = !offers("corrections") && "the service does not offer corrections";

function reportBody(extra = {}) {
  return {
    category: "other",
    message: "The conformance suite reports that this paragraph needs checking.",
    contact_email: "reporter@conformance.invalid",
    article: { url: pageUrl(pagePath("article")), title: "A conformance article" },
    ...extra
  };
}

function report(extra = {}, key = unique("report")) {
  return request("POST", v("/corrections"), { key, body: reportBody(extra) });
}

describe("correction reports", { skip }, () => {
  before(reset);

  check("a report is received (202 or 200) and nothing private is echoed", async () => {
    const response = await report({ section: "a-section", quote: "the quoted words" });
    expectStatus(response, 202, 200);
    expectSchema(response, "reportCorrection");
    expectRequestId(response);
    assert.doesNotMatch(response.text, /reporter@conformance\.invalid/, "The reporter's email must not be echoed.");
  });

  check("a report with only what the theme's form requires is received", async () => {
    const response = await report({ contact_email: undefined });
    expectStatus(response, 202, 200);
  });

  check("a 422 names the field at fault: a message under 20 characters", async () => {
    const response = await report({ message: "Too short." });
    expectError(response, 422, { fields: ["message"] });
    expectSchema(response, "reportCorrection");
  });

  check("a retried report with the same Idempotency-Key is answered the same", async () => {
    const key = unique("same-key");
    const body = reportBody();
    const first = await request("POST", v("/corrections"), { key, body });
    const second = await request("POST", v("/corrections"), { key, body });
    assert.equal(second.status, first.status, show(second));
    assert.deepEqual(second.json, first.json, "The retry must get the first answer's body; a report is stored once.");
  });

  should("a category the site does not list is a 422 naming category", async () => {
    expectError(await report({ category: "conformance-no-such-category" }), 422, { fields: ["category"] });
  });
});
