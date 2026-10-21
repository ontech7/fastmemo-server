import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { addressBucket, AuthLimiter } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { isPrivateAddress } from "../src/http.ts";
import { Hub, MAX_WAITS_PER_DEVICE } from "../src/hub.ts";
import { ADMIN_KEY, note, ops, PG_URL, startServer, stub, type TestServer } from "./helpers.ts";

/*
 * What the v1.0.0 review found: a request that crashed the server, a limiter a client could dodge or grow, a backup held in
 * memory, files readable by others, unchecked stubs and imports.
 */

/** Sends `request` as raw bytes and resolves with the first line of the answer. */
const raw = (base: string, request: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const socket = net.connect(Number(port), "127.0.0.1", () => socket.write(request));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n")) {
        socket.destroy();
        resolve(data.split("\r\n")[0]);
      }
    });
    socket.on("error", reject);
  });

describe("hardening", () => {
  let s: TestServer;
  let a: string;
  before(async () => {
    s = await startServer();
    a = await s.register("A");
  });
  after(() => s.close());

  test("a request target that isn't a URL is a 400, and the server keeps running", async () => {
    for (const target of ["//", "///", "//a:b"]) {
      assert.equal(await raw(s.base, `GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`), "HTTP/1.1 400 Bad Request", target);
    }
    assert.equal((await s.call("GET", "/v1/health")).status, 200);
  });

  test("a deletion stub over its size is refused, a normal one goes through", async () => {
    const res = await s.call("POST", "/v1/push", {
      token: a,
      body: ops({ delete: [{ ...stub("big", 5), padding: "x".repeat(10_000) }, stub("small", 5)] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rejected, ["deleteNotes:big"]);
    assert.deepEqual(res.body.committed.notes.delete, ["small"]);
  });

  test("an import with a revision no upload could pass is refused", async () => {
    for (const rev of [1e300, 1.5, -1]) {
      const res = await s.call("POST", "/v1/notes/import", { token: a, body: { notes: [note("imp", rev)] } });
      assert.equal(res.status, 400, String(rev));
    }
    const ok = await s.call("POST", "/v1/notes/import", { token: a, body: { notes: [note("imp", 7)] } });
    assert.equal(ok.status, 204);
  });

  test("the backup is streamed from a file next to the database, removed afterwards", { skip: !!PG_URL }, async () => {
    const res = await fetch(`${s.base}/admin/api/backup`, { headers: { Authorization: `Bearer ${ADMIN_KEY}` } });
    assert.equal(res.status, 200);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.subarray(0, 15).toString(), "SQLite format 3");
    assert.equal(Number(res.headers.get("content-length")), body.length);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const left = fs.readdirSync(s.db.scratchDir).filter((name) => name.startsWith("fastmemo-backup-"));
    assert.deepEqual(left, []);
  });

  test("the database file is readable by its owner only", { skip: !!PG_URL }, () => {
    const file = path.join(s.db.scratchDir, "test.db");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe("hardening: units", () => {
  test("X-Forwarded-For is trusted only from a proxy's address (private, loopback)", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.0.0.5", "172.17.0.1", "192.168.1.19", "100.100.1.1"]) {
      assert.ok(isPrivateAddress(address), address);
    }
    for (const address of ["fd7a:115c:a1e0::1", "fe80::1"]) assert.ok(isPrivateAddress(address), address);
    for (const address of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "::ffff:1.2.3.4", "2001:db8::1"]) {
      assert.ok(!isPrivateAddress(address), address);
    }
  });

  test("the limiter counts an IPv6 /64 as one client", () => {
    assert.equal(addressBucket("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
    assert.equal(addressBucket("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
    assert.equal(addressBucket("2001:db8::1"), "2001:db8:0:0::/64");
    assert.equal(addressBucket("::ffff:1.2.3.4"), "1.2.3.4");
    assert.equal(addressBucket("1.2.3.4"), "1.2.3.4");
    const limiter = new AuthLimiter();
    for (let i = 0; i < 20; i++) limiter.fail(`2001:db8:1:2::${i.toString(16)}`);
    assert.ok(limiter.blocked("2001:db8:1:2::ffff"));
    assert.ok(!limiter.blocked("2001:db8:1:3::1"));
  });

  test("the limiter logs an address twice at most, and stops everyone past the overall budget", () => {
    const limiter = new AuthLimiter();
    const kinds = Array.from({ length: 21 }, () => limiter.fail("1.2.3.4"));
    assert.equal(kinds[0], "first");
    assert.equal(kinds[19], "blocked");
    assert.equal(kinds.filter((kind) => kind !== "more").length, 2);
    for (let i = 0; i < 500; i++) limiter.fail(`10.${(i >> 8) & 255}.${i & 255}.1`);
    assert.ok(limiter.blocked("8.8.8.8"), "a new address is refused once many failed together");
    assert.ok(limiter.tracked <= 10_000);
  });

  test("a device holding too many long polls has its oldest answered", async () => {
    const hub = new Hub();
    const answered: number[] = [];
    const waits = Array.from({ length: MAX_WAITS_PER_DEVICE + 1 }, (_, i) =>
      hub.wait(hub.version(), 60_000, undefined, "A").then(() => answered.push(i))
    );
    const other = hub.wait(hub.version(), 60_000, undefined, "B");
    await waits[0];
    assert.deepEqual(answered, [0]);
    assert.equal(hub.waiting, MAX_WAITS_PER_DEVICE + 1);
    hub.close();
    await Promise.all([...waits, other]);
  });

  test("without Docker the server listens on this computer only", () => {
    assert.equal(loadConfig({ FASTMEMO_ACCESS_KEY: "0123456789abcdef0123" }).host, "127.0.0.1");
    assert.equal(loadConfig({ FASTMEMO_ACCESS_KEY: "0123456789abcdef0123", HOST: "0.0.0.0" }).host, "0.0.0.0");
  });
});
