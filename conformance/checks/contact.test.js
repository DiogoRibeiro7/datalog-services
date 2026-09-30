/** The contact form: received privately, the fields a 422 names, a retry stored once. */

import assert from "node:assert/strict";
import { before, describe } from "node:test";
import { check, describe as show, expectError, expectRequestId, expectSchema, expectStatus, offers, pageUrl, request, reset, should, unique, v } from "../lib/suite.js";

const skip = !offers("contact") && "the service does not offer the contact form";

function send(extra = {}, key = unique("message")) {
  return request("POST", v("/contact"), {
    key,
    body: {
      category: "other",
      name: "Conformance Sender",
      email: "sender@conformance.invalid",
      subject: "A conformance message",
      message: "The conformance suite sends this message to check the contact form.",
      source_url: pageUrl("/contact/"),
      ...extra
    }
  });
}

describe("the contact form", { skip }, () => {
  before(reset);

  check("a message is received (202 or 200) and nothing private is echoed", async () => {
    const response = await send({ affiliation: "Conformance University" });
    expectStatus(response, 202, 200);
    expectSchema(response, "sendContactMessage");
    expectRequestId(response);
    assert.doesNotMatch(response.text, /sender@conformance\.invalid/, "The sender's email must not be echoed.");
  });

  check("a 422 names the fields at fault", async () => {
    const response = await send({ name: "", email: "not-an-email", message: "Too short." });
    expectError(response, 422, { fields: ["name", "email", "message"] });
    expectSchema(response, "sendContactMessage");
  });

  check("a retried message with the same Idempotency-Key is answered the same", async () => {
    const key = unique("same-key");
    const first = await send({}, key);
    const second = await send({}, key);
    assert.equal(second.status, first.status, show(second));
    assert.deepEqual(second.json, first.json, "The retry must get the first answer's body; a message is stored once.");
  });

  should("a category the site does not list is a 422 naming category", async () => {
    expectError(await send({ category: "conformance-no-such-category" }), 422, { fields: ["category"] });
  });
});
