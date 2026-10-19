import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { log } from "../src/log.ts";
import { onRecord } from "../src/log.ts";
import { ADMIN_KEY, note, ops, PG_URL, startServer, stub, type TestServer } from "./helpers.ts";

describe("dashboard API and operations", () => {
  let s: TestServer;
  let a: string;
  let b: string;
  const admin = (method: string, url: string) => s.call(method, url, { admin: ADMIN_KEY });

  before(async () => {
    s = await startServer();
    onRecord((record) => s.app.service.recordEvent(record));
    a = await s.register("A");
    b = await s.register("B");
  });
  after(() => s.close());

  test("overview: counts, devices with how far behind each is, history, server info", async () => {
    await s.call("POST", "/v1/push", {
      token: a,
      body: ops({ add: [note("n1", 10), note("n2", 10)], categories: [{ icon: "c", order: 1 }] }),
    });
    await s.call("POST", "/v1/push", { token: a, body: ops({ delete: [stub("n2", 20)] }) });
    await s.app.service.flush();
    const res = await admin("GET", "/admin/api/overview");
    assert.equal(res.status, 200);
    const o = res.body;
    assert.equal(o.counts.notes, 1);
    assert.equal(o.counts.tombstones, 1);
    assert.equal(o.counts.categories, 1);
    assert.equal(o.counts.devices, 2);
    assert.ok(o.counts.noteBytes > 0);
    assert.equal(o.devices.find((d: any) => d.uuid === "B").behind, 3);
    assert.equal(o.devices.find((d: any) => d.uuid === "A").behind, 0);
    assert.equal(o.history.length, 30);
    const today = o.history[o.history.length - 1];
    assert.ok(today.pushes >= 2 && today.writes >= 4 && today.requests > 0);
    assert.equal(o.server.version, "test");
    assert.equal(o.server.database.driver, PG_URL ? "postgres" : "sqlite");
    assert.ok(o.server.database.bytes > 0);
  });

  test("warnings and errors are kept for the dashboard", async () => {
    log.warn("something odd", { code: 42 });
    await s.call("GET", "/v1/info", { key: "definitely-the-wrong-key" });
    await s.app.service.flush();
    const events = (await admin("GET", "/admin/api/overview")).body.events;
    assert.ok(events.some((e: any) => e.message === "something odd" && e.detail.code === 42));
    assert.ok(events.some((e: any) => e.message === "wrong key"));
    assert.ok(!JSON.stringify(events).includes("definitely-the-wrong-key"), "a key is never logged");
  });

  test("asking every device for a full sync", async () => {
    const res = await admin("POST", "/admin/api/full-sync");
    assert.equal(res.body.devices, 2);
    const devices = (await s.call("GET", "/v1/devices", { token: a })).body.devices;
    assert.ok(devices.every((d: any) => typeof d.fullSyncDue === "number"));
    assert.equal((await admin("POST", "/admin/api/devices/nope/full-sync")).status, 404);
  });

  test("removing a device from the dashboard", async () => {
    assert.equal((await admin("DELETE", "/admin/api/devices/B")).status, 204);
    assert.equal((await s.call("GET", "/v1/sync", { token: b })).status, 401);
    assert.equal((await admin("DELETE", "/admin/api/devices/B")).status, 404);
  });

  test("backup: a consistent copy of the database (SQLite)", { skip: !!PG_URL }, async () => {
    const res = await fetch(`${s.base}/admin/api/backup`, { headers: { Authorization: `Bearer ${ADMIN_KEY}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="fastmemo-.*\.db"/);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fastmemo-backup-")), "copy.db");
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const copy = new DatabaseSync(file);
    const row = copy.prepare(`SELECT COUNT(*) AS n FROM items WHERE kind = 'note' AND state = 'live'`).get() as { n: number };
    copy.close();
    assert.equal(row.n, 1);
  });

  test("maintenance drops a deleted category only once every device has it, and old enough", async () => {
    await s.call("POST", "/v1/push", { token: a, body: ops({ deleteCategories: [{ icon: "c", order: 1 }] }) });
    const c = await s.register("C");
    await s.app.service.maintenance();
    const count = () =>
      s.db.read((sql) =>
        sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM items WHERE kind = 'category' AND state = 'deleted'`)
      );
    assert.equal(Number((await count())?.n), 1, "too recent");
    await s.db.write((sql) => sql.run(`UPDATE items SET updated_at = 0 WHERE kind = 'category'`));
    // A is up to date (it wrote it); C registered after it.
    await s.app.service.maintenance();
    assert.equal(Number((await count())?.n), 0);
    await s.call("DELETE", "/v1/devices/C", { token: c });
  });
});
