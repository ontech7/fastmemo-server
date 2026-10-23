import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
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
const ENV = "FASTMEMO_ACCESS_KEY=0123456789abcdef\nFASTMEMO_IMAGE=\nTZ=Europe/Rome\n";
const PINNED = `FASTMEMO_IMAGE=${IMAGE}:1.2.0@sha256:${DIGEST}`;
/** Tests that make a file unwritable or unreadable: root reads and writes through any mode. */
const AS_ROOT = process.getuid?.() === 0 && "root ignores file modes";

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
def image_line():
    lines = [line for line in open(state["envFile"]).read().split("\\n") if line.startswith("FASTMEMO_IMAGE=")]
    return lines[-1] if lines else None
line = image_line()
# Which version the checkout's .env runs: the one the updater pinned by digest, or the previous one.
running = "new" if line and line.endswith("@sha256:${DIGEST}") else "old"
try:
    marker = json.load(open(os.path.join(state["backupDir"], "switch.json")))
except (OSError, ValueError):
    marker = None
with open(os.path.join(state_dir, "calls.log"), "a") as log:
    log.write(json.dumps({"args": args, "status": status, "image": line, "marker": marker}) + "\\n")
source = "https://github.com/ontech7/fastmemo-server"
data = state["volume"]
if args[0] == "compose" and "ps" in args:
    print(state.get("container", "${CONTAINER}"))
    sys.exit(0)
if args[0] == "compose" and "stop" in args:
    sys.exit(1 if running in state.get("stopFails", []) else 0)
if args[0] == "compose" and "up" in args:
    if running in state.get("upFails", []):
        sys.exit(1)
    if running == "new" and state.get("migrate") and not os.path.exists(os.path.join(state_dir, "migrated")):
        # The new version migrates the database the first time it starts.
        open(os.path.join(state_dir, "migrated"), "w").close()
        open(os.path.join(data, "fastmemo.db"), "w").write("migrated by 1.2.0")
        open(os.path.join(data, "fastmemo.db-wal"), "w").write("wal at 1.2.0")
        open(os.path.join(data, "fastmemo.db-shm"), "w").write("shm at 1.2.0")
    if running == "new" and state.get("lockBackupWal"):
        for name in os.listdir(state["backupDir"]):
            if name[0].isdigit():
                os.chmod(os.path.join(state["backupDir"], name, "fastmemo.db-wal"), 0)
    if running == "new" and state.get("loseBackup"):
        for name in os.listdir(state["backupDir"]):
            if name[0].isdigit():
                os.unlink(os.path.join(state["backupDir"], name, "fastmemo.db"))
    sys.exit(0)
if args[:2] == ["volume", "inspect"]:
    print(data)
    sys.exit(0)
if args[:2] == ["container", "inspect"] and "{{.State.Running}}" in args:
    print(state.get("running", "true"))
    sys.exit(0)
if args[:2] == ["container", "inspect"] and "{{.State.Health.Status}}" in args:
    health = state.get("health", {}).get(running, "healthy")
    if isinstance(health, list):
        # One answer per poll, the last one from then on.
        polls = os.path.join(state_dir, f"polls-{running}")
        count = len(open(polls).read()) if os.path.exists(polls) else 0
        open(polls, "a").write(".")
        health = health[min(count, len(health) - 1)]
    print(health)
    sys.exit(0)
