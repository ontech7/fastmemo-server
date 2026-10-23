import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, mock, test } from "node:test";

import { onRecord, silenceLogs } from "../src/log.ts";
import { ACCESS_KEY, ADMIN_KEY, openTestDb, PG_URL, startServer, type TestServer } from "./helpers.ts";
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

  test("maybeCheck tries again 15 minutes after a failed check", async () => {
    let calls = 0;
    let fail = true;
    let time = 1_000;
    const u = new Updates({
      current: "1.0.0",
      fetchReleases: async () => {
        calls++;
        if (fail) throw new Error("GitHub answered 503");
        return RELEASES;
      },
      enabled: true,
      requestDir: null,
      statusDir: null,
      sqlite: true,
      now: () => time,
    });
    u.maybeCheck();
    await settle();
    assert.equal(calls, 1);
    time += 14 * 60 * 1000;
    u.maybeCheck();
    await settle();
    assert.equal(calls, 1);
    time += 2 * 60 * 1000;
    fail = false;
    u.maybeCheck();
    await settle();
    assert.equal(calls, 2);
    // A good answer: back to every 6 hours.
    time += 60 * 60 * 1000;
    u.maybeCheck();
    await settle();
    assert.equal(calls, 2);
  });

  test("start tries again 15 minutes after a failed check, and every 6 h after a good one", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let calls = 0;
    let fail = true;
    const u = updates("1.0.0", async () => {
      calls++;
      if (fail) throw new Error("GitHub answered 503");
      return RELEASES;
    });
    u.start();
    mock.timers.tick(30_000);
    assert.equal(calls, 1);
    await settle();
    mock.timers.tick(15 * 60 * 1000 - 1);
    assert.equal(calls, 1);
    fail = false;
    mock.timers.tick(1);
    assert.equal(calls, 2);
    await settle();
    mock.timers.tick(15 * 60 * 1000);
    assert.equal(calls, 2);
    mock.timers.tick(6 * 60 * 60 * 1000);
    assert.equal(calls, 3);
    await settle();
    u.stop();
    mock.timers.tick(12 * 60 * 60 * 1000);
    assert.equal(calls, 3);
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

describe("the updater's status and install request", () => {
  const dirs: string[] = [];
  const temp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastmemo-updates-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const installable = (
    current: string,
    releases: Release[],
    extra: { requestDir?: string | null; statusDir?: string | null; sqlite?: boolean; now?: () => number } = {}
  ) => {
    const requestDir = extra.requestDir === undefined ? temp() : extra.requestDir;
    const statusDir = extra.statusDir === undefined ? temp() : extra.statusDir;
    const u = new Updates({
      current,
      fetchReleases: async () => releases,
      enabled: true,
      requestDir,
      statusDir,
      sqlite: extra.sqlite ?? true,
      now: extra.now,
    });
    return { u, requestDir, statusDir };
  };
  const writeStatus = (dir: string, status: unknown) => fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
  const NOW = 1_800_000_000_000;
  const done = { state: "done", version: "1.2.0", message: null, at: NOW, verified: true };

  describe("status()", () => {
    test("is null with no file, no directory, invalid JSON or an unknown state", () => {
      const { u, statusDir } = installable("1.0.0", []);
      assert.equal(u.status(), null);
      assert.equal(installable("1.0.0", [], { statusDir: null }).u.status(), null);
      fs.writeFileSync(path.join(statusDir!, "status.json"), "{not json");
      assert.equal(u.status(), null);
      writeStatus(statusDir!, { ...done, state: "exploded" });
      assert.equal(u.status(), null);
      writeStatus(statusDir!, { ...done, version: "1.2.0; rm" });
      assert.equal(u.status(), null);
      writeStatus(statusDir!, [done]);
      assert.equal(u.status(), null);
    });

    test("is null for a symlink, even to a valid file", () => {
      const { u, statusDir } = installable("1.0.0", []);
      const elsewhere = path.join(temp(), "real.json");
      fs.writeFileSync(elsewhere, JSON.stringify(done));
      fs.symlinkSync(elsewhere, path.join(statusDir!, "status.json"));
      assert.equal(u.status(), null);
    });

    test("is null for a file over 4096 bytes, even when every field is valid", () => {
      const { u, statusDir } = installable("1.0.0", []);
      const file = path.join(statusDir!, "status.json");
      const json = JSON.stringify(done);
      fs.writeFileSync(file, json + " ".repeat(4096 - json.length));
      assert.deepEqual(u.status(), done);
      fs.writeFileSync(file, json + " ".repeat(4097 - json.length));
      assert.equal(u.status(), null);
    });

    test("a message over 500 characters is cut, not a reason to drop the status", () => {
      const { u, statusDir } = installable("1.0.0", []);
      writeStatus(statusDir!, { ...done, state: "failed", message: "x".repeat(1500) });
      assert.deepEqual(u.status(), { ...done, state: "failed", message: "x".repeat(500) });
    });

    test("a running state dated far in the future is stale too, a few minutes of skew is not", () => {
      const { u, statusDir } = installable("1.0.0", [], { now: () => NOW });
      writeStatus(statusDir!, { ...done, state: "downloading", verified: null, at: NOW + 4 * 60 * 1000 });
      assert.equal(u.status()?.state, "downloading");
      writeStatus(statusDir!, { ...done, state: "downloading", verified: null, at: NOW + 6 * 60 * 1000 });
      assert.equal(u.status()?.state, "failed");
      assert.equal(u.status()?.message, "the updater stopped without finishing: check its log");
      writeStatus(statusDir!, { ...done, at: NOW + 6 * 60 * 1000 });
      assert.equal(u.status()?.state, "done");
    });

    test("returns a valid status as written", () => {
      const { u, statusDir } = installable("1.0.0", []);
      writeStatus(statusDir!, done);
      assert.deepEqual(u.status(), done);
      writeStatus(statusDir!, { state: "refused", version: "2.0.0", message: "other major", at: NOW });
      assert.deepEqual(u.status(), { state: "refused", version: "2.0.0", message: "other major", at: NOW, verified: null });
    });

    test("a non-final state older than an hour is a failure, a final one stays as it was", () => {
      const { u, statusDir } = installable("1.0.0", [], { now: () => NOW + 2 * 60 * 60 * 1000 });
      writeStatus(statusDir!, { ...done, state: "restarting", verified: null });
      assert.deepEqual(u.status(), {
        ...done,
        state: "failed",
        verified: null,
        message: "the updater stopped without finishing: check its log",
      });
      writeStatus(statusDir!, done);
      assert.equal(u.status()?.state, "done");
    });
  });

  describe("installable", () => {
    test("needs both directories to exist, and SQLite", () => {
      assert.equal(installable("1.0.0", [], { requestDir: null, statusDir: null }).u.info().installable, false);
      const missing = path.join(temp(), "nope");
      assert.equal(installable("1.0.0", [], { requestDir: missing, statusDir: missing }).u.info().installable, false);
      assert.equal(installable("1.0.0", [], { sqlite: false }).u.info().installable, false);
      assert.equal(installable("1.0.0", []).u.info().installable, true);
    });

    test("sameMajor compares the latest release with the running version", async () => {
      const same = installable("1.0.0", RELEASES).u;
      assert.equal(same.info().sameMajor, false);
      await same.check();
      assert.equal(same.info().sameMajor, true);
      const other = installable("1.0.0", [release("2.0.0")]).u;
      await other.check();
      assert.equal(other.info().sameMajor, false);
    });
  });

  describe("requestInstall()", () => {
    const refused = (u: Updates, version: string, status: number, code: string) =>
      assert.throws(
        () => u.requestInstall(version),
        (e: any) => e.status === status && e.code === code,
        `${version} -> ${status} ${code}`
      );

    test("leaves request.json with the version and the time, and nothing else", async () => {
      const { u, requestDir } = installable("1.0.0", RELEASES);
      await u.check();
      u.requestInstall("1.2.0");
      assert.deepEqual(fs.readdirSync(requestDir!), ["request.json"]);
      const request = JSON.parse(fs.readFileSync(path.join(requestDir!, "request.json"), "utf8"));
      assert.deepEqual(Object.keys(request).sort(), ["requestedAt", "version"]);
      assert.equal(request.version, "1.2.0");
      assert.equal(typeof request.requestedAt, "number");
    });

    test("only the latest pending release can be asked for", async () => {
      const { u, requestDir } = installable("1.0.0", RELEASES);
      await u.check();
      refused(u, "1.1.0", 409, "not_available");
      refused(u, "1.2.0; rm", 409, "not_available");
      refused(u, "9.9.9", 409, "not_available");
      refused(u, "../../x", 409, "not_available");
      assert.deepEqual(fs.readdirSync(requestDir!), []);
    });

    test("a request the updater hasn't picked up yet blocks a second one", async () => {
      const { u, requestDir } = installable("1.0.0", RELEASES);
      await u.check();
      u.requestInstall("1.2.0");
      const first = fs.readFileSync(path.join(requestDir!, "request.json"), "utf8");
      refused(u, "1.2.0", 409, "in_progress");
      assert.equal(fs.readFileSync(path.join(requestDir!, "request.json"), "utf8"), first);
      assert.deepEqual(fs.readdirSync(requestDir!), ["request.json"]);
      fs.rmSync(path.join(requestDir!, "request.json"));
      u.requestInstall("1.2.0");
    });

    test("a request left for over an hour, or one it can't read, no longer blocks: it is replaced", async () => {
      let time = NOW;
      const { u, requestDir } = installable("1.0.0", RELEASES, { now: () => time });
      await u.check();
      const file = path.join(requestDir!, "request.json");
      u.requestInstall("1.2.0");
      time += 60 * 60 * 1000;
      refused(u, "1.2.0", 409, "in_progress");
      time += 1;
      u.requestInstall("1.2.0");
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).requestedAt, time);

      for (const left of ["{nope", "[]", JSON.stringify({ version: "1.2.0" }), JSON.stringify({ requestedAt: "x" })]) {
        fs.writeFileSync(file, left);
        u.requestInstall("1.2.0");
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).requestedAt, time, left);
      }
      // From further ahead than a clock may drift: it would block for good otherwise.
      fs.writeFileSync(file, JSON.stringify({ version: "1.2.0", requestedAt: time + 10 * 60 * 1000 }));
      u.requestInstall("1.2.0");
      fs.writeFileSync(file, JSON.stringify({ version: "1.2.0", requestedAt: time + 60 * 1000 }));
      refused(u, "1.2.0", 409, "in_progress");
      assert.deepEqual(fs.readdirSync(requestDir!), ["request.json"]);
    });

    test("another major is never installed with a click", async () => {
      const { u } = installable("1.0.0", [release("2.0.0")]);
      await u.check();
      refused(u, "2.0.0", 409, "new_major");
    });

    test("waits for the updater to finish what it is doing", async () => {
      const { u, statusDir, requestDir } = installable("1.0.0", RELEASES, { now: () => NOW });
      await u.check();
      writeStatus(statusDir!, { ...done, state: "downloading", verified: null });
      refused(u, "1.2.0", 409, "in_progress");
      assert.deepEqual(fs.readdirSync(requestDir!), []);
      for (const state of ["done", "failed", "rolled_back", "refused"]) {
        writeStatus(statusDir!, { ...done, state });
        u.requestInstall("1.2.0");
        fs.rmSync(path.join(requestDir!, "request.json"));
      }
    });

    test("answers 501 when this setup can't be updated from the dashboard", async () => {
      for (const extra of [{ requestDir: null, statusDir: null }, { sqlite: false }]) {
        const { u } = installable("1.0.0", RELEASES, extra);
        await u.check();
        refused(u, "1.2.0", 501, "not_installable");
      }
    });
  });

  describe("the admin routes", () => {
    const start = async (extra: Parameters<typeof installable>[2] = {}) => {
      let calls = 0;
      const { requestDir, statusDir } = installable("1.0.0", RELEASES, extra);
      const counted = new Updates({
        current: "1.0.0",
        fetchReleases: async () => (calls++, RELEASES),
        enabled: true,
        requestDir,
        statusDir,
        sqlite: true,
      });
      const server = await startServer({}, undefined, { updates: counted });
      return { server, requestDir, statusDir, calls: () => calls, updates: counted };
    };

    test("all three need the admin key", async () => {
      const { server } = await start();
      try {
        for (const [method, url] of [
          ["GET", "/admin/api/updates"],
          ["POST", "/admin/api/updates/check"],
          ["POST", "/admin/api/updates/install"],
        ] as const) {
          assert.equal((await server.call(method, url)).status, 401, `${method} ${url} with nothing`);
          assert.equal(
            (await server.call(method, url, { key: ACCESS_KEY, headers: { Authorization: `Bearer ${ACCESS_KEY}` } })).status,
            401,
            `${method} ${url} with the access key`
          );
        }
      } finally {
        await server.close();
      }
    });

    test("GET checks in the background and answers the info", async () => {
      const { server, calls } = await start();
      try {
        const res = await server.call("GET", "/admin/api/updates", { admin: ADMIN_KEY });
        assert.equal(res.status, 200);
        assert.equal(res.body.enabled, true);
        assert.equal(res.body.current, "1.0.0");
        assert.equal(res.body.installable, true);
        assert.equal(res.body.status, null);
        await settle();
        assert.equal(calls(), 1);
      } finally {
        await server.close();
      }
    });

    test("two checks in a row ask GitHub once", async () => {
      const { server, calls } = await start();
      try {
        const first = await server.call("POST", "/admin/api/updates/check", { admin: ADMIN_KEY });
        assert.equal(first.status, 200);
        assert.equal(first.body.latest, "1.2.0");
        const second = await server.call("POST", "/admin/api/updates/check", { admin: ADMIN_KEY });
        assert.equal(second.status, 200);
        assert.equal(calls(), 1);
      } finally {
        await server.close();
      }
    });

    test("a check a minute old is allowed again", async () => {
      let time = NOW;
      let calls = 0;
      const u = new Updates({
        current: "1.0.0",
        fetchReleases: async () => (calls++, RELEASES),
        enabled: true,
        requestDir: null,
        statusDir: null,
        sqlite: true,
        now: () => time,
      });
      const server = await startServer({}, undefined, { updates: u });
      try {
        await server.call("POST", "/admin/api/updates/check", { admin: ADMIN_KEY });
        time += 59_000;
        await server.call("POST", "/admin/api/updates/check", { admin: ADMIN_KEY });
        assert.equal(calls, 1);
        time += 1_000;
        await server.call("POST", "/admin/api/updates/check", { admin: ADMIN_KEY });
        assert.equal(calls, 2);
      } finally {
        await server.close();
      }
    });

    test("install: 202 with the info, and the request left for the updater", async () => {
      const { server, requestDir, updates: u } = await start();
      try {
        await u.check();
        const res = await server.call("POST", "/admin/api/updates/install", { admin: ADMIN_KEY, body: { version: "1.2.0" } });
        assert.equal(res.status, 202);
        assert.equal(res.body.installable, true);
        assert.ok("status" in res.body);
        assert.deepEqual(fs.readdirSync(requestDir!), ["request.json"]);
      } finally {
        await server.close();
      }
    });

    test("install: a body that isn't { version: string } is a 4xx, never a 500", async () => {
      const { server, requestDir, updates: u } = await start();
      try {
        await u.check();
        const post = (body: unknown) => server.call("POST", "/admin/api/updates/install", { admin: ADMIN_KEY, body });
        for (const body of [{ version: 5 }, { version: null }, {}, [], '"text"', 5, null, { version: ["1.2.0"] }]) {
          const res = await post(body);
          assert.equal(res.status, 409, JSON.stringify(body));
          assert.equal(res.body.error, "not_available", JSON.stringify(body));
        }
        assert.equal((await post(undefined)).status, 409);
        assert.equal((await post("{not json")).status, 400);
        assert.deepEqual(fs.readdirSync(requestDir!), []);
      } finally {
        await server.close();
      }
    });

    test("install: 501 when it can't be installed, 409 while the updater works", async () => {
      const off = await start({ requestDir: null, statusDir: null });
      try {
        await off.updates.check();
        const res = await off.server.call("POST", "/admin/api/updates/install", {
          admin: ADMIN_KEY,
          body: { version: "1.2.0" },
        });
        assert.equal(res.status, 501);
        assert.equal(res.body.error, "not_installable");
      } finally {
        await off.server.close();
      }
      const busy = await start();
      try {
        await busy.updates.check();
        writeStatus(busy.statusDir!, { ...done, state: "downloading", at: Date.now(), verified: null });
        const res = await busy.server.call("POST", "/admin/api/updates/install", {
          admin: ADMIN_KEY,
          body: { version: "1.2.0" },
        });
        assert.equal(res.status, 409);
        assert.equal(res.body.error, "in_progress");
      } finally {
        await busy.server.close();
      }
    });

    test("without an Updates object the routes say it is off", async () => {
      const server = await startServer();
      try {
        const info = await server.call("GET", "/admin/api/updates", { admin: ADMIN_KEY });
        assert.equal(info.status, 200);
        assert.equal(info.body.enabled, false);
        assert.equal(info.body.installable, false);
        assert.equal(info.body.status, null);
        assert.equal((await server.call("POST", "/admin/api/updates/check", { admin: ADMIN_KEY })).body.enabled, false);
        const install = await server.call("POST", "/admin/api/updates/install", {
          admin: ADMIN_KEY,
          body: { version: "1.2.0" },
        });
        assert.equal(install.status, 501);
      } finally {
        await server.close();
      }
    });
  });
});

