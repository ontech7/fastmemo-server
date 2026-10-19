import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { note, ops, sleep, startServer, stub, type TestServer } from "./helpers.ts";

/** The change feed: what each device gets, page by page, and how its cursor moves. */
describe("feed", () => {
  let s: TestServer;
  let a: string;
  let b: string;
  const push = (token: string, body: object) => s.call("POST", "/v1/push", { token, body });
  const sync = (token: string, query = "") => s.call("GET", `/v1/sync${query}`, { token });
  const ack = (token: string, value: string) => s.call("POST", "/v1/ack", { token, body: { token: value } });
  /** Reads and acknowledges everything pending. */
  const drain = async (token: string) => {
    for (;;) {
      const res = await sync(token);
      if (!res.body.change) return;
      await ack(token, res.body.change.token);
    }
  };

  before(async () => {
    s = await startServer({ maxNoteBytes: 4 * 1024 * 1024, maxBodyBytes: 32 * 1024 * 1024 });
    a = await s.register("A");
    b = await s.register("B");
  });
  after(() => s.close());

  test("another device's changes come in, grouped by queue; a device never gets its own", async () => {
    await push(a, ops({ add: [note("f1", 10)], categories: [{ icon: "cat", order: 1 }] }));
    await push(a, ops({ add: [note("f2", 10)] }));
    await push(a, ops({ delete: [stub("f2", 20)], detach: [stub("f3", 20)] }));

    const mine = await sync(a);
    assert.equal(mine.body.change, null);

    const res = await sync(b);
    const change = res.body.change;
    assert.deepEqual(Object.keys(change.notes.add), ["f1"]);
    assert.deepEqual(Object.keys(change.notes.delete), ["f2"], "f2's latest state only: deleted");
    assert.deepEqual(Object.keys(change.notes.detach), ["f3"]);
    assert.deepEqual(Object.keys(change.categories.add), ["cat"]);
    assert.equal(change.more, false);
    assert.equal(res.body.vault.status, "absent");
    assert.ok(res.body.devices.some((d: any) => d.uuid === "A"));
  });

  test("the same page again is sent as { same: true }; acknowledging it empties the feed", async () => {
    const first = await sync(b);
    const again = await sync(b, `?p=${encodeURIComponent(first.body.change.page)}`);
    assert.deepEqual(again.body.change, { same: true });
    await ack(b, first.body.change.token);
    assert.equal((await sync(b)).body.change, null);
  });

  test("a page changes when what's in it is rewritten, even with the same last change", async () => {
    await push(a, ops({ add: [note("g1", 10), note("g2", 10)] }));
    const first = (await sync(b)).body.change;
    await push(a, ops({ add: [note("g1", 20)], bases: { g1: 10 } }));
    const second = (await sync(b, `?p=${encodeURIComponent(first.page)}`)).body.change;
    assert.notEqual(second.same, true);
    assert.equal(second.notes.add.g1.rev, 20);
    await drain(b);
  });

  test("the cursor never moves back, nor past the last change", async () => {
    await push(a, ops({ add: [note("h1", 10)] }));
    const change = (await sync(b)).body.change;
    assert.equal((await ack(b, "999999999")).status, 204);
    assert.equal((await sync(b)).body.change, null);
    await ack(b, "1");
    assert.equal((await sync(b)).body.change, null, "acknowledging an older token changes nothing");
    assert.ok(Number(change.token) > 1);
    await push(a, ops({ add: [note("h2", 10)] }));
    assert.deepEqual(Object.keys((await sync(b)).body.change.notes.add), ["h2"], "later changes still come");
    await drain(b);
    assert.equal((await ack(b, "not-a-number")).status, 400);
  });

  test("a device registered now starts at the current change (its full sync brings the rest)", async () => {
    const c = await s.register("C");
    assert.equal((await sync(c)).body.change, null);
    await push(a, ops({ add: [note("i1", 10)] }));
    assert.deepEqual(Object.keys((await sync(c)).body.change.notes.add), ["i1"]);
    await s.call("DELETE", "/v1/devices/C", { token: c });
  });

  test("pushing with nothing to pull moves the pusher's cursor past its own changes", async () => {
    await drain(a);
    await push(a, ops({ add: [note("j1", 10)] }));
    const overview = (await s.call("GET", "/admin/api/overview", { admin: "test-admin-key-0123456789" })).body;
    const me = overview.devices.find((d: any) => d.uuid === "A");
    assert.equal(me.cursor, overview.seq);
    await drain(b);
  });

  test("a device far behind reads several pages (by count)", async () => {
    const notes = Array.from({ length: 1200 }, (_, i) => note(`bulk-${i}`, 10));
    for (let i = 0; i < notes.length; i += 300) await push(a, ops({ add: notes.slice(i, i + 300) }));
    const seen = new Set<string>();
    let pages = 0;
    for (;;) {
      const change = (await sync(b)).body.change;
      if (!change) break;
      pages++;
      Object.keys(change.notes.add).forEach((id) => seen.add(id));
      if (pages < 3) assert.equal(change.more, true);
      await ack(b, change.token);
    }
    assert.equal(pages, 3);
    assert.equal(seen.size, 1200);
  });

  test("...and by size: a page stops near 2 MB (a single larger change still comes alone)", async () => {
    const big = (id: string) => note(id, 10, { text: "y".repeat(900 * 1024) });
    await push(a, ops({ add: [big("big-1"), big("big-2"), big("big-3"), note("after-big", 10)] }));
    const sizes: number[] = [];
    for (;;) {
      const change = (await sync(b)).body.change;
      if (!change) break;
      sizes.push(Object.keys(change.notes.add).length);
      await ack(b, change.token);
    }
    assert.deepEqual(sizes, [2, 2]);
    const huge = note("huge", 10, { text: "z".repeat(3 * 1024 * 1024) });
    await push(a, ops({ add: [huge] }));
    const change = (await sync(b)).body.change;
    assert.deepEqual(Object.keys(change.notes.add), ["huge"]);
    await ack(b, change.token);
  });

  test("long poll: waits for a change, wakes on one", async () => {
    await drain(b);
    const { v } = (await sync(b)).body;
    const started = Date.now();
    const waiting = sync(b, `?v=${encodeURIComponent(v)}&wait=10`);
    await sleep(150);
    assert.equal(s.app.hub.waiting, 1);
    await push(a, ops({ add: [note("live-1", 10)] }));
    const res = await waiting;
    assert.ok(Date.now() - started < 3000);
    assert.notEqual(res.body.v, v);
    assert.deepEqual(Object.keys(res.body.change.notes.add), ["live-1"]);
    await ack(b, res.body.change.token);
  });

  test("long poll: answers when the wait is over, unchanged", async () => {
    const { v } = (await sync(b)).body;
    const res = await sync(b, `?v=${encodeURIComponent(v)}&wait=1`);
    assert.equal(res.body.v, v);
  });

  test("long poll: a version from before a restart (or any other) answers at once", async () => {
    const started = Date.now();
    await sync(b, `?v=stale.1&wait=10`);
    assert.ok(Date.now() - started < 1000);
  });

  test("long poll: a client that goes away stops waiting", async () => {
    const { v } = (await sync(b)).body;
    const controller = new AbortController();
    const pending = fetch(`${s.base}/v1/sync?v=${encodeURIComponent(v)}&wait=20`, {
      headers: { Authorization: `Bearer ${b}` },
      signal: controller.signal,
    }).catch(() => null);
    await sleep(150);
    assert.equal(s.app.hub.waiting, 1);
    controller.abort();
    await pending;
    await sleep(150);
    assert.equal(s.app.hub.waiting, 0);
  });

  test("presence and the vault wake the long poll too", async () => {
    let { v } = (await sync(b)).body;
    const presence = sync(b, `?v=${encodeURIComponent(v)}&wait=10`);
    await sleep(100);
    await s.call("PUT", "/v1/devices/A/presence", { token: a, body: { noteId: "n", at: 1 } });
    const res = await presence;
    assert.deepEqual(res.body.devices.find((d: any) => d.uuid === "A").presence, { noteId: "n", at: 1 });

    v = res.body.v;
    const vault = sync(b, `?v=${encodeURIComponent(v)}&wait=10`);
    await sleep(100);
    await s.call("POST", "/v1/vault", { token: a, body: { version: 2, kdf: "x" } });
    assert.equal((await vault).body.vault.status, "present");
  });

  test("a removed device's long poll is refused", async () => {
    const d = await s.register("D");
    await s.call("DELETE", "/v1/devices/D", { token: a });
    const res = await sync(d);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "device_unknown");
  });
});
