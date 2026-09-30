/**
 * Reads a `.dev.vars` file, the format `wrangler dev` uses for local
 * secrets: `NAME=value` per line, `#` comments, values optionally quoted.
 */

import { readFile } from "node:fs/promises";

export function parseEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) {
      throw new Error(`Cannot read this line of the variables file: ${trimmed}`);
    }
    let value = match[2];
    if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export async function readEnvFile(path) {
  try {
    return parseEnvFile(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}
