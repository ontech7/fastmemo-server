import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { ACCESS_KEY, ADMIN_KEY, startServer, type TestServer } from "./helpers.ts";

describe("auth", () => {
  let s: TestServer;
  before(async () => (s = await startServer()));
  after(() => s.close());

  test("health needs nothing", async () => {
    const res = await s.call("GET", "/v1/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  test("info needs the access key, and tells what the server is", async () => {
    assert.equal((await s.call("GET", "/v1/info")).status, 401);
    assert.equal((await s.call("GET", "/v1/info", { key: "wrong-key-wrong-key" })).status, 401);
    const res = await s.call("GET", "/v1/info", { key: ACCESS_KEY });
    assert.equal(res.status, 200);
    assert.equal(res.body.server, "fastmemo-server");
    assert.equal(res.body.protocol, 1);
    assert.equal(res.body.instance, "test-instance");
    assert.equal(res.body.maxDevices, 5);
  });

  test("a device's routes need its token; an unknown token says so", async () => {
    const res = await s.call("GET", "/v1/sync", { token: "not-a-token" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "device_unknown");
    assert.equal((await s.call("GET", "/v1/sync", { key: ACCESS_KEY })).status, 401, "the key alone isn't a device");
    const token = await s.register("auth-a");
    assert.equal((await s.call("GET", "/v1/sync", { token })).status, 200);
  });

  test("member routes take the token or the key (the app reads the vault before registering)", async () => {
    assert.equal((await s.call("GET", "/v1/vault", { key: ACCESS_KEY })).status, 200);
    assert.equal((await s.call("GET", "/v1/vault", { token: await s.register("auth-b") })).status, 200);
    assert.equal((await s.call("GET", "/v1/vault")).status, 401);
    assert.equal((await s.call("GET", "/v1/vault", { key: "wrong-key-wrong-key" })).status, 401);
  });

  test("the dashboard API needs the admin key, not the access key", async () => {
    assert.equal((await s.call("GET", "/admin/api/overview", { admin: ACCESS_KEY })).status, 401);
    assert.equal((await s.call("GET", "/admin/api/overview", { admin: ADMIN_KEY })).status, 200);
  });

  test("an address that keeps getting the key wrong is refused for a while (devices with a token aren't)", async () => {
    const token = await s.register("auth-c");
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await s.call("GET", "/v1/info", { key: `wrong-key-number-${i}` })).status;
    assert.equal(last, 429);
    assert.equal((await s.call("GET", "/v1/info", { key: ACCESS_KEY })).status, 429, "even the right key, while refused");
    assert.equal((await s.call("GET", "/v1/sync", { token })).status, 200, "a registered device keeps syncing");
    s.app.limiter.sweep(Date.now() + 16 * 60 * 1000);
  });
});
