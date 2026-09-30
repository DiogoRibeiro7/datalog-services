/**
 * The conformance suite, run as a site owner would run it, against the
 * reference service (it must pass) and against a deliberately broken one (it
 * must fail, naming each fault).
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createBrokenServer } from "./fixtures/broken-service.js";
import { HOOKS_TOKEN, ORIGIN, createReferenceServer } from "./fixtures/reference-server.js";

const CLI = fileURLToPath(new URL("../conformance/cli.js", import.meta.url));
const run = promisify(execFile);

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

/** Runs the CLI; resolves its exit code, its output and its JSON report. */
async function conformance(args) {
  const report = join(await mkdtemp(join(tmpdir(), "conformance-")), "report.json");
  let code = 0;
  let stdout;
  try {
    // node --test tells the processes it starts that they are its children; the CLI runs a suite of its own.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    ({ stdout } = await run(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args, "--report", report], { env, maxBuffer: 16 * 1024 * 1024 }));
  } catch (error) {
    code = error.code;
    stdout = error.stdout;
  }
  return { code, stdout, report: JSON.parse(await readFile(report, "utf8")) };
}

describe("the conformance suite", () => {
  let reference;
  let broken;
  let referenceUrl;
  let brokenUrl;

  before(async () => {
    reference = await createReferenceServer();
    broken = createBrokenServer();
    referenceUrl = await listen(reference);
    brokenUrl = await listen(broken);
  });

  after(() => {
    reference.close();
    broken.close();
  });

  it("passes against the reference service, every check included, recommended ones too", async () => {
    const { code, stdout, report } = await conformance(["--base-url", referenceUrl, "--origin", ORIGIN, "--hooks-token", HOOKS_TOKEN, "--strict"]);
    const failed = report.outcomes.filter((outcome) => outcome.outcome === "failed");
    const skipped = report.outcomes.filter((outcome) => outcome.outcome === "skipped");

    assert.deepEqual(failed, [], stdout);
    assert.equal(code, 0, stdout);
    assert.deepEqual(skipped, [], "with the hooks, nothing needs skipping");
    assert.ok(report.outcomes.filter((outcome) => outcome.outcome === "passed").length >= 40, `only ${report.outcomes.length} checks ran`);
  });

  it("skips, and says why, what needs the hooks when run without them", async () => {
    const { code, report } = await conformance(["--base-url", referenceUrl, "--origin", ORIGIN, "--only", "core,comments,subscriptions,moderation"]);
    const skipped = report.outcomes.filter((outcome) => outcome.outcome === "skipped");

    assert.equal(code, 0);
    assert.ok(skipped.length >= 4, JSON.stringify(skipped));
    assert.ok(skipped.every((outcome) => /hooks/.test(outcome.reason)), JSON.stringify(skipped));
  });

  it("fails against a broken service, naming each fault in a readable report", async () => {
    const { code, stdout, report } = await conformance(["--base-url", brokenUrl, "--origin", ORIGIN, "--rate-limit-probe", "15"]);
    const failed = report.outcomes.filter((outcome) => outcome.outcome === "failed").map((outcome) => outcome.name);

    assert.equal(code, 1, "a failed required check exits 1");
    for (const expected of [
      "a successful answer carries X-Request-Id",
      "an unknown address under the version answers 404 in the error body, with the request id",
      "another API version is not served as if it were this one",
      "a write whose body is not JSON is refused with a 4xx in the error body, not a 5xx",
      "an answer to the site names the site's origin and exposes X-Request-Id and Retry-After",
      "with credentials, the origin is named exactly (never *) and credentials are allowed",
      "a preflight allows the methods and headers the theme's client sends",
      "another origin is not allowed",
      "a comment is published (201) or held for moderation (202), in the documented shape and without the email",
      "a retried post with the same Idempotency-Key is stored once and answered the same",
      "a retried reaction with the same Idempotency-Key is counted once and answered the same",
      "a 422 names the field at fault: a message under 20 characters",
      "a message is received (202 or 200) and nothing private is echoed",
      "writes beyond the allowance answer 429 with Retry-After (probing corrections)"
    ]) {
      assert.ok(failed.includes(expected), `expected "${expected}" among the failures: ${JSON.stringify(failed, null, 2)}`);
    }
    assert.match(stdout, /✖ a successful answer carries X-Request-Id/);
    assert.match(stdout, /No request id: neither an X-Request-Id header nor request_id in the body/);
    assert.match(stdout, /The preflight must name the site's origin/);
    assert.match(stdout, /A malformed body must be the client's error\. POST \/v1\/corrections answered 500/);
    assert.match(stdout, /No 429 after 15 writes to corrections/);
  });
});
