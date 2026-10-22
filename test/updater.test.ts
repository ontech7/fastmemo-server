import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

/*
 * The host updater (contrib/updater/fastmemo-updater.py), end to end: Python runs it for real, with a stub `docker` and `gh`
 * on a PATH of their own (the real Docker is never touched) and a fake GitHub API in this process.
 */

const UPDATER = path.resolve("contrib/updater/fastmemo-updater.py");
const PYTHON = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout?.trim() ?? "";
const IMAGE = "ghcr.io/ontech7/fastmemo-server";
const DIGEST = "a".repeat(64);
const RUNNING_ID = `sha256:${"b".repeat(64)}`;
const CONTAINER = "0123456789ab".repeat(5) + "cdef";

/** Stands in for the docker CLI: logs every call (with the status at that moment) and answers from state.json. */
const DOCKER_STUB = `#!/usr/bin/env python3
import json, os, sys
state_dir = os.environ["STUB_STATE"]
state = json.load(open(os.path.join(state_dir, "state.json")))
args = sys.argv[1:]
try:
    status = json.load(open(state["statusFile"]))
except (OSError, ValueError):
    status = None
with open(os.path.join(state_dir, "calls.log"), "a") as log:
    log.write(json.dumps({"args": args, "status": status}) + "\\n")
source = "https://github.com/ontech7/fastmemo-server"
if args[0] == "compose" and "ps" in args:
    print(state.get("container", "${CONTAINER}"))
    sys.exit(0)
if args[:2] == ["container", "inspect"]:
    print(json.dumps([{
        "Id": args[-1],
        "Image": "${RUNNING_ID}",
        "Config": {
            "Image": state.get("image", "${IMAGE}:1"),
            "Env": state.get("env", ["PATH=/usr/local/bin:/usr/bin", "NODE_ENV=production", "DATA_DIR=/data", "DATABASE_URL="]),
        },
        "Mounts": state.get("mounts", [{
            "Type": "volume",
            "Name": "fastmemo-server_fastmemo-data",
            "Source": "/var/lib/docker/volumes/fastmemo-server_fastmemo-data/_data",
            "Destination": "/data",
        }]),
    }]))
    sys.exit(0)
if args[0] == "pull":
    sys.exit(1 if state.get("pullFails") else 0)
if args[:2] == ["image", "inspect"]:
    ref = args[-1]
    if "Labels" in args[3]:
        if ref == "${RUNNING_ID}":
            labels = state.get("runningLabels", {"org.opencontainers.image.source": source, "org.opencontainers.image.version": "1.1.0"})
        else:
            labels = state.get("labels", {"org.opencontainers.image.source": source, "org.opencontainers.image.version": ref.rsplit(":", 1)[1]})
        print(json.dumps(labels))
    else:
        print(json.dumps(state.get("repoDigests", ["${IMAGE}@sha256:${DIGEST}"])))
    sys.exit(0)
sys.exit(2)
`;

/** Stands in for the GitHub CLI: keeps its arguments and the token it saw, exits with GH_EXIT. */
const GH_STUB = `#!/bin/sh
printf '%s\\n' "$@" > "$STUB_STATE/gh.args"
exit "\${GH_EXIT:-0}"
`;

interface Call {
  args: string[];
  status: { state: string; verified: boolean | null; message: string | null } | null;
}

