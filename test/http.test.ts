import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { after, before, describe, test } from "node:test";

import { migrate, SCHEMA_VERSION } from "../src/store/schema.ts";
import { openSqlite } from "../src/store/sqlite.ts";
import { ACCESS_KEY, note, openTestDb, ops, PG_URL, startServer, type TestServer } from "./helpers.ts";

describe("http", () => {
  let s: TestServer;
  let a: string;
  before(async () => {
    s = await startServer({ maxBodyBytes: 64 * 1024 });
    a = await s.register("A");
  });
  after(() => s.close());

  test("CORS: the app's web and desktop builds can call it (preflight, private network)", async () => {
    const res = await fetch(`${s.base}/v1/push`, {
      method: "OPTIONS",
      headers: { Origin: "https://fastmemo.example", "Access-Control-Request-Private-Network": "true" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /X-Access-Key/);
    assert.equal(res.headers.get("access-control-allow-private-network"), "true");
  });

  test("an unknown route is a 404", async () => {
    assert.equal((await s.call("GET", "/v1/nope", { token: a })).status, 404);
    assert.equal((await s.call("PATCH", "/v1/push", { token: a })).status, 404);
  });

  test("a malformed escape in the URL is a 400, not a server error", async () => {
    assert.equal((await s.call("DELETE", "/v1/devices/%E0%A4%A", { token: a })).status, 400);
  });

  test("a body over the limit is refused (413)", async () => {
    const res = await s.call("POST", "/v1/push", {
      token: a,
      body: ops({ add: [note("big", 1, { text: "x".repeat(80 * 1024) })] }),
    });
    assert.equal(res.status, 413);
    assert.equal(res.body.error, "too_large");
  });

  test("large replies are gzipped when the client accepts it", async () => {
    await s.call("POST", "/v1/push", { token: a, body: ops({ add: Array.from({ length: 100 }, (_, i) => note(`z${i}`, 1)) }) });
    const res = await fetch(`${s.base}/v1/notes`, {
      headers: { "X-Access-Key": ACCESS_KEY, "Accept-Encoding": "gzip" },
    });
    // fetch decompresses transparently: the header tells it was compressed.
    assert.equal(res.headers.get("content-encoding"), "gzip");
    assert.equal(((await res.json()) as { notes: unknown[] }).notes.length, 100);
    const raw = await new Promise<Buffer>((resolve, reject) => {
      import("node:http").then(({ get }) =>
        get(`${s.base}/v1/notes`, { headers: { "X-Access-Key": ACCESS_KEY, "Accept-Encoding": "gzip" } }, (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => resolve(Buffer.concat(chunks)));
        }).on("error", reject)
      );
    });
    assert.equal(JSON.parse(gunzipSync(raw).toString()).notes.length, 100);
  });

  test("the dashboard page is served with a strict CSP; only its own files", async () => {
    const res = await fetch(`${s.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(await res.text(), /<html/i);
    assert.equal((await fetch(`${s.base}/assets/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${s.base}/assets/nope.js`)).status, 404);
  });
});

describe("persistence and schema", { skip: !!PG_URL }, () => {
  test("data, tokens and the cursor survive a restart", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fastmemo-restart-")), "db.sqlite");
    let s = await startServer({}, openSqlite(file));
    const a = await s.register("A");
    const b = await s.register("B");
    await s.call("POST", "/v1/push", { token: a, body: ops({ add: [note("kept", 10)] }) });
    await s.close();

    s = await startServer({}, openSqlite(file));
    assert.equal((await s.call("GET", "/v1/notes/kept", { token: a })).status, 200);
    const change = (await s.call("GET", "/v1/sync", { token: b })).body.change;
    assert.deepEqual(Object.keys(change.notes.add), ["kept"]);
    await s.close();
  });

  test("a database from a newer server is refused, not downgraded", async () => {
    const db = await openTestDb();
    await migrate(db);
    await db.write((sql) => sql.run(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, [String(SCHEMA_VERSION + 1)]));
    await assert.rejects(migrate(db), /newer fastmemo-server/);
    await db.close();
  });
});

describe("an oversized upload", () => {
  test("a client still uploading an oversized body gets the 413, not a broken connection", async () => {
    const big = await startServer({ maxBodyBytes: 512 * 1024 });
    try {
      const token = await big.register("U");
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${big.base}/v1/push`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(ops({ add: [note(`big-${i}`, 1, { text: "x".repeat(1536 * 1024) })] })),
        });
        assert.equal(res.status, 413);
      }
    } finally {
      await big.close();
    }
  });
});
