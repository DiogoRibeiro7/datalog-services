import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEnvFile } from "../src/env-file.js";
import { createNodeServer } from "../src/node.js";
import { id, keyedHash, randomToken, safeEqual, signToken, verifyToken } from "../src/security.js";
import { openDatabase, positional } from "../src/store/sqlite-d1.js";
import { makeApp } from "./helpers.js";

const SECRET = "a-secret-for-the-tests";

describe("security helpers", () => {
  it("makes ids that sort by time and do not repeat", () => {
    const earlier = id("c", Date.parse("2026-01-01T00:00:00Z"));
    const later = id("c", Date.parse("2026-01-01T00:00:01Z"));
    assert.match(earlier, /^c_[0-9a-z]{26}$/);
    assert.ok(earlier < later);
    assert.notEqual(id("c"), id("c"));
    assert.equal(randomToken().length, 43);
  });

  it("compares strings whatever their lengths", () => {
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abd"), false);
    assert.equal(safeEqual("abc", "abcd"), false);
    assert.equal(safeEqual("", ""), true);
  });

  it("keys each hash by its label", async () => {
    const client = await keyedHash(SECRET, "client", "203.0.113.7");
    assert.equal(client, await keyedHash(SECRET, "client", "203.0.113.7"));
    assert.notEqual(client, await keyedHash(SECRET, "email", "203.0.113.7"));
    assert.notEqual(client, await keyedHash("another-secret", "client", "203.0.113.7"));
  });

  it("verifies a signed token for its purpose only, and tells an expired one", async () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    const token = await signToken(SECRET, "manage", { sub: "s_1", exp: now / 1000 + 60 });

    assert.equal((await verifyToken(SECRET, "manage", token, now)).sub, "s_1");
    assert.equal(await verifyToken(SECRET, "confirm", token, now), null, "another purpose");
    assert.equal(await verifyToken("wrong", "manage", token, now), null, "another secret");
    assert.equal(await verifyToken(SECRET, "manage", `${token}x`, now), null, "a changed signature");
    assert.equal(await verifyToken(SECRET, "manage", "not.a.token", now), null);
    assert.equal((await verifyToken(SECRET, "manage", token, now + 61_000)).expired, true);
  });
});

describe("the SQLite stand-in for D1", () => {
  it("binds D1's numbered parameters in any order", async () => {
    const db = openDatabase();
    assert.deepEqual(positional("SELECT ?2, '?1', ?1, ?2"), { text: "SELECT ?, '?1', ?, ?", order: [1, 0, 1] });
    assert.deepEqual(await db.prepare("SELECT ?2 AS b, ?1 AS a, ?2 AS again").bind("one", "two").first(), {
      b: "two",
      a: "one",
      again: "two"
    });
    assert.equal(await db.prepare("SELECT ?1 AS flag").bind(true).first("flag"), 1);
  });

  it("runs a batch in one transaction", async () => {
    const db = openDatabase();
    await db.exec("CREATE TABLE t (n INTEGER PRIMARY KEY)");
    await assert.rejects(db.batch([db.prepare("INSERT INTO t VALUES (?1)").bind(1), db.prepare("INSERT INTO t VALUES (?1)").bind(1)]));
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM t").first()).n, 0);
    const [outcome] = await db.batch([db.prepare("INSERT INTO t VALUES (?1)").bind(2)]);
    assert.equal(outcome.meta.changes, 1);
  });
});

describe("the variables file", () => {
  it("reads NAME=value lines, quoted or not, and skips comments", () => {
    assert.deepEqual(parseEnvFile('# local\nSECRET_KEY="abc def"\nFEATURES=comments,reactions\n\nEMPTY=\n'), {
      SECRET_KEY: "abc def",
      FEATURES: "comments,reactions",
      EMPTY: ""
    });
    assert.throws(() => parseEnvFile("not a line"), /Cannot read/);
  });
});

describe("the Node server", () => {
  it("serves the app over HTTP with the client's address", async () => {
    const { app } = await makeApp({ env: { FEATURES: "comments" } });
    const server = createNodeServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}/v1/capabilities`, { headers: { Origin: "https://site.example" } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).features.comments, true);
      assert.equal(response.headers.get("access-control-allow-origin"), "https://site.example");

      const refused = await fetch(`http://127.0.0.1:${port}/v1/nothing`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
      assert.equal(refused.status, 404);
      assert.match(refused.headers.get("x-request-id"), /^req_/);
    } finally {
      server.close();
    }
  });
});
