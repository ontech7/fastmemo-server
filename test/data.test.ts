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
    assert.deepEqual(all.map((n: any) => n.id).sort(), ["n1", "n2"]);
    assert.equal((await s.call("GET", "/v1/notes/n1", { token: b })).body.id, "n1");
    assert.equal((await s.call("GET", "/v1/notes/n3", { token: b })).status, 404);
    assert.equal((await s.call("GET", "/v1/notes/nope", { token: b })).status, 404);
  });

  test("tombstones: listed, pruned by id (a live note is never pruned)", async () => {
    await s.call("POST", "/v1/push", { token: a, body: ops({ detach: [stub("t2", 30)] }) });
    assert.deepEqual((await s.call("GET", "/v1/tombstones", { token: b })).body, {
      n3: { rev: 20 },
      t2: { rev: 30, detach: true },
    });
    const pruned = await s.call("POST", "/v1/tombstones/prune", { token: b, body: { ids: ["n3", "n1"] } });
    assert.equal(pruned.body.removed, 1);
    assert.deepEqual((await s.call("GET", "/v1/tombstones", { token: b })).body, { t2: { rev: 30, detach: true } });
    assert.equal((await s.call("GET", "/v1/notes/n1", { token: b })).status, 200);
    assert.equal((await s.call("POST", "/v1/tombstones/prune", { token: b, body: { ids: "n3" } })).status, 400);
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
    assert.deepEqual((await s.call("GET", "/v1/notes", { token: a })).body, []);
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
