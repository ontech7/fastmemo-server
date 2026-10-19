import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { note, ops, startServer, stub, type TestServer } from "./helpers.ts";

/*
 * The push guard: the same rules as the app's Firestore adapter (src/libs/cloud/firebaseBackend.ts `push`), so the sync
 * engine behaves the same on both.
 */
describe("push", () => {
  let s: TestServer;
  let a: string;
  let b: string;
  const push = (token: string, body: object) => s.call("POST", "/v1/push", { token, body });
  const seq = async () => Number((await s.call("GET", "/admin/api/overview", { admin: "test-admin-key-0123456789" })).body.seq);

  before(async () => {
    s = await startServer({ maxNoteBytes: 2000 });
    a = await s.register("A");
    b = await s.register("B");
  });
  after(() => s.close());

  test("a new note is stored", async () => {
    const res = await push(a, ops({ add: [note("n1", 100)] }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.committed.notes.add, ["n1"]);
    assert.deepEqual(res.body.superseded, []);
    assert.equal(res.body.complete, true);
    const stored = await s.call("GET", "/v1/notes/n1", { token: b });
    assert.equal(stored.body.text, "sealed:n1@100");
  });

  test("an upload based on the cloud's version goes through", async () => {
    const res = await push(b, ops({ add: [note("n1", 200)], bases: { n1: 100 } }));
    assert.deepEqual(res.body.committed.notes.add, ["n1"]);
  });

  test("an upload based on an older version is refused, with the cloud's version", async () => {
    const res = await push(a, ops({ add: [note("n1", 300)], bases: { n1: 100 } }));
    assert.deepEqual(res.body.committed.notes.add, []);
    assert.equal(res.body.superseded.length, 1);
    assert.equal(res.body.superseded[0].rev, 200);
  });

  test("without a base, only an older cloud version is overwritten", async () => {
    assert.deepEqual(
      (await push(a, ops({ add: [note("n1", 150)] }))).body.superseded.map((n: any) => n.rev),
      [200]
    );
    assert.deepEqual((await push(a, ops({ add: [note("n1", 250)] }))).body.committed.notes.add, ["n1"]);
  });

  test("the same revision is refused (it may be other content: the app compares them)", async () => {
    const res = await push(b, ops({ add: [note("n1", 250, { text: "other" })], bases: { n1: 250 } }));
    assert.deepEqual(res.body.committed.notes.add, []);
    assert.equal(res.body.superseded[0].text, "sealed:n1@250");
  });

  test("a deletion applies over versions up to its revision, and leaves a tombstone", async () => {
    const refused = await push(a, ops({ delete: [stub("n1", 240)] }));
    assert.deepEqual(refused.body.committed.notes.delete, []);
    assert.equal(refused.body.superseded[0].rev, 250);

    const res = await push(a, ops({ delete: [stub("n1", 260)] }));
    assert.deepEqual(res.body.committed.notes.delete, ["n1"]);
    assert.equal((await s.call("GET", "/v1/notes/n1", { token: a })).status, 404);
    const tombstones = (await s.call("GET", "/v1/tombstones", { token: a })).body;
    assert.deepEqual(tombstones.n1, { rev: 260 });
  });

  test("the same deletion again changes nothing (no new change in the feed)", async () => {
    const before = await seq();
    const res = await push(a, ops({ delete: [stub("n1", 260)] }));
    assert.deepEqual(res.body.committed.notes.delete, ["n1"], "still committed: the device dequeues it");
    assert.equal(await seq(), before);
  });

  test("an upload after a deletion brings the note back (as on Firestore: the guard reads live notes)", async () => {
    const res = await push(b, ops({ add: [note("n1", 270)] }));
    assert.deepEqual(res.body.committed.notes.add, ["n1"]);
    assert.equal((await s.call("GET", "/v1/tombstones", { token: a })).body.n1, undefined);
  });

  test("detaching (making a note device-only) isn't guarded, and is recorded as such", async () => {
    await push(a, ops({ add: [note("d1", 10)] }));
    const res = await push(b, ops({ detach: [stub("d1", 5)] }));
    assert.deepEqual(res.body.committed.notes.detach, ["d1"]);
    assert.deepEqual((await s.call("GET", "/v1/tombstones", { token: a })).body.d1, { rev: 5, detach: true });
  });

  test("categories: added, changed, deleted; an unchanged one isn't written again", async () => {
    const category = { icon: "star", name: "Star", order: 2, index: false, selected: false };
    assert.deepEqual((await push(a, ops({ categories: [category] }))).body.committed.categories.add, ["star"]);
    const before = await seq();
    await push(a, ops({ categories: [category] }));
    assert.equal(await seq(), before);
    await push(a, ops({ categories: [{ icon: "home", name: "Home", order: 1 }] }));
    const list = (await s.call("GET", "/v1/categories", { token: a })).body;
    assert.deepEqual(
      list.map((c: any) => c.icon),
      ["home", "star"],
      "sorted by order"
    );
    const res = await push(a, ops({ deleteCategories: [category] }));
    assert.deepEqual(res.body.committed.categories.delete, ["star"]);
    assert.deepEqual(
      (await s.call("GET", "/v1/categories", { token: a })).body.map((c: any) => c.icon),
      ["home"]
    );
  });

  test("a note over the size limit is refused for good; the rest of the push goes through", async () => {
    const big = note("big", 10, { text: "x".repeat(3000) });
    const res = await push(a, ops({ add: [big, note("small", 10)] }));
    assert.deepEqual(res.body.rejected, ["addNotes:big"]);
    assert.deepEqual(res.body.committed.notes.add, ["small"]);
  });

  test("entries without an id are dropped; a malformed push is refused", async () => {
    const res = await push(a, ops({ add: [{ text: "no id" }, note("ok1", 10)] }));
    assert.deepEqual(res.body.committed.notes.add, ["ok1"]);
    assert.equal((await push(a, { notes: [] } as object)).status, 400);
    assert.equal((await push(a, { notes: { add: "x" }, categories: {} } as object)).status, 400);
  });

  test("an empty push writes nothing", async () => {
    const before = await seq();
    const res = await push(a, ops());
    assert.equal(res.status, 200);
    assert.equal(await seq(), before);
  });

  test("two devices pushing over the same version at once: one wins, the other gets it back", async () => {
    await push(a, ops({ add: [note("race", 1000)] }));
    const [ra, rb] = await Promise.all([
      push(a, ops({ add: [note("race", 2000, { text: "from A" })], bases: { race: 1000 } })),
      push(b, ops({ add: [note("race", 2001, { text: "from B" })], bases: { race: 1000 } })),
    ]);
    const winners = [ra, rb].filter((r) => r.body.committed.notes.add.includes("race"));
    const losers = [ra, rb].filter((r) => r.body.superseded.some((n: any) => n.id === "race"));
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].body.superseded[0].text, winners[0] === ra ? "from A" : "from B");
  });

  test("many parallel pushes: every change gets its own sequence number, none is lost", async () => {
    const start = await seq();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => push(i % 2 ? a : b, ops({ add: [note(`par-${i}`, 10), note(`par-${i}-b`, 10)] })))
    );
    assert.equal(await seq(), start + 40);
    const ids = (await s.call("GET", "/v1/notes", { token: a })).body.map((n: any) => n.id);
    for (let i = 0; i < 20; i++) assert.ok(ids.includes(`par-${i}`) && ids.includes(`par-${i}-b`));
  });
});
