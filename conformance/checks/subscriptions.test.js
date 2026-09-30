/**
 * Subscriptions: signing up, and, with the hooks' mailbox, the links of the
 * emails: confirm, read, change, unsubscribe, and every earlier link dead.
 */

import assert from "node:assert/strict";
import { before, describe } from "node:test";
import { NO_HOOKS, check, describe as show, expectError, expectSchema, expectStatus, hooks, mailTo, offers, pageUrl, request, reset, unique, v } from "../lib/suite.js";

const skip = !offers("subscriptions") && "the service does not offer subscriptions";

function address() {
  return `${unique("reader")}@conformance.invalid`.toLowerCase();
}

function subscribe(email, key = unique("subscribe")) {
  return request("POST", v("/subscriptions"), { key, body: { email, source_url: pageUrl("/"), locale: "en" } });
}

/** The token after `?name=` in the mail to an address. */
async function linkToken(email, name) {
  for (const message of (await mailTo(email)).reverse()) {
    const match = new RegExp(`[?&]${name}=([^\\s&#]+)`).exec(message.text);
    if (match) {
      return decodeURIComponent(match[1]);
    }
  }
  assert.fail(`No email to ${email} holds a ?${name}= link.`);
}

describe("subscriptions", { skip }, () => {
  before(reset);

  check("signing up answers 202 pending (double opt-in) or 201 confirmed", async () => {
    const response = await subscribe(address());
    expectStatus(response, 202, 201);
    expectSchema(response, "subscribe");
  });

  check("a 422 names email for an address that is not one", async () => {
    const response = await request("POST", v("/subscriptions"), { key: unique("bad"), body: { email: "not-an-address" } });
    expectError(response, 422, { fields: ["email"] });
  });

  check("a link that is not one answers 404 or 410", async () => {
    const response = await request("GET", v(`/subscriptions/${unique("not-a-token")}`));
    expectError(response, [404, 410]);
  });

  check("the confirmation link confirms, and the manage link reads, changes and ends the subscription", async (t) => {
    if (!hooks) {
      t.skip(NO_HOOKS);
      return;
    }
    const email = address();
    const signedUp = await subscribe(email);
    if (signedUp.status === 202) {
      const confirmed = await request("POST", v("/subscriptions/confirm"), { body: { token: await linkToken(email, "confirm") } });
      expectStatus(confirmed, 200);
      expectSchema(confirmed, "confirmSubscription");
      assert.equal(confirmed.json.status, "confirmed", show(confirmed));
    }
    const manage = encodeURIComponent(await linkToken(email, "manage"));

    const read = await request("GET", v(`/subscriptions/${manage}`));
    expectStatus(read, 200);
    expectSchema(read, "getSubscription");
    assert.equal(read.json.status, "confirmed", show(read));

    const changed = await request("PATCH", v(`/subscriptions/${manage}`), { body: { topics: read.json.topics } });
    expectStatus(changed, 200);
    expectSchema(changed, "updateSubscription");

    const ended = await request("DELETE", v(`/subscriptions/${manage}`));
    expectStatus(ended, 200, 204);
    expectError(await request("GET", v(`/subscriptions/${manage}`)), [404, 410]);
  });

  check("signing up an address twice is not an error: 202 (not disclosed) or 409 (already subscribed)", async (t) => {
    if (!hooks) {
      t.skip(NO_HOOKS);
      return;
    }
    const email = address();
    if ((await subscribe(email)).status === 202) {
      await request("POST", v("/subscriptions/confirm"), { body: { token: await linkToken(email, "confirm") } });
    }
    const again = await subscribe(email);
    expectStatus(again, 202, 409);
  });
});