describe("a rolled-back update", () => {
  // The updater put back the database copy from before the switch: what devices sent to the new version meanwhile is gone.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastmemo-rollback-"));
  const file = path.join(dir, "test.db");
  const statusDir = path.join(dir, "status");
  fs.mkdirSync(statusDir);
  const writeStatus = (state: string, at: number) =>
    fs.writeFileSync(path.join(statusDir, "status.json"), JSON.stringify({ state, version: "1.2.0", message: null, at }));
  const updater = () =>
    new Updates({
      current: "1.1.0",
      fetchReleases: async () => [],
      enabled: false,
      requestDir: null,
      statusDir,
      sqlite: true,
    });
  const warnings: string[] = [];
  onRecord((record) => warnings.push(record.message));
  const asked = () =>
    warnings.filter(
      (message) => message === "the database may be a copy from before an update: asked every device for a full sync"
    );

  let server: TestServer;
  const tokens: Record<string, string> = {};
  /** Whether A and B are asked for a full sync; then each says it ran it (the flag clears). */
  const due = async () => {
    const devices: { uuid: string; fullSyncDue: number | null }[] = (
      await server.call("GET", "/v1/devices", { token: tokens.A })
    ).body.devices;
    const asked = [];
    for (const uuid of ["A", "B"]) {
      const device = devices.find((each) => each.uuid === uuid)!;
      asked.push(device.fullSyncDue !== null);
      if (device.fullSyncDue !== null) {
        await server.call("POST", `/v1/devices/${uuid}/full-sync-done`, {
          token: tokens[uuid],
          body: { due: device.fullSyncDue },
        });
      }
    }
    return asked;
  };

  after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("asks every device for a full sync once per rollback, and only after a rollback", async () => {
    // A fresh database first (on Postgres, emptied), the same one for the restart below.
    server = await startServer({}, PG_URL ? await openTestDb() : await openTestDb(file), { updates: updater() });
    tokens.A = await server.register("A");
    tokens.B = await server.register("B");

    await server.app.checkRollback();
    assert.deepEqual(await due(), [false, false], "no status: nothing to do");
    for (const state of ["restarting", "done", "refused"]) {
      writeStatus(state, Date.now());
      await server.app.checkRollback();
      assert.deepEqual(await due(), [false, false], state);
    }

    const at = Date.now();
    writeStatus("rolled_back", at);
    await server.app.checkRollback();
    assert.deepEqual(await due(), [true, true]);
    assert.equal(asked().length, 1);
    await server.app.checkRollback();
    await server.app.checkRollback();
    assert.deepEqual(await due(), [false, false], "the same rollback is handled once");
    assert.equal(asked().length, 1);

    writeStatus("rolled_back", at + 1000);
    await server.app.checkRollback();
    assert.deepEqual(await due(), [true, true], "a later rollback asks again");
    assert.equal(asked().length, 2);
    writeStatus("rolled_back", at);
    await server.app.checkRollback();
    assert.deepEqual(await due(), [false, false], "an older one doesn't");

    // A run that "could not be undone completely" may have put the copy back all the same.
    writeStatus("failed", at + 2000);
    await server.app.checkRollback();
    assert.deepEqual(await due(), [true, true], "a later failure asks too");
    assert.equal(asked().length, 3);
    await server.app.checkRollback();
    assert.deepEqual(await due(), [false, false], "the same failure is handled once");
    writeStatus("rolled_back", at + 2000);
  });

  test("a restart doesn't ask again for a rollback already handled", async () => {
    await server.close();
    server = await startServer({}, await openTestDb(file), { updates: updater() });
    await server.app.checkRollback();
    assert.deepEqual(await due(), [false, false]);
    assert.equal(asked().length, 3);
  });

  test("says nothing when there was no device to ask", async () => {
    await server.close();
    server = await startServer({}, await openTestDb(), { updates: updater() });
    writeStatus("rolled_back", Date.now() + 10_000);
    await server.app.checkRollback();
    assert.equal(asked().length, 3);
  });
});
