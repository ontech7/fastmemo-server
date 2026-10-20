import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { ACCESS_KEY, note, ops, startServer, stub, type TestServer } from "./helpers.ts";

describe("vault and data", () => {
  let s: TestServer;
  let a: string;
  let b: string;
  before(async () => {
    s = await startServer();
    a = await s.register("A");
    b = await s.register("B");
  });
  after(() => s.close());

  test("vault: absent, created once (a second create is told it exists), replaced, read back", async () => {
    assert.deepEqual((await s.call("GET", "/v1/vault", { key: ACCESS_KEY })).body, { status: "absent", vault: null });
    const vault = { version: 2, kdf: { iterations: 1 }, wrapped: "abc" };
    const created = await s.call("POST", "/v1/vault", { key: ACCESS_KEY, body: vault });
    assert.equal(created.status, 201);
    assert.equal(created.body.result, "created");
    const again = await s.call("POST", "/v1/vault", { token: a, body: { other: true } });
    assert.equal(again.status, 409);
    assert.equal(again.body.result, "exists");
    assert.deepEqual((await s.call("GET", "/v1/vault", { token: a })).body, { status: "present", vault });

    const replaced = { ...vault, wrapped: "def" };
    assert.equal((await s.call("PUT", "/v1/vault", { token: b, body: replaced })).status, 204);
    assert.deepEqual((await s.call("GET", "/v1/vault", { token: a })).body.vault, replaced);
  });

  test("vault: only an object, of a sane size", async () => {
    assert.equal((await s.call("PUT", "/v1/vault", { token: a, body: [1, 2] })).status, 400);
    assert.equal((await s.call("PUT", "/v1/vault", { token: a, body: { x: "a".repeat(300 * 1024) } })).status, 413);
  });

  test("notes: all of them, one by id (404 when there's none), and a deleted one isn't listed", async () => {
    await s.call("POST", "/v1/push", { token: a, body: ops({ add: [note("n1", 10), note("n2", 10), note("n3", 10)] }) });
    await s.call("POST", "/v1/push", { token: a, body: ops({ delete: [stub("n3", 20)] }) });
    const all = (await s.call("GET", "/v1/notes", { token: b })).body;
    assert.deepEqual(all.notes.map((n: any) => n.id).sort(), ["n1", "n2"]);
    assert.equal(all.next, null);
    assert.equal((await s.call("GET", "/v1/notes/n1", { token: b })).body.id, "n1");
    assert.equal((await s.call("GET", "/v1/notes/n3", { token: b })).status, 404);
    assert.equal((await s.call("GET", "/v1/notes/nope", { token: b })).status, 404);
  });

  test("tombstones: listed; pruned by id only once every device has read them and they're old (never a live note)", async () => {
    await s.call("POST", "/v1/push", { token: a, body: ops({ detach: [stub("t2", 30)] }) });
    await s.call("POST", "/v1/push", { token: a, body: ops({ delete: [stub("t3", Date.now())] }) });
    const listed = (await s.call("GET", "/v1/tombstones", { token: b })).body;
    assert.deepEqual(Object.keys(listed).sort(), ["n3", "t2", "t3"]);
    assert.deepEqual(listed.t2, { rev: 30, detach: true });

    const prune = (ids: unknown) => s.call("POST", "/v1/tombstones/prune", { token: b, body: { ids } });
    // Here a marker is the feed entry: one a device hasn't read yet would leave it with the note, to upload it again.
    assert.equal((await prune(["n3", "n1", "t3"])).body.removed, 0, "B hasn't read the deletions yet");
    for (const token of [a, b]) {
      for (;;) {
        const change = (await s.call("GET", "/v1/sync", { token })).body.change;
        if (!change) break;
        await s.call("POST", "/v1/ack", { token, body: { token: change.token } });
      }
    }
    assert.equal((await prune(["n3", "n1", "t3"])).body.removed, 1, "read by everyone and old: n3 goes; t3 is recent");
    assert.deepEqual(Object.keys((await s.call("GET", "/v1/tombstones", { token: b })).body).sort(), ["t2", "t3"]);
    assert.equal((await s.call("GET", "/v1/notes/n1", { token: b })).status, 200);
    assert.equal((await prune("n3")).status, 400);
  });

  test("import writes notes as they are, unguarded (the app's vault migration)", async () => {
    const res = await s.call("POST", "/v1/notes/import", {
      key: ACCESS_KEY,
      body: { notes: [note("n1", 5, { text: "re-sealed" })] },
    });
    assert.equal(res.status, 204);
    assert.equal((await s.call("GET", "/v1/notes/n1", { token: a })).body.text, "re-sealed");
    const change = (await s.call("GET", "/v1/sync", { token: a })).body.change;
    assert.ok(change.notes.add.n1, "imported with the key: every device gets it, the importer included");
    assert.equal((await s.call("POST", "/v1/notes/import", { token: a, body: { notes: [{ no: "id" }] } })).status, 400);
  });

  test("wipe: every note and tombstone goes", async () => {
    assert.equal((await s.call("DELETE", "/v1/notes", { token: a })).status, 204);
    assert.deepEqual((await s.call("GET", "/v1/notes", { token: a })).body, { notes: [], next: null });
    assert.deepEqual((await s.call("GET", "/v1/tombstones", { token: a })).body, {});
  });

  test("categories reset: only the default one stays", async () => {
    await s.call("POST", "/v1/push", {
      token: a,
      body: ops({
        categories: [
          { icon: "a", order: 1 },
          { icon: "b", order: 2 },
        ],
      }),
    });
    const fallback = { order: 0, name: "All", icon: "none", index: true, selected: true };
    assert.equal((await s.call("POST", "/v1/categories/reset", { token: a, body: { category: fallback } })).status, 204);
    assert.deepEqual((await s.call("GET", "/v1/categories", { token: a })).body, [fallback]);
    assert.equal((await s.call("POST", "/v1/categories/reset", { token: a, body: { category: { name: "x" } } })).status, 400);
  });
});