describe("updater", { skip: !PYTHON && "python3 is missing" }, () => {
  let server: http.Server;
  let api = "";
  const releases = new Map<string, { draft?: boolean; prerelease?: boolean }>();

  before(async () => {
    server = http.createServer((request, response) => {
      const tag = /^\/repos\/ontech7\/fastmemo-server\/releases\/tags\/v([\d.]+)$/.exec(request.url ?? "")?.[1];
      const release = tag ? releases.get(tag) : undefined;
      if (!tag || !release) return response.writeHead(404).end("{}");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tag_name: `v${tag}`, draft: false, prerelease: false, ...release }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  let root: string;
  let dirs: Record<"checkout" | "request" | "status" | "backup" | "etc" | "stub" | "bin", string>;

  beforeEach(() => {
    releases.clear();
    releases.set("1.2.0", {});
    releases.set("2.0.0", {});
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fastmemo-updater-"));
    dirs = {
      checkout: path.join(root, "fastmemo-server"),
      request: path.join(root, "request"),
      status: path.join(root, "status"),
      backup: path.join(root, "backup"),
      etc: path.join(root, "etc"),
      stub: path.join(root, "stub"),
      bin: path.join(root, "bin"),
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dirs.checkout, "contrib", "updater"), { recursive: true });
    fs.writeFileSync(path.join(dirs.checkout, ".env"), "FASTMEMO_ACCESS_KEY=0123456789abcdef\nFASTMEMO_IMAGE=\n");
    fs.writeFileSync(path.join(dirs.checkout, "docker-compose.yml"), "services: {}\n");
    fs.writeFileSync(path.join(dirs.checkout, "contrib", "updater", "compose.updater.yaml"), "services: {}\n");
    fs.symlinkSync(PYTHON, path.join(dirs.bin, "python3"));
    fs.writeFileSync(path.join(dirs.bin, "docker"), DOCKER_STUB, { mode: 0o755 });
    writeConfig({});
    setState({});
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function writeConfig(extra: Record<string, string>) {
    const values = {
      GITHUB_API: api,
      COMPOSE_DIR: dirs.checkout,
      REQUEST_DIR: dirs.request,
      STATUS_DIR: dirs.status,
      BACKUP_DIR: dirs.backup,
      COOLDOWN: "0",
      VERIFY_PROVENANCE: "off",
      ...extra,
    };
    const file = path.join(dirs.etc, "updater.env");
    fs.writeFileSync(
      file,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join("")
    );
    fs.chmodSync(file, 0o644);
  }

  const setState = (state: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(dirs.stub, "state.json"),
      JSON.stringify({ statusFile: path.join(dirs.status, "status.json"), ...state })
    );

  const request = (body: unknown) =>
    fs.writeFileSync(path.join(dirs.request, "request.json"), typeof body === "string" ? body : JSON.stringify(body));

  const withGh = () => fs.writeFileSync(path.join(dirs.bin, "gh"), GH_STUB, { mode: 0o755 });

  /** Async on purpose: the fake GitHub API lives in this process and must keep answering while Python runs. */
  const runUpdater = (env: Record<string, string> = {}) =>
    new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(
        PYTHON,
        ["-I", UPDATER],
        {
          // Only what is given here: no GH_TOKEN or real docker/gh from the developer's environment.
          env: {
            PATH: dirs.bin,
            FASTMEMO_UPDATER_CONFIG: path.join(dirs.etc, "updater.env"),
            STUB_STATE: dirs.stub,
            ...env,
          },
          timeout: 60_000,
        },
        (error, _stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stderr })
      );
    });

  const statusFile = () => path.join(dirs.status, "status.json");
  const status = () => JSON.parse(fs.readFileSync(statusFile(), "utf8"));
  const requestLeft = () => fs.existsSync(path.join(dirs.request, "request.json"));
  const calls = (): Call[] => {
    const log = path.join(dirs.stub, "calls.log");
    if (!fs.existsSync(log)) return [];
    return fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  const pulled = () => calls().some((call) => call.args[0] === "pull");
  const stopped = () => calls().some((call) => call.args[0] === "compose" && call.args.includes("stop"));
  const resetCalls = () => fs.rmSync(path.join(dirs.stub, "calls.log"), { force: true });

  test("does nothing without a request", async () => {
    assert.equal((await runUpdater()).code, 0);
    assert.equal(fs.existsSync(statusFile()), false);
    assert.deepEqual(calls(), []);
  });

  test("refuses to run with a configuration others may write", async () => {
    fs.chmodSync(path.join(dirs.etc, "updater.env"), 0o664);
    request({ version: "1.2.0" });
    const result = await runUpdater();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not writable by group or others/);
    assert.deepEqual(calls(), []);
    assert.equal(fs.existsSync(statusFile()), false);
    assert.equal(requestLeft(), true);
  });

  test("refuses to run without the checkout it updates", async () => {
    const file = path.join(dirs.etc, "updater.env");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^COMPOSE_DIR=.*\n/m, ""));
    request({ version: "1.2.0" });
    const result = await runUpdater();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /COMPOSE_DIR/);
    assert.deepEqual(calls(), []);
  });

  test("checks a newer release of the same major, then verifies the image it would switch to", async () => {
    request({ version: "1.2.0" });
    assert.equal((await runUpdater()).code, 0);
    assert.deepEqual(
      { ...status(), at: 0 },
      { state: "failed", version: "1.2.0", message: "switching is not implemented yet", at: 0, verified: false }
    );
    assert.ok(Math.abs(status().at - Date.now()) < 60_000);
    assert.equal(requestLeft(), false);
    assert.equal(fs.statSync(statusFile()).mode & 0o777, 0o644);

    const compose = [
      "compose",
      "--project-directory",
      dirs.checkout,
      "-f",
      path.join(dirs.checkout, "docker-compose.yml"),
      "-f",
      path.join(dirs.checkout, "contrib/updater/compose.updater.yaml"),
      "--env-file",
      path.join(dirs.checkout, ".env"),
    ];
    const args = calls().map((call) => call.args);
    assert.deepEqual(args[0], [...compose, "ps", "-q", "fastmemo"]);
    assert.deepEqual(args[1], ["container", "inspect", CONTAINER]);
    assert.deepEqual(
      args.find((a) => a[0] === "pull"),
      ["pull", "--quiet", `${IMAGE}:1.2.0`]
    );
    assert.equal(stopped(), false);
  });

  test("resolves the checkout's own .env and compose files, absolute or relative", async () => {
    writeConfig({ COMPOSE_FILE: `docker-compose.yml:${path.join(root, "other.yml")}`, ENV_FILE: path.join(root, "env") });
    request({ version: "1.2.0" });
    await runUpdater();
    const ps = calls()[0]?.args ?? [];
    assert.deepEqual(ps.slice(3, 9), [
      "-f",
      path.join(dirs.checkout, "docker-compose.yml"),
      "-f",
      path.join(root, "other.yml"),
      "--env-file",
      path.join(root, "env"),
    ]);
  });

  test("a request that is a symlink, a directory, too big or not a plain version fails, and is removed", async () => {
    const secret = path.join(root, "secret.txt");
    fs.writeFileSync(secret, '{"version": "1.2.0", "token": "do-not-leak"}');
    const cases: [() => void, string][] = [
      [() => fs.symlinkSync(secret, path.join(dirs.request, "request.json")), "the request was not a plain file"],
      [
        () => fs.mkdirSync(path.join(dirs.request, "request.json", "deeper"), { recursive: true }),
        "the request was not a small plain file",
      ],
      [() => request({ version: "1.2.0", pad: "x".repeat(1100) }), "the request was not a small plain file"],
      [() => request({ version: "1.2.0\n" }), "the request did not name a version"],
      [() => request({ version: "1.2.0; rm -rf /" }), "the request did not name a version"],
      [() => request({ version: "١.2.0" }), "the request did not name a version"],
      [() => request({ version: 120 }), "the request did not name a version"],
      [() => request("{nope"), "the request was not valid"],
      [() => request("[]"), "the request was not valid"],
      [() => request(`${"[".repeat(500)}${"]".repeat(500)}`), "the request was not valid"],
    ];
    for (const [make, message] of cases) {
      make();
      assert.equal((await runUpdater()).code, 0);
      assert.deepEqual({ ...status(), at: 0 }, { state: "failed", version: "0.0.0", message, at: 0, verified: null });
      assert.equal(fs.existsSync(path.join(dirs.request, "request.json")), false, message);
    }
    assert.equal(pulled(), false);
    assert.deepEqual(calls(), []);
    assert.equal(fs.readFileSync(secret, "utf8").includes("do-not-leak"), true);
    assert.equal(fs.readFileSync(statusFile(), "utf8").includes("do-not-leak"), false);
  });

  test("refuses a version that is not a published final release or not newer than the running one", async () => {
    releases.set("1.3.0", { prerelease: true });
    releases.set("1.4.0", { draft: true });
    const cases: [string, string][] = [
      ["1.5.0", "this version is not a published release"],
      ["1.3.0", "this version is not a published release"],
      ["1.4.0", "this version is not a published release"],
      ["1.1.0", "this version is not newer than the running one"],
      ["1.0.9", "this version is not newer than the running one"],
      ["0.9.0", "this version is not newer than the running one"],
    ];
    for (const [version, message] of cases) {
      request({ version });
      await runUpdater();
      assert.deepEqual({ ...status(), at: 0 }, { state: "refused", version, message, at: 0, verified: null });
    }
    assert.equal(pulled(), false);
  });

  test("refuses another major version", async () => {
    setState({
      runningLabels: {
        "org.opencontainers.image.source": "https://github.com/ontech7/fastmemo-server",
        "org.opencontainers.image.version": "1.4.0",
      },
    });
    request({ version: "2.0.0" });
    await runUpdater();
    assert.equal(status().state, "refused");
    assert.match(status().message, /major/);
    assert.equal(pulled(), false);
  });

  test("refuses a server on PostgreSQL, or with a database it doesn't know", async () => {
    const base = ["PATH=/usr/local/bin:/usr/bin", "NODE_ENV=production", "DATA_DIR=/data"];
    for (const url of ["postgres://fastmemo:secret-pw@postgres:5432/fastmemo", "POSTGRESQL://db/fastmemo"]) {
      setState({ env: [...base, `DATABASE_URL=${url}`] });
      request({ version: "1.2.0" });
      await runUpdater();
      assert.equal(status().state, "refused");
      assert.match(status().message, /PostgreSQL/);
      assert.equal(fs.readFileSync(statusFile(), "utf8").includes("secret-pw"), false);
    }
    for (const env of [[...base, "DATABASE_URL=sqlite:/data/other.db"], ["DATA_DIR=/elsewhere"], ["NODE_ENV=production"]]) {
      setState({ env });
      request({ version: "1.2.0" });
      await runUpdater();
      assert.equal(status().state, "refused", env.join(" "));
    }
    assert.equal(pulled(), false);
    assert.equal(stopped(), false);
  });

  test("refuses an image built from source, and takes any tag of the published one", async () => {
    for (const image of [
      "fastmemo-server:local",
      "ghcr.io/ontech7/fastmemo-server-dev:1",
      "ghcr.io/someone/fastmemo-server:1",
      "localhost:5000/ghcr.io/ontech7/fastmemo-server:1",
    ]) {
      setState({ image });
      request({ version: "1.2.0" });
      await runUpdater();
      assert.equal(status().state, "refused", image);
      assert.match(status().message, /source/);
    }
    // Tagged like the published image but without its labels: built from source too.
    for (const runningLabels of [
      {},
      { "org.opencontainers.image.source": "https://github.com/ontech7/fastmemo-server" },
      {
        "org.opencontainers.image.source": "https://github.com/ontech7/fastmemo-server",
        "org.opencontainers.image.version": "1.1.0-rc.1",
      },
      { "org.opencontainers.image.source": "https://github.com/someone/else", "org.opencontainers.image.version": "1.1.0" },
    ]) {
      setState({ runningLabels });
      request({ version: "1.2.0" });
      await runUpdater();
      assert.equal(status().state, "refused", JSON.stringify(runningLabels));
      assert.match(status().message, /source/);
    }
    assert.equal(pulled(), false);

    for (const image of [`${IMAGE}:latest`, `${IMAGE}:1`, `${IMAGE}:1.1.0@sha256:${DIGEST}`, `${IMAGE}@sha256:${DIGEST}`]) {
      setState({ image });
      request({ version: "1.2.0" });
      await runUpdater();
      assert.equal(status().message, "switching is not implemented yet", image);
    }
  });

  test("refuses a server whose data isn't in a volume at /data", async () => {
    for (const mounts of [
      [],
      [{ Type: "bind", Source: "/srv/fastmemo", Destination: "/data" }],
      [{ Type: "volume", Name: "fastmemo-data", Source: "/var/lib/docker/volumes/fastmemo-data/_data", Destination: "/srv" }],
    ]) {
      setState({ mounts });
      request({ version: "1.2.0" });
      await runUpdater();
      assert.equal(status().state, "refused", JSON.stringify(mounts));
      assert.match(status().message, /\/data/);
    }
    assert.equal(pulled(), false);
  });

  test("fails without the running server", async () => {
    setState({ container: "" });
    request({ version: "1.2.0" });
    await runUpdater();
    assert.deepEqual(
      { ...status(), at: 0 },
      {
        state: "failed",
        version: "1.2.0",
        message: "the running server was not found",
        at: 0,
        verified: null,
      }
    );
    assert.equal(pulled(), false);
  });

  test("fails on an image that doesn't say it is this repository's release of that version", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        {
          labels: {
            "org.opencontainers.image.source": "https://github.com/someone/else",
            "org.opencontainers.image.version": "1.2.0",
          },
        },
        "the image does not come from the expected repository",
      ],
      [
        {
          labels: {
            "org.opencontainers.image.source": "https://github.com/ontech7/fastmemo-server",
            "org.opencontainers.image.version": "1.1.0",
          },
        },
        "the image does not carry the expected version",
      ],
      [
        { repoDigests: ["ghcr.io/someone/else@sha256:" + DIGEST, `${IMAGE}@sha256:short`] },
        "the image digest could not be read",
      ],
      [{ pullFails: true }, "docker pull failed"],
    ];
    for (const [state, message] of cases) {
      setState(state);
      request({ version: "1.2.0" });
      await runUpdater();
      assert.deepEqual({ ...status(), at: 0 }, { state: "failed", version: "1.2.0", message, at: 0, verified: null });
    }
    assert.equal(stopped(), false);
  });

  test("with VERIFY_PROVENANCE=required, fails without the GitHub CLI or its token", async () => {
    writeConfig({ VERIFY_PROVENANCE: "required" });
    request({ version: "1.2.0" });
    await runUpdater({ GH_TOKEN: "token" });
    assert.equal(status().state, "failed");
    assert.equal(status().message, "build provenance is required but the GitHub CLI or its token is missing");

    withGh();
    request({ version: "1.2.0" });
    await runUpdater();
    assert.equal(status().state, "failed");
    assert.equal(status().message, "build provenance is required but the GitHub CLI or its token is missing");
    assert.equal(fs.existsSync(path.join(dirs.stub, "gh.args")), false);
    assert.equal(stopped(), false);
  });

  test("fails when the build provenance doesn't verify", async () => {
    writeConfig({ VERIFY_PROVENANCE: "auto" });
    withGh();
    request({ version: "1.2.0" });
    await runUpdater({ GH_TOKEN: "token", GH_EXIT: "1" });
    assert.deepEqual(
      { ...status(), at: 0 },
      {
        state: "failed",
        version: "1.2.0",
        message: "the build provenance of the image could not be verified",
        at: 0,
        verified: false,
      }
    );
    assert.equal(stopped(), false);
  });

  test("by default goes on without the GitHub CLI, and says the provenance wasn't verified", async () => {
    writeConfig({ VERIFY_PROVENANCE: "auto" });
    request({ version: "1.2.0" });
    await runUpdater({ GH_TOKEN: "token" });
    const seen = calls().map((call) => call.status);
    assert.ok(seen.length > 0);
    // Until the check, nothing is known about the provenance; the status of the pull says so.
    const atPull = calls().find((call) => call.args[0] === "pull")?.status;
    assert.deepEqual([atPull?.state, atPull?.verified], ["downloading", null]);
    for (const seenStatus of seen) assert.equal(seenStatus?.verified ?? null, null);
    assert.equal(status().message, "switching is not implemented yet");
    assert.equal(status().verified, false);

    // A gh with no token is the same: not verified.
    withGh();
    request({ version: "1.2.0" });
    await runUpdater();
    assert.equal(fs.existsSync(path.join(dirs.stub, "gh.args")), false);
    assert.equal(status().verified, false);
  });

  test("verifies the provenance of the exact digest, built by the release workflow from its tag", async () => {
    writeConfig({ VERIFY_PROVENANCE: "auto" });
    withGh();
    request({ version: "1.2.0" });
    await runUpdater({ GH_TOKEN: "token" });
    assert.deepEqual(fs.readFileSync(path.join(dirs.stub, "gh.args"), "utf8").trim().split("\n"), [
      "attestation",
      "verify",
      `oci://${IMAGE}@sha256:${DIGEST}`,
      "--repo",
      "ontech7/fastmemo-server",
      "--signer-workflow",
      "ontech7/fastmemo-server/.github/workflows/release.yml",
      "--source-ref",
      "refs/tags/v1.2.0",
      "--deny-self-hosted-runners",
    ]);
    assert.equal(status().message, "switching is not implemented yet");
    assert.equal(status().verified, true);
  });

  test("never puts text from the request in a status", async () => {
    writeConfig({ VERIFY_PROVENANCE: "auto" });
    setState({
      runningLabels: {
        "org.opencontainers.image.source": "https://github.com/ontech7/fastmemo-server",
        "org.opencontainers.image.version": "1.1.7",
      },
    });
    const bodies = [
      { version: "1.2.0", note: "MARKER" },
      { version: "2.0.0", note: "MARKER" },
      { version: "1.1.3", note: "MARKER" },
      { version: "1.6.0", note: "MARKER" },
      { version: "MARKER" },
      { version: "1.2.0 MARKER" },
      { MARKER: "1.2.0" },
      "MARKER",
    ];
    const messages: string[] = [];
    for (const body of bodies) {
      resetCalls();
      request(body);
      await runUpdater();
      const text = fs.readFileSync(statusFile(), "utf8");
      assert.equal(text.includes("MARKER"), false);
      messages.push(status().message, ...calls().map((call) => call.status?.message ?? ""));
    }
    for (const message of messages) {
      for (const version of ["1.2.0", "2.0.0", "1.1.3", "1.6.0"]) assert.equal(message.includes(version), false, message);
    }
  });

  test("spaces runs out, so a flood of requests cannot keep it busy", async () => {
    writeConfig({ COOLDOWN: "2" });
    request("{nope");
    await runUpdater();
    request("{nope");
    const started = Date.now();
    await runUpdater();
    assert.ok(Date.now() - started > 1500);
  });
});
