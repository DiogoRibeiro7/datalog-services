#!/usr/bin/env node
/**
 * Runs the conformance suite against the Worker build itself, in workerd
 * through `wrangler dev --local`, with a local D1 migrated from migrations/:
 * the deployment target, on this machine, with nothing deployed.
 *
 *   npm run conformance:worker               # exits with the suite's code
 *   npm run conformance:worker -- --strict   # extra arguments go to the suite
 *
 * The settings are the conformance run's, test-hook token included, in a
 * temporary file that never touches .dev.vars.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ENV, HOOKS_TOKEN, ORIGIN } from "../test/fixtures/reference-server.js";
import { ROOT, startWorker } from "./lib/worker-dev.js";

const worker = await startWorker(ENV, { port: Number(process.env.PORT || 8790), origin: ORIGIN });
let code;
try {
  console.log(`Worker running at ${worker.base} in workerd, with a local D1.\n`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const suite = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(ROOT, "conformance", "cli.js"), "--base-url", worker.base, "--origin", ORIGIN, "--hooks-token", HOOKS_TOKEN, ...process.argv.slice(2)],
    { cwd: ROOT, stdio: "inherit", env }
  );
  code = suite.status ?? 1;
} finally {
  await worker.stop();
}
process.exitCode = code;