if args[:2] == ["container", "inspect"]:
    print(json.dumps([{
        "Id": args[-1],
        "Image": "${RUNNING_ID}",
        "Config": {
            "Image": state.get("image", "${IMAGE}:1"),
            "Env": state.get("env", ["PATH=/usr/local/bin:/usr/bin", "NODE_ENV=production", "DATA_DIR=/data", "DATABASE_URL="]),
            "Labels": state["containerLabels"],
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
  /** The .env's FASTMEMO_IMAGE line when docker was called. */
  image: string | null;
  /** switch.json when docker was called. */
  marker: { folder: string | null; new_started: boolean } | null;
}

describe("updater", { skip: !PYTHON && "python3 is missing" }, () => {
  let server: http.Server;
  let api = "";
  const releases = new Map<string, { draft?: boolean; prerelease?: boolean }>();
  /** When set, every answer of the fake GitHub has this status (a rate limit, an outage). */
  let githubStatus: number | null = null;

  before(async () => {
    server = http.createServer((request, response) => {
      if (githubStatus) return response.writeHead(githubStatus).end('{"message":"API rate limit exceeded"}');
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
  let dirs: Record<"checkout" | "request" | "status" | "backup" | "data" | "etc" | "stub" | "bin", string>;

  beforeEach(() => {
    releases.clear();
    githubStatus = null;
    releases.set("1.2.0", {});
    releases.set("2.0.0", {});
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fastmemo-updater-"));
    dirs = {
      checkout: path.join(root, "fastmemo-server"),
      request: path.join(root, "request"),
      status: path.join(root, "status"),
      backup: path.join(root, "backup"),
      data: path.join(root, "data"),
      etc: path.join(root, "etc"),
      stub: path.join(root, "stub"),
      bin: path.join(root, "bin"),
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dirs.checkout, "contrib", "updater"), { recursive: true });
    fs.writeFileSync(path.join(dirs.checkout, ".env"), ENV);
    // The data volume, as `docker volume inspect` shows it: the database with its WAL, no -shm.
    fs.writeFileSync(path.join(dirs.data, "fastmemo.db"), "notes at 1.1.0");
    fs.writeFileSync(path.join(dirs.data, "fastmemo.db-wal"), "wal at 1.1.0");
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

  const startedWith = (
    files = [path.join(dirs.checkout, "docker-compose.yml"), path.join(dirs.checkout, "contrib/updater/compose.updater.yaml")],
    directory: string | null = dirs.checkout
  ): Record<string, string> => ({
    "com.docker.compose.project": "fastmemo-server",
    "com.docker.compose.service": "fastmemo",
    ...(files ? { "com.docker.compose.project.config_files": files.join(",") } : {}),
    ...(directory !== null ? { "com.docker.compose.project.working_dir": directory } : {}),
  });

  const setState = (state: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(dirs.stub, "state.json"),
      JSON.stringify({
        statusFile: path.join(dirs.status, "status.json"),
        envFile: path.join(dirs.checkout, ".env"),
        volume: dirs.data,
        backupDir: dirs.backup,
        // What compose records on the container it starts: by default the files updater.env names.
        containerLabels: startedWith(),
        ...state,
      })
    );

  const request = (body: unknown) =>
    fs.writeFileSync(path.join(dirs.request, "request.json"), typeof body === "string" ? body : JSON.stringify(body));

  const withGh = () => fs.writeFileSync(path.join(dirs.bin, "gh"), GH_STUB, { mode: 0o755 });

  /** Async on purpose: the fake GitHub API lives in this process and must keep answering while Python runs. */
  const startUpdater = (env: Record<string, string> = {}) => {
    let child: ChildProcess | undefined;
    const done = new Promise<{ code: number; stderr: string }>((resolve) => {
      child = execFile(
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
    return { done, child: child as ChildProcess };
  };
  const runUpdater = (env: Record<string, string> = {}) => startUpdater(env).done;

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
  const env = () => fs.readFileSync(path.join(dirs.checkout, ".env"), "utf8");
  const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");
  const backups = () =>
    fs
      .readdirSync(dirs.backup)
      .filter((name) => /^\d/.test(name))
      .sort();
  const marker = () => path.join(dirs.backup, "switch.json");
  const composeArgs = () => [
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
  const isHealth = (call: Call) => call.args.includes("{{.State.Health.Status}}");
  const ups = () => calls().filter((call) => call.args[0] === "compose" && call.args.includes("up"));
  /** The database is back as it was before the switch: same bytes, no -shm the new version left, owned like /data. */
  const assertDatabaseBack = () => {
    assert.equal(read(dirs.data, "fastmemo.db"), "notes at 1.1.0");
    assert.equal(read(dirs.data, "fastmemo.db-wal"), "wal at 1.1.0");
    assert.equal(fs.existsSync(path.join(dirs.data, "fastmemo.db-shm")), false);
    const owner = fs.statSync(dirs.data);
    for (const name of ["fastmemo.db", "fastmemo.db-wal"]) {
      const info = fs.statSync(path.join(dirs.data, name));
      assert.deepEqual([info.uid, info.gid], [owner.uid, owner.gid]);
    }
  };
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  };

  test("does nothing without a request", async () => {
    assert.equal((await runUpdater()).code, 0);
    assert.equal(fs.existsSync(statusFile()), false);
    assert.deepEqual(calls(), []);
  });

  /** Settings it can't use: nothing runs, but the request goes (the path unit would start it again and again) and the
   * dashboard is told. */
  const assertSettingsRefused = (result: { code: number }) => {
    assert.notEqual(result.code, 0);
    assert.deepEqual(calls(), []);
    assert.equal(requestLeft(), false);
    assert.deepEqual(
      [status().state, status().version, status().message],
      ["failed", "1.2.0", "the updater's settings are not valid: check its log (journalctl -u fastmemo-updater)"]
    );
  };

  test("refuses to run with a configuration others may write", async () => {
    fs.chmodSync(path.join(dirs.etc, "updater.env"), 0o664);
    request({ version: "1.2.0" });
    const result = await runUpdater();
    assert.match(result.stderr, /not writable by group or others/);
    assertSettingsRefused(result);
  });

  test("refuses to run without the checkout it updates", async () => {
    const file = path.join(dirs.etc, "updater.env");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^COMPOSE_DIR=.*\n/m, ""));
    request({ version: "1.2.0" });
    const result = await runUpdater();
    assert.match(result.stderr, /COMPOSE_DIR/);
    assertSettingsRefused(result);
  });

  test("refuses settings with a value that is not valid, or a status folder that isn't there", async () => {
    const cases: Record<string, string>[] = [
      { HEALTH_TIMEOUT: "soon" },
      { BACKUP_DIR: "backup" },
      { STATUS_DIR: path.join(root, "nowhere") },
    ];
    for (const extra of cases) {
      writeConfig(extra);
      request({ version: "1.2.0" });
      const result = await runUpdater();
      assert.match(result.stderr, /not valid/, JSON.stringify(extra));
      assert.notEqual(result.code, 0);
      assert.equal(requestLeft(), false, JSON.stringify(extra));
      assert.deepEqual(calls(), []);
      if (!extra.STATUS_DIR) assertSettingsRefused(result);
    }
  });

  test("with settings it can't use and no request, writes no status", async () => {
    fs.chmodSync(path.join(dirs.etc, "updater.env"), 0o666);
    const result = await runUpdater();
    assert.notEqual(result.code, 0);
    assert.equal(fs.existsSync(statusFile()), false);
    assert.deepEqual(calls(), []);
  });

  test("checks a newer release of the same major, then verifies the image it would switch to", async () => {
    request({ version: "1.2.0" });
    assert.equal((await runUpdater()).code, 0);
    assert.deepEqual({ ...status(), at: 0 }, { state: "done", version: "1.2.0", message: null, at: 0, verified: false });
    assert.ok(Math.abs(status().at - Date.now()) < 60_000);
    assert.equal(requestLeft(), false);
    assert.equal(fs.statSync(statusFile()).mode & 0o777, 0o644);

    const args = calls().map((call) => call.args);
    assert.deepEqual(args[0], [...composeArgs(), "ps", "-q", "fastmemo"]);
    assert.deepEqual(args[1], ["container", "inspect", CONTAINER]);
    assert.deepEqual(
      args.find((a) => a[0] === "pull"),
      ["pull", "--quiet", `${IMAGE}:1.2.0`]
    );
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
      assert.deepEqual([status().state, status().message], ["done", null], image);
    }
  });

  test("refuses a server started with other compose files than updater.env names", async () => {
    const message =
      "the server was started with other compose files than COMPOSE_FILE in updater.env: update it with the commands in the dashboard";
    const files = [
      path.join(dirs.checkout, "docker-compose.yml"),
      path.join(dirs.checkout, "contrib/updater/compose.updater.yaml"),
    ];
    for (const containerLabels of [
      {},
      startedWith(undefined, null),
      startedWith([files[0]!]),
      startedWith([path.join(dirs.checkout, "docker-compose.caddy.yml"), files[1]!]),
      startedWith([...files, path.join(dirs.checkout, "docker-compose.build.yml")]),
      startedWith(files, path.join(root, "elsewhere")),
      startedWith(["docker-compose.yml", "contrib/updater/compose.updater.yaml"]),
      { ...startedWith(), "com.docker.compose.project.config_files": "" },
    ]) {
      setState({ containerLabels });
      request({ version: "1.2.0" });
      await runUpdater();
      assert.deepEqual([status().state, status().message], ["refused", message], JSON.stringify(containerLabels));
    }
    assert.equal(pulled(), false);

    // The same files in another order, or written another way, are the same setup.
    for (const containerLabels of [
      startedWith([files[1]!, files[0]!]),
      startedWith(
        [`${dirs.checkout}/./docker-compose.yml`, `${dirs.checkout}//contrib/updater/compose.updater.yaml`],
        `${dirs.checkout}/`
      ),
    ]) {
      setState({ containerLabels });
      request({ version: "1.2.0" });
      await runUpdater();
      assert.deepEqual([status().state, status().message], ["done", null], JSON.stringify(containerLabels));
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

  test("fails when GitHub refuses to answer or answers garbage", async () => {
    for (const code of [403, 429, 500]) {
      githubStatus = code;
      request({ version: "1.2.0" });
      assert.equal((await runUpdater()).code, 0);
      assert.deepEqual([status().state, status().message], ["failed", "GitHub could not be reached"], String(code));
    }
    githubStatus = null;

    // Not HTTP at all: http.client raises its own errors, which must end the same way.
    const sockets = new Set<net.Socket>();
    const garbage = net.createServer((socket) => {
      sockets.add(socket);
      socket.end("not http\r\n\r\n");
    });
    await new Promise<void>((resolve) => garbage.listen(0, "127.0.0.1", resolve));
    try {
      writeConfig({ GITHUB_API: `http://127.0.0.1:${(garbage.address() as AddressInfo).port}` });
      request({ version: "1.2.0" });
      const result = await runUpdater();
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      assert.deepEqual([status().state, status().message], ["failed", "GitHub could not be reached"]);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => garbage.close(() => resolve()));
    }
    assert.equal(pulled(), false);
  });

  test("fails cleanly when docker can't be run", async () => {
    fs.chmodSync(path.join(dirs.bin, "docker"), 0o644);
    request({ version: "1.2.0" });
    const result = await runUpdater();
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual([status().state, status().message], ["failed", "docker could not be run"]);

    fs.rmSync(path.join(dirs.bin, "docker"));
    request({ version: "1.2.0" });
    assert.equal((await runUpdater()).code, 0);
    assert.deepEqual([status().state, status().message], ["failed", "docker could not be run"]);
  });

  test("refuses a container whose inspect output it can't make sense of", async () => {
    setState({ env: 5 });
    request({ version: "1.2.0" });
    const result = await runUpdater();
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    // No settings to read: no DATA_DIR=/data, so the database can't be found in the volume.
    assert.deepEqual(
      [status().state, status().message],
      ["refused", "the database is not in the volume at /data: update it with the commands in the dashboard"]
    );
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
    // After it (from the copy on), the status says it wasn't verified.
    for (const seenStatus of seen) {
      const after = ["backing_up", "restarting"].includes(seenStatus?.state ?? "");
      assert.equal(seenStatus?.verified ?? null, after ? false : null, seenStatus?.state);
    }
    assert.ok(seen.some((seenStatus) => seenStatus?.state === "restarting"));
    assert.deepEqual([status().state, status().message], ["done", null]);
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
    assert.deepEqual([status().state, status().message], ["done", null]);
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
      messages.push(status().message ?? "", ...calls().map((call) => call.status?.message ?? ""));
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

  test("stops the server, copies its database, pins the new image in .env and waits for it to be healthy", async () => {
    fs.chmodSync(path.join(dirs.checkout, ".env"), 0o600);
    fs.chmodSync(path.join(dirs.data, "fastmemo.db-wal"), 0o640);
    request({ version: "1.2.0" });
    const result = await runUpdater();
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual({ ...status(), at: 0 }, { state: "done", version: "1.2.0", message: null, at: 0, verified: false });

    // In order: the image is checked, then the server stops, then the new image starts and is waited for.
    const all = calls();
    const at = (match: (call: Call) => boolean) => all.findIndex(match);
    const pull = at((call) => call.args[0] === "pull");
    const stop = at((call) => call.args.join(" ") === [...composeArgs(), "stop", "fastmemo"].join(" "));
    const up = at((call) => call.args.join(" ") === [...composeArgs(), "up", "-d", "--no-build", "fastmemo"].join(" "));
    const health = at(isHealth);
    assert.ok(pull >= 0 && pull < stop && stop < up && up < health, JSON.stringify(all.map((call) => call.args)));
    assert.equal(all[stop]?.status?.state, "backing_up");
    assert.deepEqual([all[stop]?.image, all[up]?.image], ["FASTMEMO_IMAGE=", PINNED]);
    assert.equal(all[up]?.status?.state, "restarting");
    // A power cut at any of these moments is undone at boot: the marker is already on the disk.
    assert.deepEqual([all[stop]?.marker?.folder, all[stop]?.marker?.new_started], [null, false]);
    assert.deepEqual(
      [all[up]?.marker?.folder, all[up]?.marker?.new_started],
      [path.join(dirs.backup, backups()[0] as string), true]
    );
    assert.deepEqual(all[health]?.args, ["container", "inspect", "--format", "{{.State.Health.Status}}", CONTAINER]);
    assert.ok(
      all.some((call) => call.args.join(" ") === `volume inspect --format {{.Mountpoint}} fastmemo-server_fastmemo-data`)
    );

    // Only the image line changed, in place; the file keeps its mode.
    assert.equal(env(), `FASTMEMO_ACCESS_KEY=0123456789abcdef\n${PINNED}\nTZ=Europe/Rome\n`);
    assert.equal(fs.statSync(path.join(dirs.checkout, ".env")).mode & 0o777, 0o600);

    // The copy: the same bytes, the previous image line with it, nothing for a -shm that wasn't there.
    const [folder, ...others] = backups();
    assert.deepEqual(others, []);
    assert.match(folder ?? "", /^\d{8}-\d{6}-\d{6}-1\.1\.0$/);
    const copy = path.join(dirs.backup, folder as string);
    assert.deepEqual(fs.readdirSync(copy).sort(), ["fastmemo.db", "fastmemo.db-wal", "image.env"]);
    assert.equal(read(copy, "fastmemo.db"), "notes at 1.1.0");
    assert.equal(read(copy, "fastmemo.db-wal"), "wal at 1.1.0");
    assert.equal(read(copy, "image.env"), "FASTMEMO_IMAGE=\n");
    for (const name of ["fastmemo.db", "fastmemo.db-wal"]) {
      const [from, to] = [fs.statSync(path.join(dirs.data, name)), fs.statSync(path.join(copy, name))];
      assert.deepEqual([to.mode & 0o777, to.uid, to.gid], [from.mode & 0o777, from.uid, from.gid], name);
    }
    assert.equal(fs.existsSync(marker()), false);
  });

  test("adds the image line to a .env that has none", async () => {
    fs.writeFileSync(path.join(dirs.checkout, ".env"), "FASTMEMO_ACCESS_KEY=0123456789abcdef");
    request({ version: "1.2.0" });
    await runUpdater();
    assert.equal(status().state, "done");
    assert.equal(env(), `FASTMEMO_ACCESS_KEY=0123456789abcdef\n${PINNED}\n`);
    assert.equal(read(dirs.backup, backups()[0] as string, "image.env"), "");
  });

  test("puts the previous image and database back when the new version doesn't become healthy", async () => {
    writeConfig({ HEALTH_TIMEOUT: "2" });
    fs.chmodSync(path.join(dirs.data, "fastmemo.db-wal"), 0o640);
    setState({ health: { new: "unhealthy" }, migrate: true });
    request({ version: "1.2.0" });
    const started = Date.now();
    const result = await runUpdater();
    assert.equal(result.code, 0);
    assert.ok(Date.now() - started > 1500);
    assert.deepEqual(
      { ...status(), at: 0 },
      {
        state: "rolled_back",
        version: "1.2.0",
        message: "the new version did not become healthy; the previous version is running again",
        at: 0,
        verified: false,
      }
    );
    assert.equal(env(), ENV);
    assertDatabaseBack();
    assert.equal(fs.statSync(path.join(dirs.data, "fastmemo.db-wal")).mode & 0o777, 0o640);
    // The previous image is the one started last, and waited for.
    assert.deepEqual(
      ups().map((call) => call.image),
      [PINNED, "FASTMEMO_IMAGE="]
    );
    assert.equal(calls().at(-1)?.image, "FASTMEMO_IMAGE=");
    assert.ok(isHealth(calls().at(-1) as Call));
    assert.equal(fs.existsSync(marker()), false);
    // The copy stays, for the record.
    assert.equal(backups().length, 1);
  });

  test("stops waiting once the new version is reported unhealthy twice in a row", async () => {
    writeConfig({ HEALTH_TIMEOUT: "60" });
    setState({ health: { new: ["starting", "unhealthy", "unhealthy"] }, migrate: true });
    request({ version: "1.2.0" });
    const started = Date.now();
    assert.equal((await runUpdater()).code, 0);
    assert.ok(Date.now() - started < 30_000, "not the whole timeout");
    assert.deepEqual(
      [status().state, status().message],
      ["rolled_back", "the new version did not become healthy; the previous version is running again"]
    );
    assert.equal(calls().filter((call) => isHealth(call) && call.image === PINNED).length, 3);
    assertDatabaseBack();
  });

  test("a single unhealthy answer is not a verdict", async () => {
    writeConfig({ HEALTH_TIMEOUT: "60" });
    setState({ health: { new: ["unhealthy", "healthy"] }, migrate: true });
    request({ version: "1.2.0" });
    assert.equal((await runUpdater()).code, 0);
    assert.equal(status().state, "done");
    assert.equal(env(), `FASTMEMO_ACCESS_KEY=0123456789abcdef\n${PINNED}\nTZ=Europe/Rome\n`);
  });

  test("rolls back when the new version can't be started", async () => {
    setState({ upFails: ["new"] });
    request({ version: "1.2.0" });
    await runUpdater();
    assert.deepEqual(
      [status().state, status().message],
      ["rolled_back", "the new version could not be started; the previous version is running again"]
    );
    assert.equal(env(), ENV);
    assertDatabaseBack();
    assert.equal(ups().at(-1)?.image, "FASTMEMO_IMAGE=");
  });

  test("a rollback step that fails doesn't stop the others, and the status says to check the log", async () => {
    writeConfig({ HEALTH_TIMEOUT: "1" });
    // The stop says it failed, but the container did stop: the copy can go back.
    setState({ health: { new: "unhealthy" }, migrate: true, stopFails: ["new"], running: "false" });
    request({ version: "1.2.0" });
    const result = await runUpdater();
    assert.equal(result.code, 0);
    assert.match(result.stderr, /stopping the server/);
    assert.deepEqual(
      [status().state, status().message],
      ["failed", "the update could not be undone completely: check the updater's log (journalctl -u fastmemo-updater)"]
    );
    // Everything after the failed stop still happened.
    assert.equal(env(), ENV);
    assertDatabaseBack();
    assert.equal(ups().at(-1)?.image, "FASTMEMO_IMAGE=");
    assert.equal(fs.existsSync(marker()), false);
  });

  test("never puts the copy back under a server it couldn't stop", async () => {
    writeConfig({ HEALTH_TIMEOUT: "1" });
    setState({ health: { new: "unhealthy" }, migrate: true, stopFails: ["new"] });
    request({ version: "1.2.0" });
    const result = await runUpdater();
    assert.match(result.stderr, /stopping the server/);
    assert.deepEqual(
      [status().state, status().message],
      [
        "failed",
        "the new version could not be stopped, so it keeps running on its database: check the updater's log (journalctl -u fastmemo-updater)",
      ]
    );
    // A live SQLite would write on through the files it holds open: the database is left to it, with its image.
    assert.equal(read(dirs.data, "fastmemo.db"), "migrated by 1.2.0");
    assert.equal(read(dirs.data, "fastmemo.db-wal"), "wal at 1.2.0");
    assert.equal(env(), `FASTMEMO_ACCESS_KEY=0123456789abcdef\n${PINNED}\nTZ=Europe/Rome\n`);
    assert.ok(calls().some((call) => call.args.includes("{{.State.Running}}")));
    assert.equal(fs.existsSync(marker()), false);
  });

  test("puts the copy back all at once or not at all", { skip: AS_ROOT }, async () => {
    writeConfig({ HEALTH_TIMEOUT: "1" });
    setState({ health: { new: "unhealthy" }, migrate: true, lockBackupWal: true });
    request({ version: "1.2.0" });
    const result = await runUpdater();
    assert.match(result.stderr, /putting the database back/);
    assert.deepEqual(
      [status().state, status().message],
      [
        "failed",
        "the database could not be put back, so the new version was started again: check the updater's log (journalctl -u fastmemo-updater)",
      ]
    );
    // The WAL couldn't be staged, so not even the database file was replaced: the new version's set is whole.
    assert.equal(read(dirs.data, "fastmemo.db"), "migrated by 1.2.0");
    assert.equal(read(dirs.data, "fastmemo.db-wal"), "wal at 1.2.0");
    assert.equal(read(dirs.data, "fastmemo.db-shm"), "shm at 1.2.0");
    assert.deepEqual(
      fs.readdirSync(dirs.data).filter((name) => name.startsWith(".")),
      []
    );
    assert.equal(ups().at(-1)?.image, PINNED);
  });

  test("checks it can write the volume and the .env before stopping anything", { skip: AS_ROOT }, async () => {
    const cases: [string, number, string][] = [
      [dirs.data, 0o555, "the updater can't write the data volume (check its ReadWritePaths), nothing was changed"],
      [dirs.checkout, 0o555, "the updater can't write the checkout's .env (check its ReadWritePaths), nothing was changed"],
      [
        path.join(dirs.checkout, ".env"),
        0o444,
        "the updater can't write the checkout's .env (check its ReadWritePaths), nothing was changed",
      ],
    ];
    for (const [target, mode, message] of cases) {
      const before = fs.statSync(target).mode & 0o777;
      fs.chmodSync(target, mode);
      try {
        request({ version: "1.2.0" });
        await runUpdater();
      } finally {
        fs.chmodSync(target, before);
      }
      assert.deepEqual([status().state, status().message], ["failed", message], target);
    }
    assert.equal(stopped(), false);
    assert.deepEqual(backups(), []);
    assert.equal(fs.existsSync(marker()), false);
    assert.equal(env(), ENV);
  });

  test("never starts the previous image on a database it couldn't put back", async () => {
    writeConfig({ HEALTH_TIMEOUT: "1" });
    setState({ health: { new: "unhealthy" }, migrate: true, loseBackup: true });
    request({ version: "1.2.0" });
    const result = await runUpdater();
    assert.match(result.stderr, /putting the database back/);
    assert.deepEqual(
      [status().state, status().message],
      [
        "failed",
        "the database could not be put back, so the new version was started again: check the updater's log (journalctl -u fastmemo-updater)",
      ]
    );
    // The new version may have migrated it: the previous one would refuse it, so the new one runs on.
    assert.equal(read(dirs.data, "fastmemo.db"), "migrated by 1.2.0");
    assert.equal(env(), `FASTMEMO_ACCESS_KEY=0123456789abcdef\n${PINNED}\nTZ=Europe/Rome\n`);
    assert.equal(ups().at(-1)?.image, PINNED);
  });

  test("fails before stopping anything when there isn't room for the copy", async () => {
    // Sparse: as big as it says for the free-space check, nothing on the disk.
    fs.truncateSync(path.join(dirs.data, "fastmemo.db"), 15 * 1024 ** 4);
    request({ version: "1.2.0" });
    await runUpdater();
    assert.deepEqual(
      [status().state, status().message],
      ["failed", "there is not enough free space to back up the database, nothing was changed"]
    );
    assert.equal(stopped(), false);
    assert.deepEqual(backups(), []);
    assert.equal(env(), ENV);
    assert.equal(fs.existsSync(marker()), false);
  });

  test("on the volume's own disk, wants room for two copies (putting one back makes a second)", async () => {
    // Sparse, and as big as the copy fits once but not twice. A safety net if the check is missing: the stop fails, so
    // nothing gets copied for real.
    const free = fs.statfsSync(dirs.backup);
    fs.truncateSync(path.join(dirs.data, "fastmemo.db"), Math.floor(free.bavail * free.bsize * 0.7));
    assert.equal(fs.statSync(dirs.backup).dev, fs.statSync(dirs.data).dev);
    setState({ stopFails: ["old"] });
    request({ version: "1.2.0" });
    await runUpdater();
    assert.deepEqual(
      [status().state, status().message],
      ["failed", "there is not enough free space to back up the database, nothing was changed"]
    );
    assert.equal(stopped(), false);
    assert.deepEqual(backups(), []);
  });

  test("refuses a database in the volume that is a symlink, without stopping anything", async () => {
    const secret = path.join(root, "secret.db");
    fs.writeFileSync(secret, "not the database");
    for (const name of ["fastmemo.db", "fastmemo.db-wal"]) {
      const file = path.join(dirs.data, name);
      fs.rmSync(file);
      fs.symlinkSync(secret, file);
      request({ version: "1.2.0" });
      await runUpdater();
      assert.deepEqual(
        [status().state, status().message],
        ["refused", "the database in the volume is not a plain file: update it with the commands in the dashboard"],
        name
      );
      fs.rmSync(file);
      fs.writeFileSync(file, "restored by the test");
    }
    assert.equal(stopped(), false);
    assert.deepEqual(backups(), []);
    assert.equal(env(), ENV);
  });

  test("rolls back when it is stopped while waiting for the new version", async () => {
    writeConfig({ HEALTH_TIMEOUT: "60" });
    setState({ health: { new: "starting" }, migrate: true });
    request({ version: "1.2.0" });
    const { done, child } = startUpdater();
    await until(() => calls().some(isHealth));
    assert.ok(calls().some(isHealth));
    child.kill("SIGTERM");
    const result = await done;
    // systemd records the stop, and the journal says what came of it.
    assert.equal(result.code, 143);
    assert.equal(result.stderr, "fastmemo-updater: stopped by a signal, the previous version was put back\n");
    assert.deepEqual(
      [status().state, status().message, status().verified],
      ["rolled_back", "the update was interrupted; the previous version is running again", false]
    );
    assert.equal(env(), ENV);
    assertDatabaseBack();
    assert.equal(ups().at(-1)?.image, "FASTMEMO_IMAGE=");
    assert.equal(fs.existsSync(marker()), false);
  });

  test("a stop asked for during a rollback waits for it to finish", async () => {
    writeConfig({ HEALTH_TIMEOUT: "3" });
    setState({ health: { new: "unhealthy", old: "starting" }, migrate: true });
    request({ version: "1.2.0" });
    const { done, child } = startUpdater();
    await until(() => calls().some((call) => isHealth(call) && call.image === "FASTMEMO_IMAGE="));
    child.kill("SIGTERM");
    const result = await done;
    assert.equal(result.code, 143);
    assert.ok(result.stderr.endsWith("fastmemo-updater: stopped by a signal, the previous version was put back\n"));
    assert.deepEqual(
      [status().state, status().message],
      [
        "rolled_back",
        "the new version did not become healthy; the previous version was started again but is not healthy yet: check the containers",
      ]
    );
    assert.equal(env(), ENV);
    assertDatabaseBack();
    assert.equal(fs.existsSync(marker()), false);
  });

  test("at the next run (boot), undoes a switch it couldn't finish, without a request", async () => {
    // Written with a trailing slash: the marker's folder must still count as one of its copies.
    writeConfig({ BACKUP_DIR: `${dirs.backup}/` });
    const folder = path.join(dirs.backup, "20261022-000000-000000-1.1.0");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "fastmemo.db"), "notes at 1.1.0");
    fs.writeFileSync(path.join(folder, "fastmemo.db-wal"), "wal at 1.1.0");
    fs.writeFileSync(path.join(folder, "image.env"), "FASTMEMO_IMAGE=\n");
    fs.writeFileSync(path.join(dirs.checkout, ".env"), `FASTMEMO_ACCESS_KEY=0123456789abcdef\n${PINNED}\nTZ=Europe/Rome\n`);
    fs.writeFileSync(path.join(dirs.data, "fastmemo.db"), "migrated by 1.2.0");
    fs.writeFileSync(path.join(dirs.data, "fastmemo.db-shm"), "shm at 1.2.0");
    const record = {
      version: "1.2.0",
      current: "1.1.0",
      line: "FASTMEMO_IMAGE=",
      image: PINNED,
      folder,
      data: dirs.data,
      verified: true,
      new_started: true,
    };
    fs.writeFileSync(marker(), JSON.stringify(record));
    assert.equal((await runUpdater()).code, 0);
    assert.deepEqual(
      { ...status(), at: 0 },
      {
        state: "rolled_back",
        version: "1.2.0",
        message: "the update was interrupted; the previous version is running again",
        at: 0,
        verified: true,
      }
    );
    assert.equal(env(), ENV);
    assertDatabaseBack();
    assert.equal(stopped(), true);
    assert.equal(ups().at(-1)?.image, "FASTMEMO_IMAGE=");
    assert.equal(fs.existsSync(marker()), false);
    assert.deepEqual(backups(), ["20261022-000000-000000-1.1.0"]);

    // Stopped before the copy was made: nothing to put back but the server to start again.
    resetCalls();
    fs.writeFileSync(marker(), JSON.stringify({ ...record, folder: null }));
    fs.writeFileSync(path.join(dirs.data, "fastmemo.db"), "notes since");
    await runUpdater();
    assert.equal(status().state, "rolled_back");
    assert.equal(read(dirs.data, "fastmemo.db"), "notes since");
    assert.equal(ups().length, 1);
    assert.equal(fs.existsSync(marker()), false);
  });

  test("goes back to the previous line when the new version never started, even without the copy", async () => {
    // Cut between the .env rewrite and the start of the new version: the database was never migrated.
    const folder = path.join(dirs.backup, "20261022-000000-000000-1.1.0");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(dirs.checkout, ".env"), `FASTMEMO_ACCESS_KEY=0123456789abcdef\n${PINNED}\nTZ=Europe/Rome\n`);
    const record = { version: "1.2.0", current: "1.1.0", line: "FASTMEMO_IMAGE=", image: PINNED, folder, data: dirs.data };
    fs.writeFileSync(marker(), JSON.stringify({ ...record, verified: false, new_started: false }));
    await runUpdater();
    assert.deepEqual(
      [status().state, status().message],
      ["failed", "the update could not be undone completely: check the updater's log (journalctl -u fastmemo-updater)"]
    );
    assert.equal(env(), ENV);
    assert.equal(read(dirs.data, "fastmemo.db"), "notes at 1.1.0");
    assert.equal(ups().at(-1)?.image, "FASTMEMO_IMAGE=");
  });

  test("ignores and removes a switch marker it can't trust", async () => {
    const elsewhere = path.join(root, "20261022-000000-000000-1.1.0");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "fastmemo.db"), "not my notes");
    const record = {
      version: "1.2.0",
      current: "1.1.0",
      line: "FASTMEMO_IMAGE=",
      image: PINNED,
      data: dirs.data,
      verified: false,
      new_started: true,
    };
    for (const bad of [
      "{nope",
      JSON.stringify([]),
      JSON.stringify({ ...record, folder: elsewhere }),
      JSON.stringify({ ...record, folder: null, line: "FASTMEMO_IMAGE=x\nEVIL=1" }),
      JSON.stringify({ ...record, folder: null, data: "relative" }),
      JSON.stringify({ ...record, folder: null, current: "1.1" }),
      JSON.stringify({ ...record, folder: null, verified: 1 }),
      JSON.stringify({ ...record, folder: null, new_started: 1 }),
      JSON.stringify({ ...record, folder: null, new_started: undefined }),
    ]) {
      fs.writeFileSync(marker(), bad);
      assert.equal((await runUpdater()).code, 0);
      assert.equal(fs.existsSync(marker()), false, bad);
    }
    assert.deepEqual(calls(), []);
    assert.equal(read(dirs.data, "fastmemo.db"), "notes at 1.1.0");
    assert.equal(env(), ENV);
  });

  test("keeps the last 3 copies, the new one always among them", async () => {
    // One copy from a clock that ran ahead: by name it is newer than the one made now.
    for (const name of ["20250101-000000-000000-1.0.0", "20250102-000000-000000-1.0.1", "20990101-000000-000000-1.0.2"]) {
      fs.mkdirSync(path.join(dirs.backup, name));
      fs.writeFileSync(path.join(dirs.backup, name, "fastmemo.db"), name);
    }
    fs.mkdirSync(path.join(dirs.backup, "not-a-copy"));
    request({ version: "1.2.0" });
    await runUpdater();
    assert.equal(status().state, "done");
    const left = backups();
    assert.equal(left.length, 3);
    assert.deepEqual(left.slice(0, 1), ["20250102-000000-000000-1.0.1"]);
    assert.ok(left.includes("20990101-000000-000000-1.0.2"));
    assert.ok(left.some((name) => name.endsWith("-1.1.0")));
    assert.equal(fs.existsSync(path.join(dirs.backup, "not-a-copy")), true);
  });
});
