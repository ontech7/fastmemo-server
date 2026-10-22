import { log } from "./log.ts";

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
        security: hasSecuritySection(notes),
      });
    }
    return releases;
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

  info(): UpdateInfo {
    const releases = this.pending();
    return {
      enabled: this.options.enabled,
      current: this.options.current,
      latest: releases[0]?.version ?? null,
      security: releases.some((release) => release.security),
      releases,
      checkedAt: this.checkedAt,
      error: this.error,
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
