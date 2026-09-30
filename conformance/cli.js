#!/usr/bin/env node
/**
 * Runs the conformance suite against a service at a base URL:
 *
 *   node conformance/cli.js --base-url https://api.example.org --origin https://example.org
 *
 * --base-url       the service, as `dynamic_services.base_url` names it (required)
 * --origin         the site's origin, which the service must serve (required)
 * --site-url       the site's address, for article and page URLs (default: the origin)
 * --api-version    the version the site expects (default 1)
 * --hooks-token    the service's CONFORMANCE_TOKEN, for the checks that need a
 *                  moderator session, a mailbox or a verified Webmention
 * --moderator      a login the service lets moderate (default conformance-moderator)
 * --rate-limit-probe N   writes to send while looking for a 429 (default 60)
 * --strict         fail on recommended checks as well as required ones
 * --report FILE    also write every check's outcome as JSON
 * --only NAMES     comma-separated check files to run: core, comments, …
 *
 * It exits 0 when every required check passed, 1 when one failed, and 2 when
 * the service could not be read at all. Run it against a test deployment,
 * never one with readers: it posts comments, reports and messages, and with
 * hooks it empties the database between groups.
 */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { parseArgs } from "node:util";

export const GROUPS = ["core", "comments", "reactions", "corrections", "contact", "subscriptions", "webmentions", "moderation", "rate-limits"];

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    origin: { type: "string" },
    "site-url": { type: "string" },
    "api-version": { type: "string", default: "1" },
    "hooks-token": { type: "string" },
    moderator: { type: "string", default: "conformance-moderator" },
    "rate-limit-probe": { type: "string", default: "60" },
    strict: { type: "boolean", default: false },
    report: { type: "string" },
    only: { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});

if (values.help || !values["base-url"] || !values.origin) {
  console.log("Usage: node conformance/cli.js --base-url <service> --origin <site origin> [--hooks-token <token>] [--strict] [--report out.json]");
  process.exit(values.help ? 0 : 2);
}

const baseUrl = values["base-url"].replace(/\/+$/, "");
const origin = new URL(values.origin).origin;
const apiVersion = String(values["api-version"]).replace(/^v/i, "");

let features = {};
let reportedVersion = null;
try {
  const response = await fetch(`${baseUrl}/v${apiVersion}/capabilities`, { headers: { Origin: origin, Accept: "application/json" } });
  const data = await response.json();
  features = data && typeof data.features === "object" && data.features ? data.features : {};
  reportedVersion = data ? data.api_version : null;
} catch (error) {
  console.error(`Cannot read ${baseUrl}/v${apiVersion}/capabilities: ${error.message}`);
  console.error("The rest of the suite depends on it, so nothing else was checked.");
  process.exit(2);
}

const settings = {
  baseUrl,
  origin,
  siteUrl: (values["site-url"] || origin).replace(/\/+$/, ""),
  apiVersion,
  features,
  reportedVersion,
  hooksToken: values["hooks-token"] || "",
  moderator: values.moderator,
  strict: values.strict,
  rateLimitProbe: Number(values["rate-limit-probe"]),
  runId: randomUUID().slice(0, 8)
};

const only = values.only ? values.only.split(",").map((name) => name.trim()) : GROUPS;
const files = GROUPS.filter((name) => only.includes(name)).map((name) => fileURLToPath(new URL(`./checks/${name}.test.js`, import.meta.url)));

console.log(`Conformance of ${baseUrl} (API v${apiVersion}) for ${origin}`);
console.log(`Features offered: ${Object.entries(features).filter(([, on]) => on).map(([name]) => name).join(", ") || "none"}`);
console.log(settings.hooksToken ? "Hooks: on" : "Hooks: off (checks that need them are skipped)");
console.log("");

process.env.DATALOG_CONFORMANCE = JSON.stringify(settings);
const outcomes = [];
let failed = false;
const stream = run({ files, concurrency: 1 });
stream.on("test:fail", (event) => {
  if (!event.todo && !event.skip && event.details?.type !== "suite") {
    failed = true;
  }
  outcomes.push({ name: event.name, file: event.file, outcome: event.todo ? "todo-failed" : "failed", error: event.details?.error?.cause?.message || event.details?.error?.message });
});
stream.on("test:pass", (event) => {
  if (event.details?.type !== "suite") {
    outcomes.push({ name: event.name, file: event.file, outcome: event.skip ? "skipped" : event.todo ? "todo-passed" : "passed", reason: typeof event.skip === "string" ? event.skip : undefined });
  }
});
stream.compose(spec).pipe(process.stdout);
await new Promise((resolve) => stream.on("end", resolve));

if (values.report) {
  await writeFile(values.report, `${JSON.stringify({ baseUrl, origin, apiVersion, features, outcomes }, null, 2)}\n`);
}
process.exitCode = failed ? 1 : 0;
