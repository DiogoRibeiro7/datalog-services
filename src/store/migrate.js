/**
 * Applies migrations/*.sql in name order to a database that is not D1. On
 * Cloudflare, `wrangler d1 migrations apply` does this from the same files;
 * here the Node server and the tests do it themselves, recording what they
 * applied in the table wrangler uses.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));

export async function migrate(db, directory = MIGRATIONS) {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL)"
  );
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const applied = [];
  for (const name of files) {
    const done = await db.prepare("SELECT 1 AS done FROM d1_migrations WHERE name = ?1").bind(name).first();
    if (done) {
      continue;
    }
    await db.exec(await readFile(join(directory, name), "utf8"));
    await db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?1, ?2)").bind(name, new Date().toISOString()).run();
    applied.push(name);
  }
  return applied;
}
