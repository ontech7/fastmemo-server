import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { log } from "./log.ts";
import { HttpError } from "./model.ts";

/*
 * The release check: asks GitHub which versions exist, and tells the dashboard (and /v1/info) when a newer one is out and
 * whether it fixes a security problem. Nothing but a plain request for the release list leaves the server. It only
 * reports: installing is the updater's job on the host.
 */

/** Strict versions only: anything else (a source build, a release candidate) is never an update. */
export const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

const CHECK_EVERY = 6 * 60 * 60 * 1000;
const FIRST_CHECK_AFTER = 30 * 1000;
const FETCH_TIMEOUT = 10_000;
const MAX_RELEASES = 30;
const MAX_NOTES = 8000;
const MAX_ERROR = 200;
const MAX_STATUS_BYTES = 4096;
/** An updater killed mid-way never writes a final state: past this it is not coming back. */
const STALE_STATUS = 60 * 60 * 1000;
/** A status from further ahead than this is a clock gone wrong: it must not block installs for good. */
const MAX_CLOCK_SKEW = 5 * 60 * 1000;
const MAX_MESSAGE = 500;

/** Both versions must be strict. Returns -1, 0 or 1. */
export const compareVersions = (a: string, b: string): number => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
};

/** A changelog heading line "## Security" or "### Security" (nothing after it, no deeper level). */
export const hasSecuritySection = (notes: string): boolean => /^#{2,3}[ \t]+Security[ \t]*$/m.test(notes);

export interface Release {
  version: string;
  notes: string;
  url: string;
  publishedAt: string | null;
  /** The notes have a Security section. */
  security: boolean;
}

/** The published, final releases with a strict version, in any order. */
export type FetchReleases = () => Promise<Release[]>;

export const githubReleases = (repo: string, userAgent: string, api = "https://api.github.com"): FetchReleases => {
  return async () => {
    const response = await fetch(`${api}/repos/${repo}/releases?per_page=${MAX_RELEASES}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": userAgent, "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const list: unknown = await response.json();
    if (!Array.isArray(list)) throw new Error("GitHub answered something that is not a release list");

    const releases: Release[] = [];
    for (const item of list.slice(0, MAX_RELEASES)) {
      if (typeof item !== "object" || item === null) continue;
      const { tag_name, draft, prerelease, body, html_url, published_at } = item as Record<string, unknown>;
      if (typeof tag_name !== "string" || draft !== false || prerelease !== false) continue;
      const version = tag_name.replace(/^v/, "");
      if (!VERSION.test(version)) continue;
      // The Security section is looked for in the whole body: Keep a Changelog puts it last, past the cap.
      const notes = typeof body === "string" ? body.slice(0, MAX_NOTES) : "";
      // A link to anywhere but the project's releases is never passed on.
      const url =
        typeof html_url === "string" && html_url.startsWith(`https://github.com/${repo}/`)
          ? html_url
          : `https://github.com/${repo}/releases`;
      releases.push({
        version,
        notes,
        url,
        publishedAt: typeof published_at === "string" ? published_at : null,
        security: typeof body === "string" && hasSecuritySection(body),
      });
    }
    return releases;
  };
};

/** What the host updater writes to status.json (Tasks 7-8 write exactly these). `refused` is a policy refusal, final. */
export const UPDATE_STATES = [
  "queued",
  "checking",
  "downloading",
  "verifying",
  "backing_up",
  "restarting",
  "done",
  "failed",
  "rolled_back",
  "refused",
] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];
export const FINAL_STATES: readonly UpdateState[] = ["done", "failed", "rolled_back", "refused"];

export interface UpdateStatus {
  state: UpdateState;
  version: string;
  message: string | null;
  /** Milliseconds. */
  at: number;
  /** Whether the image's provenance was verified; null when it wasn't looked at. */
  verified: boolean | null;
}

const isDirectory = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/** The status file's content if it is what the updater writes, else null (the file is not ours to trust). */
const parseStatus = (value: unknown): UpdateStatus | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { state, version, message, at, verified } = value as Record<string, unknown>;
  if (!UPDATE_STATES.includes(state as UpdateState)) return null;
  if (typeof version !== "string" || !VERSION.test(version)) return null;
  if (message !== undefined && message !== null && typeof message !== "string") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (verified !== undefined && verified !== null && typeof verified !== "boolean") return null;
  return {
    state: state as UpdateState,
    version,
    message: message?.slice(0, MAX_MESSAGE) ?? null,
    at,
    verified: verified ?? null,
  };
};

export interface UpdateSummary {
  latest: string;
  security: boolean;
  url: string;
}

export interface UpdateInfo {
  enabled: boolean;
  current: string;
  latest: string | null;
  security: boolean;
  /** Newer than the running version, newest first. */
  releases: Release[];
  checkedAt: number | null;
  error: string | null;
  /** Both directories are set and exist, and the database is SQLite: the updater can be asked. */
  installable: boolean;
  /** The latest release has the running version's major: only those are installed with a click. */
  sameMajor: boolean;
  status: UpdateStatus | null;
}

export interface UpdatesOptions {
  current: string;
  fetchReleases: FetchReleases;
  enabled: boolean;
  /** Where an install request is left for the updater, and where it reports. Null: no updater. */
  requestDir: string | null;
  statusDir: string | null;
  sqlite: boolean;
  now?: () => number;
}

export class Updates {
  private readonly options: UpdatesOptions;
  private readonly now: () => number;
  private releases: Release[] = [];
  private checkedAt: number | null = null;
  private error: string | null = null;
  private checking: Promise<void> | null = null;
  /** Versions already announced in the log, so a recheck every 6 h stays quiet. */
  private readonly announced = new Set<string>();
  private first: NodeJS.Timeout | null = null;
  private every: NodeJS.Timeout | null = null;

