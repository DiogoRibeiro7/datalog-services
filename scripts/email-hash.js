#!/usr/bin/env node
/**
 * The keyed hash a comment stores instead of its author's email, for finding
 * a person's comments when they ask for their data to be deleted:
 *
 *   SECRET_KEY=… node scripts/email-hash.js reader@example.org
 *
 * SECRET_KEY must be the deployment's own; with another key the hash matches
 * nothing. The address is lowercased first, as the service does.
 */

import { keyedHash } from "../src/security.js";

const [email] = process.argv.slice(2);
if (!email || !process.env.SECRET_KEY) {
  console.error("Usage: SECRET_KEY=<the deployment's secret> node scripts/email-hash.js <email>");
  process.exit(2);
}
console.log(await keyedHash(process.env.SECRET_KEY, "email", email.trim().toLowerCase()));
