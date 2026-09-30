#!/usr/bin/env node
/**
 * The service on Node, for local development and conformance runs:
 *
 *   npm run dev                       # http://127.0.0.1:8787, database in .data/dev.sqlite
 *   PORT=9000 DATABASE=:memory: npm run dev
 *
 * Settings come from the environment, over `.dev.vars` (the file
 * `wrangler dev` reads too; copy .dev.vars.example). The database is SQLite
 * with the migrations applied at start.
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readEnvFile } from "../src/env-file.js";
import { createNodeServer } from "../src/node.js";
import { createService } from "../src/service.js";
import { migrate } from "../src/store/migrate.js";
import { openDatabase } from "../src/store/sqlite-d1.js";

const env = { ...(await readEnvFile(resolve(process.env.DEV_VARS || ".dev.vars"))), ...process.env };
const databasePath = env.DATABASE || ".data/dev.sqlite";
if (databasePath !== ":memory:") {
  await mkdir(dirname(resolve(databasePath)), { recursive: true });
}
const db = openDatabase(databasePath);
const applied = await migrate(db);

const service = createService({ db, env });
const server = createNodeServer(service, { trustProxy: ["1", "true"].includes(String(env.TRUST_PROXY).toLowerCase()) });
const port = Number(env.PORT || 8787);
const host = env.HOST || "127.0.0.1";

server.listen(port, host, () => {
  const on = Object.entries(service.config.features).filter(([, enabled]) => enabled).map(([name]) => name);
  console.log(`datalog-services on http://${host}:${port}/v1 (database ${databasePath}${applied.length ? `, applied ${applied.join(", ")}` : ""})`);
  console.log(`features: ${on.length ? on.join(", ") : "none (set FEATURES)"}; origins: ${service.config.allowedOrigins.join(", ") || "none (set ALLOWED_ORIGINS)"}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