  constructor(options: UpdatesOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Milliseconds since a time from `info().checkedAt`, by the same clock. */
  elapsedSince(time: number): number {
    return this.now() - time;
  }

  /** Never rejects. Callers that arrive while a check runs share it. */
  check(): Promise<void> {
    if (!this.options.enabled) return Promise.resolve();
    this.checking ??= this.run().finally(() => {
      this.checkedAt = this.now();
      this.checking = null;
    });
    return this.checking;
  }

  /** Checks in the background when the last check is old: the dashboard calls it on every view. */
  maybeCheck(): void {
    if (this.options.enabled && (this.checkedAt === null || this.now() - this.checkedAt > CHECK_EVERY)) void this.check();
  }

  /** The first check after 30 s (not at boot: the host may have no network yet), then every 6 h. */
  start(): void {
    this.stop();
    if (!this.options.enabled) return;
    this.first = setTimeout(() => {
      void this.check();
      this.every = setInterval(() => void this.check(), CHECK_EVERY);
      this.every.unref();
    }, FIRST_CHECK_AFTER);
    this.first.unref();
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.every) clearInterval(this.every);
    this.first = this.every = null;
  }

  /** Newer than the running version, newest first. Empty unless the running version is a plain x.y.z. */
  pending(): Release[] {
    const { enabled, current } = this.options;
    if (!enabled || !VERSION.test(current)) return [];
    return this.releases
      .filter((release) => VERSION.test(release.version) && compareVersions(release.version, current) > 0)
      .sort((a, b) => compareVersions(b.version, a.version));
  }

  summary(): UpdateSummary | null {
    const pending = this.pending();
    const latest = pending[0];
    if (!latest) return null;
    return { latest: latest.version, security: pending.some((release) => release.security), url: latest.url };
  }

  get installable(): boolean {
    const { requestDir, statusDir, sqlite } = this.options;
    return sqlite && !!requestDir && !!statusDir && isDirectory(requestDir) && isDirectory(statusDir);
  }

  /** The updater's progress, or null when there is none or the file isn't what the updater writes. */
  status(): UpdateStatus | null {
    const { statusDir } = this.options;
    if (!statusDir) return null;
    try {
      // The directory is the updater's; a symlink there could point anywhere, and a FIFO would hang the open.
      const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
      const fd = fs.openSync(path.join(statusDir, "status.json"), flags);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_STATUS_BYTES) return null;
        const status = parseStatus(JSON.parse(fs.readFileSync(fd, "utf8")));
        const age = status ? this.now() - status.at : 0;
        if (status && !FINAL_STATES.includes(status.state) && (age > STALE_STATUS || age < -MAX_CLOCK_SKEW)) {
          return { ...status, state: "failed", message: "the updater stopped without finishing: check its log" };
        }
        return status;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  /** Asks the updater on the host for the latest release. It re-checks everything; this only says which one is wanted. */
  requestInstall(version: string): void {
    if (!this.installable) throw new HttpError(501, "not_installable", "This setup can't be updated from the dashboard");
    const latest = this.pending()[0];
    if (typeof version !== "string" || !VERSION.test(version) || latest?.version !== version) {
      throw new HttpError(409, "not_available", "That version isn't the latest release");
    }
    if (!this.sameMajor(version)) throw new HttpError(409, "new_major", "A new major version is updated by hand");
    const status = this.status();
    if (status && !FINAL_STATES.includes(status.state)) {
      throw new HttpError(409, "in_progress", "An update is already running");
    }

    const { requestDir } = this.options;
    // The updater removes request.json when it picks it up: while it is there, the same install is already queued.
    if (fs.existsSync(path.join(requestDir!, "request.json"))) {
      throw new HttpError(409, "in_progress", "An update is already waiting for the updater");
    }
    const temporary = path.join(requestDir!, `.request-${crypto.randomBytes(8).toString("hex")}`);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version, requestedAt: this.now() }), { flag: "wx", mode: 0o640 });
      fs.renameSync(temporary, path.join(requestDir!, "request.json"));
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      log.error("could not leave the update request", { error });
      throw new HttpError(500, "server_error", "Could not leave the request for the updater");
    }
  }

  private sameMajor(version: string | null): boolean {
    return (
      version !== null && VERSION.test(this.options.current) && version.split(".")[0] === this.options.current.split(".")[0]
    );
  }

  info(): UpdateInfo {
    const releases = this.pending();
    const latest = releases[0]?.version ?? null;
    return {
      enabled: this.options.enabled,
      current: this.options.current,
      latest,
      security: releases.some((release) => release.security),
      releases,
      checkedAt: this.checkedAt,
      error: this.error,
      installable: this.installable,
      sameMajor: this.sameMajor(latest),
      status: this.status(),
    };
  }

  private async run(): Promise<void> {
    try {
      this.releases = await this.options.fetchReleases();
      this.error = null;
    } catch (error) {
      // Keep the last good answer; the dashboard shows what went wrong.
      this.error = (error instanceof Error ? error.message : "the check failed").slice(0, MAX_ERROR);
      log.debug("update check failed", { error: this.error });
      return;
    }
    const summary = this.summary();
    if (!summary || this.announced.has(summary.latest)) return;
    this.announced.add(summary.latest);
    const detail = { version: summary.latest, url: summary.url };
    if (summary.security) log.error("security update available", detail);
    else log.warn("update available", detail);
  }
}
