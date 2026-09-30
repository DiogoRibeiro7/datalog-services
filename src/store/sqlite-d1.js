/**
 * The part of Cloudflare D1's API the service uses, over Node's built-in
 * SQLite. The Node server and the tests run the same SQL, with the same
 * `?1` parameters and `RETURNING` clauses, as a Worker runs against D1, so a
 * query that works here works there.
 *
 *   const db = openDatabase(":memory:");
 *   await db.prepare("SELECT ?1 AS n").bind(1).first();   // { n: 1 }
 */

import { DatabaseSync } from "node:sqlite";

function value(input) {
  if (input === undefined) {
    return null;
  }
  if (typeof input === "boolean") {
    return input ? 1 : 0;
  }
  return input;
}

const rewritten = new Map();

/**
 * D1 binds `?1`, `?2` by number; node:sqlite binds only plain `?` by
 * position. So `?N` becomes `?`, and the order of the numbers says which
 * argument each takes: `WHERE a = ?2 OR b = ?1 OR c = ?2` binds (2, 1, 2).
 * Quoted text is left alone.
 */
export function positional(sql) {
  if (!rewritten.has(sql)) {
    const order = [];
    let text = "";
    let quote = null;
    for (let index = 0; index < sql.length; index += 1) {
      const char = sql[index];
      if (quote) {
        text += char;
        if (char === quote) {
          quote = null;
        }
      } else if (char === "'" || char === '"') {
        quote = char;
        text += char;
      } else if (char === "?" && /\d/.test(sql[index + 1] || "")) {
        let digits = "";
        while (/\d/.test(sql[index + 1] || "")) {
          digits += sql[index + 1];
          index += 1;
        }
        order.push(Number(digits) - 1);
        text += "?";
      } else {
        text += char;
      }
    }
    rewritten.set(sql, { text, order });
  }
  return rewritten.get(sql);
}

class Statement {
  constructor(database, sql, params = []) {
    this.database = database;
    const { text, order } = positional(sql);
    this.sql = text;
    this.params = order.length > 0 ? order.map((index) => params[index] ?? null) : params;
    this.raw = { sql, params };
  }

  bind(...params) {
    return new Statement(this.database, this.raw.sql, params.map(value));
  }

  compiled() {
    return this.database.prepare(this.sql);
  }

  async first(column) {
    const row = this.compiled().get(...this.params);
    if (row === undefined) {
      return null;
    }
    const plain = { ...row };
    return column === undefined ? plain : (plain[column] ?? null);
  }

  async all() {
    return { results: this.compiled().all(...this.params).map((row) => ({ ...row })), success: true, meta: {} };
  }

  async run() {
    const outcome = this.compiled().run(...this.params);
    return { success: true, results: [], meta: { changes: Number(outcome.changes), last_row_id: Number(outcome.lastInsertRowid) } };
  }

  /** For batch(): the same, without the promise. */
  runNow() {
    const outcome = this.compiled().run(...this.params);
    return { success: true, results: [], meta: { changes: Number(outcome.changes), last_row_id: Number(outcome.lastInsertRowid) } };
  }
}

export class SqliteD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new Statement(this.database, sql);
  }

  /** Runs the statements in one transaction, as D1's batch does. */
  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.runNow());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql) {
    this.database.exec(sql);
    return { count: 1, duration: 0 };
  }

  close() {
    this.database.close();
  }
}

/** A database file, or ":memory:", with foreign keys on as D1 has them. */
export function openDatabase(path = ":memory:") {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  return new SqliteD1(database);
}
