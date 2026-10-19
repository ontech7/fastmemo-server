import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { ACCESS_KEY, note, ops, startServer, type TestServer } from "./helpers.ts";

describe("devices", () => {
  let s: TestServer;
  before(async () => (s = await startServer({ maxDevices: 3 })));
  after(() => s.close());

  test("registering lists the device; its fields are what the app sent (trimmed, with defaults)", async () => {
    const res = await s.call("POST", "/v1/devices", {
      key: ACCESS_KEY,
      body: { uuid: "dev-1", modelName: "  Pixel 9  ", brand: "" },
    });
    assert.equal(res.status, 201);
    assert.equal(typeof res.body.token, "string");
    assert.ok(res.body.token.length >= 40);
    const list = await s.call("GET", "/v1/devices", { token: res.body.token });
    const me = list.body.devices.find((d: any) => d.uuid === "dev-1");
    assert.equal(me.modelName, "Pixel 9");
    assert.equal(me.brand, "web");
    assert.equal(me.presence, null);
    assert.equal(me.fullSyncDue, null);
    assert.deepEqual(me.devicesToSync, []);
  });

  test("a bad registration is refused", async () => {
    assert.equal((await s.call("POST", "/v1/devices", { key: ACCESS_KEY, body: { modelName: "x" } })).status, 400);
    assert.equal((await s.call("POST", "/v1/devices", { key: ACCESS_KEY, body: "not json{" })).status, 400);
  });

  test("registering again replaces the token: the old one stops working", async () => {
    const first = await s.register("dev-2");
    const second = await s.register("dev-2");
    assert.notEqual(first, second);
    assert.equal((await s.call("GET", "/v1/sync", { token: first })).status, 401);
    assert.equal((await s.call("GET", "/v1/sync", { token: second })).status, 200);
  });

  test("the server's device limit (a device registering again doesn't count twice)", async () => {
    await s.register("dev-3");
    await s.register("dev-3");
    const res = await s.call("POST", "/v1/devices", { key: ACCESS_KEY, body: { uuid: "dev-4" } });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "device_limit");
  });

  test("removing a device revokes its token at once; another device can remove it", async () => {
    const token = await s.register("dev-3");
    const other = await s.register("dev-1");
    assert.equal((await s.call("DELETE", "/v1/devices/dev-3", { token: other })).status, 204);
    const res = await s.call("GET", "/v1/sync", { token });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "device_unknown");
    const list = await s.call("GET", "/v1/devices", { token: other });
    assert.ok(!list.body.devices.some((d: any) => d.uuid === "dev-3"));
  });

  test("presence, last sync and the full-sync flag: a device changes only itself", async () => {
    const a = await s.register("dev-1");
    await s.register("dev-2");
    assert.equal((await s.call("PUT", "/v1/devices/dev-2/presence", { token: a, body: { noteId: "x", at: 1 } })).status, 403);
    assert.equal((await s.call("PUT", "/v1/devices/dev-1/presence", { token: a, body: { noteId: 5, at: 1 } })).status, 400);
    assert.equal(
      (await s.call("PUT", "/v1/devices/dev-1/presence", { token: a, body: { noteId: "n1", at: 123 } })).status,
      204
    );
    let me = (await s.call("GET", "/v1/devices", { token: a })).body.devices.find((d: any) => d.uuid === "dev-1");
    assert.deepEqual(me.presence, { noteId: "n1", at: 123 });

    const before = me.lastSync;
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await s.call("POST", "/v1/devices/dev-1/last-sync", { token: a })).status, 204);
    me = (await s.call("GET", "/v1/devices", { token: a })).body.devices.find((d: any) => d.uuid === "dev-1");
    assert.ok(Number(me.lastSync) > Number(before));

    const admin = await s.call("POST", "/admin/api/devices/dev-1/full-sync", { admin: "test-admin-key-0123456789" });
    assert.equal(admin.status, 204);
    me = (await s.call("GET", "/v1/devices", { token: a })).body.devices.find((d: any) => d.uuid === "dev-1");
    const due = me.fullSyncDue;
    assert.equal(typeof due, "number");
    await s.call("POST", "/v1/devices/dev-1/full-sync-done", { token: a, body: { due: due - 1 } });
    me = (await s.call("GET", "/v1/devices", { token: a })).body.devices.find((d: any) => d.uuid === "dev-1");
    assert.equal(me.fullSyncDue, due, "a different request (made since) isn't cleared");
    await s.call("POST", "/v1/devices/dev-1/full-sync-done", { token: a, body: { due } });
    me = (await s.call("GET", "/v1/devices", { token: a })).body.devices.find((d: any) => d.uuid === "dev-1");
    assert.equal(me.fullSyncDue, null);
  });

  test("who's behind: devicesToSync and pending counts follow the readers' cursors", async () => {
    const a = await s.register("dev-1");
    const b = await s.register("dev-2");
    await s.call("PUT", "/v1/devices/dev-1/presence", { token: a, body: { noteId: null, at: 1 } });
    await s.call("POST", "/v1/push", {
      token: a,
      body: ops({ add: [note("p1", 10), note("p2", 10)], categories: [{ icon: "c1", order: 1 }] }),
    });
    let view = (await s.call("GET", "/v1/devices", { token: b })).body.devices.find((d: any) => d.uuid === "dev-1");
    assert.deepEqual(view.devicesToSync, ["dev-2"]);
    assert.equal(view.pendingNotes, 2);
    assert.equal(view.pendingCategories, 1);

    const sync = await s.call("GET", "/v1/sync", { token: b });
    await s.call("POST", "/v1/ack", { token: b, body: { token: sync.body.change.token } });
    view = (await s.call("GET", "/v1/devices", { token: b })).body.devices.find((d: any) => d.uuid === "dev-1");
    assert.deepEqual(view.devicesToSync, []);
    assert.equal(view.pendingNotes, 0);
  });
});
