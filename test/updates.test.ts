import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, mock, test } from "node:test";

import { silenceLogs } from "../src/log.ts";
import { ACCESS_KEY, startServer } from "./helpers.ts";
import {
  compareVersions,
  githubReleases,
  hasSecuritySection,
  Updates,
  type FetchReleases,
  type Release,
} from "../src/updates.ts";

silenceLogs(true);

const release = (version: string, security = false): Release => ({
  version,
  notes: security ? "### Security\n- fixed" : "### Added\n- something",
  url: `https://github.com/ontech7/fastmemo-server/releases/tag/v${version}`,
  publishedAt: "2026-10-22T20:00:00Z",
  security,
});

const updates = (current: string, fetchReleases: FetchReleases, enabled = true) =>
  new Updates({ current, fetchReleases, enabled, requestDir: null, statusDir: null, sqlite: true });

/** Lets a background check finish. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const RELEASES = [release("1.0.0"), release("1.1.0"), release("1.2.0", true)];

describe("versions", () => {
  test("compares numerically, not as text", () => {
    assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("0.9.0", "1.0.0"), -1);
  });

  test("a security update is a Security heading of the changelog, nothing looser", () => {
    assert.equal(hasSecuritySection("## [1.1.0]\n\n### Security\n- fixed"), true);
    assert.equal(hasSecuritySection("## Security\n- fixed"), true);
    assert.equal(hasSecuritySection("### Securityish"), false);
    assert.equal(hasSecuritySection("text mentioning Security"), false);
    assert.equal(hasSecuritySection("#### Security"), false);
  });
});

describe("the release check", () => {
  afterEach(() => mock.timers.reset());

  test("lists what is newer than the running version, newest first, and flags security", async () => {
    const u = updates("1.0.0", async () => RELEASES);
    await u.check();
    assert.deepEqual(
      u.pending().map((r) => r.version),
      ["1.2.0", "1.1.0"]
    );
    assert.deepEqual(u.summary(), { latest: "1.2.0", security: true, url: release("1.2.0").url });
    assert.equal(u.info().latest, "1.2.0");
    assert.equal(u.info().security, true);
    assert.equal(typeof u.info().checkedAt, "number");
  });

  test("a security fix in an older pending release still makes the update a security one", async () => {
    const u = updates("1.0.0", async () => [release("1.1.0", true), release("1.2.0")]);
    await u.check();
    assert.equal(u.summary()?.latest, "1.2.0");
    assert.equal(u.summary()?.security, true);
  });

  test("nothing to report when already on the latest", async () => {
    const u = updates("1.2.0", async () => RELEASES);
    await u.check();
    assert.deepEqual(u.pending(), []);
    assert.equal(u.summary(), null);
  });

  test("a running version that isn't a plain x.y.z is never offered an update", async () => {
    for (const current of ["test", "1.1.0-rc.1"]) {
      const u = updates(current, async () => RELEASES);
      await u.check();
      assert.deepEqual(u.pending(), [], current);
      assert.equal(u.summary(), null, current);
    }
  });

  test("when disabled it never asks GitHub", async () => {
    let calls = 0;
    const u = updates("1.0.0", async () => (calls++, RELEASES), false);
    await u.check();
    u.maybeCheck();
    u.start();
    u.stop();
    assert.equal(calls, 0);
    assert.equal(u.summary(), null);
    assert.equal(u.info().enabled, false);
  });

  test("a failed check keeps the last good answer and reports the error", async () => {
    let fail = false;
    const u = updates("1.0.0", async () => {
      if (fail) throw new Error("GitHub answered 403");
      return RELEASES;
    });
    await u.check();
    fail = true;
    await u.check();
    assert.equal(u.summary()?.latest, "1.2.0");
    assert.equal(u.info().error, "GitHub answered 403");
    fail = false;
    await u.check();
    assert.equal(u.info().error, null);
  });

  test("callers that arrive during a check share it", async () => {
    let calls = 0;
    const u = updates("1.0.0", async () => (calls++, RELEASES));
    await Promise.all([u.check(), u.check()]);
    assert.equal(calls, 1);
  });

  test("maybeCheck waits 6 hours between checks", async () => {
    let calls = 0;
    let time = 1_000;
    const u = new Updates({
      current: "1.0.0",
      fetchReleases: async () => (calls++, RELEASES),
      enabled: true,
      requestDir: null,
      statusDir: null,
      sqlite: true,
      now: () => time,
    });
    u.maybeCheck();
    await settle();
    assert.equal(calls, 1);
    time += 5 * 60 * 60 * 1000;
    u.maybeCheck();
    await settle();
    assert.equal(calls, 1);
    time += 2 * 60 * 60 * 1000;
    u.maybeCheck();
    await settle();
    assert.equal(calls, 2);
  });

  test("start checks after 30 s, then every 6 h, until stopped", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let calls = 0;
    const u = updates("1.0.0", async () => (calls++, RELEASES));
    u.start();
    mock.timers.tick(29_000);
    assert.equal(calls, 0);
    mock.timers.tick(1_000);
    assert.equal(calls, 1);
    await settle();
    mock.timers.tick(6 * 60 * 60 * 1000);
    assert.equal(calls, 2);
    await settle();
    u.stop();
    mock.timers.tick(12 * 60 * 60 * 1000);
    assert.equal(calls, 2);
  });
});

describe("githubReleases", () => {
  const item = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    body: "### Added\n- x",
    html_url: `https://github.com/ontech7/fastmemo-server/releases/tag/${tag}`,
    published_at: "2026-10-22T20:00:00Z",
    ...extra,
  });

  const serve = async (status: number, payload: string) => {
    const seen: http.IncomingMessage[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req);
      res.writeHead(status, { "content-type": "application/json" }).end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { api, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  };

  const fetchFrom = (api: string) => githubReleases("ontech7/fastmemo-server", "fastmemo-server/1.0.0", api)();

  test("keeps published final releases with a strict version, and nothing else", async () => {
    const stub = await serve(
      200,
      JSON.stringify([
        item("v1.3.0"),
        item("v1.4.0", { draft: true }),
        item("v1.5.0", { prerelease: true }),
        item("v1.2"),
        item("latest"),
        item("v1.6.0-rc.1"),
        item("v1.7.0", { body: "## Security\n- fixed" }),
        item("v1.8.0", { body: "x".repeat(20_000), html_url: "https://evil.example/releases/1.8.0" }),
        "garbage",
        null,
      ])
    );
    try {
      const releases = await fetchFrom(stub.api);
      assert.deepEqual(
        releases.map((r) => r.version),
        ["1.3.0", "1.7.0", "1.8.0"]
      );
      assert.equal(releases[0]?.security, false);
      assert.equal(releases[1]?.security, true);
      assert.equal(releases[2]?.notes.length, 8000);
      assert.equal(releases[2]?.url, "https://github.com/ontech7/fastmemo-server/releases");
      assert.equal(releases[0]?.url, "https://github.com/ontech7/fastmemo-server/releases/tag/v1.3.0");
    } finally {
      await stub.close();
    }
  });

  test("finds the Security section even past the notes cap", async () => {
    const stub = await serve(
      200,
      JSON.stringify([item("v1.3.0", { body: `${"x".repeat(10_000)}\n### Security\n- fixed\n${"y".repeat(10_000)}` })])
    );
    try {
      const [found] = await fetchFrom(stub.api);
      assert.equal(found?.security, true);
      assert.equal(found?.notes.length, 8000);
    } finally {
      await stub.close();
    }
  });

  test("sends a user agent and nothing identifying beyond it", async () => {
    const stub = await serve(200, "[]");
    try {
      await fetchFrom(stub.api);
      const request = stub.seen[0]!;
      assert.equal(request.url, "/repos/ontech7/fastmemo-server/releases?per_page=30");
      assert.equal(request.headers["user-agent"], "fastmemo-server/1.0.0");
      assert.equal(request.headers["accept"], "application/vnd.github+json");
      assert.equal(request.headers["x-github-api-version"], "2022-11-28");
      for (const name of Object.keys(request.headers)) {
        assert.ok(!/^(authorization|cookie|x-(?!github-api-version$))/.test(name), `unexpected header ${name}`);
      }
    } finally {
      await stub.close();
    }
  });

  test("rejects on a 403 and on an answer that isn't a release list", async () => {
    for (const [status, payload] of [
      [403, '{"message":"rate limit"}'],
      [200, "<html>not json</html>"],
      [200, '{"message":"not a list"}'],
    ] as const) {
      const stub = await serve(status, payload);
      try {
        await assert.rejects(fetchFrom(stub.api), Error, `${status} ${payload}`);
      } finally {
        await stub.close();
      }
    }
  });
});

describe("update in /v1/info", () => {
  const start = async (current: string, releases: Release[] | null) => {
    const u = updates(current, async () => releases ?? []);
    const server = await startServer({}, undefined, releases === null ? {} : { updates: u });
    await u.check();
    return server;
  };
  const info = async (server: Awaited<ReturnType<typeof startServer>>) => {
    const res = await server.call("GET", "/v1/info", { key: ACCESS_KEY });
    assert.equal(res.status, 200);
    return res.body;
  };
  const BASE = {
    server: "fastmemo-server",
    version: "test",
    protocol: 1,
    instance: "test-instance",
    maxDevices: 5,
    maxNoteBytes: 1024 * 1024,
  };

  test("tells a newer release, and the security flag, without touching the other fields", async () => {
    const server = await start("1.0.0", RELEASES);
    try {
      const body = await info(server);
      assert.deepEqual(body.update, { latest: "1.2.0", security: true, url: release("1.2.0").url });
      const { update, ...rest } = body;
      assert.deepEqual(rest, BASE);
    } finally {
      await server.close();
    }
  });

  test("has no update field when already up to date", async () => {
    const server = await start("1.2.0", RELEASES);
    try {
      const body = await info(server);
      assert.equal("update" in body, false);
      assert.deepEqual(body, BASE);
    } finally {
      await server.close();
    }
  });

  test("has no update field when the server has no release check", async () => {
    const server = await start("1.0.0", null);
    try {
      assert.equal("update" in (await info(server)), false);
    } finally {
      await server.close();
    }
  });
});