/** Its own server (and database: on Postgres the tests share one, emptied by each new server). */
describe("notes in pages", () => {
  test("notes come in pages (by count and by size); a note changed between two pages comes again, newer", async () => {
    const fresh = await startServer({ maxNoteBytes: 4 * 1024 * 1024, maxBodyBytes: 32 * 1024 * 1024 });
    try {
      const t = await fresh.register("P");
      const many = Array.from({ length: 1100 }, (_, i) => note(`p-${i}`, 10));
      for (let i = 0; i < many.length; i += 300) {
        await fresh.call("POST", "/v1/push", { token: t, body: ops({ add: many.slice(i, i + 300) }) });
      }
      const big = (id: string) => note(id, 10, { text: "x".repeat(3 * 1024 * 1024) });
      await fresh.call("POST", "/v1/push", { token: t, body: ops({ add: [big("big-1"), big("big-2"), big("big-3")] }) });

      const pages: number[] = [];
      const seen = new Map<string, number>();
      let after: string | null = "0";
      let rewritten = false;
      while (after !== null) {
        const page: { notes: any[]; next: string | null } = (await fresh.call("GET", `/v1/notes?after=${after}`, { token: t }))
          .body;
        pages.push(page.notes.length);
        for (const n of page.notes) seen.set(n.id, n.rev);
        after = page.next;
        if (!rewritten) {
          // p-0 was in the first page: changed now, it comes again at the end.
          await fresh.call("POST", "/v1/push", { token: t, body: ops({ add: [note("p-0", 20)], bases: { "p-0": 10 } }) });
          rewritten = true;
        }
      }
      assert.deepEqual(pages, [500, 500, 102, 2], "500 at most, ~8 MB at most (100 small + 2 x 3 MB), the rest");
      assert.equal(seen.size, 1103);
      assert.equal(seen.get("p-0"), 20);
      assert.equal((await fresh.call("GET", "/v1/notes?after=-1", { token: t })).status, 400);

      const small = (await fresh.call("GET", "/v1/notes?after=0&bytes=1", { token: t })).body;
      assert.equal(small.notes.length, 1, "a smaller page when asked (still one note at least)");
      assert.notEqual(small.next, null, "...and the rest after it");
      const huge = (await fresh.call("GET", `/v1/notes?after=0&bytes=${64 * 1024 * 1024}`, { token: t })).body;
      assert.equal(huge.notes.length, 500, "never larger than the server's own size");
      for (const bad of ["0", "-5", "1.5", "lots"]) {
        assert.equal((await fresh.call("GET", `/v1/notes?after=0&bytes=${bad}`, { token: t })).status, 400, bad);
      }
    } finally {
      await fresh.close();
    }
  });
});
