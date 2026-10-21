import { createHash, timingSafeEqual } from "node:crypto";

/*
 * Keys are compared by their hashes in constant time, and an address that keeps failing is refused for a while: a key
 * can't be guessed by timing nor by brute force.
 */

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export const sameKey = (given: string | null | undefined, expected: string): boolean =>
  typeof given === "string" && given.length > 0 && timingSafeEqual(digest(given), digest(expected));

/** Failures allowed per address within the window, then refused until the window ends. */
const MAX_FAILURES = 20;
const WINDOW_MS = 15 * 60 * 1000;
/** Failures from every address together within the window: past it, every key attempt is refused (devices keep syncing
 * with their tokens). Many addresses guessing at once is an attack, not someone mistyping. */
const MAX_FAILURES_OVERALL = 500;
/** Addresses tracked at most: past it, only the overall budget counts the others (memory stays bounded). */
const MAX_TRACKED = 10_000;

/** What a limiter counts as one client: an IPv4 address, or an IPv6 /64 (one home or one server gets a whole /64). */
export const addressBucket = (address: string): string => {
  if (!address.includes(":") || /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address)) return address.replace(/^::ffff:/i, "");
  const [head, tail = ""] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
};

/** A failure's place in its window: the first one (worth a log line), the one that got the address refused, or another. */
export type Failure = "first" | "blocked" | "more";

export class AuthLimiter {
  private readonly failures = new Map<string, { count: number; since: number }>();
  private overall = { count: 0, since: 0 };

  /** Whether this address is refused right now. */
  blocked(address: string, now = Date.now()): boolean {
    if (now - this.overall.since <= WINDOW_MS && this.overall.count >= MAX_FAILURES_OVERALL) return true;
    const bucket = addressBucket(address);
    const entry = this.failures.get(bucket);
    if (!entry) return false;
    if (now - entry.since > WINDOW_MS) {
      this.failures.delete(bucket);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  }

  fail(address: string, now = Date.now()): Failure {
    if (now - this.overall.since > WINDOW_MS) this.overall = { count: 0, since: now };
    this.overall.count++;
    const bucket = addressBucket(address);
    const entry = this.failures.get(bucket);
    if (!entry || now - entry.since > WINDOW_MS) {
      if (this.failures.size >= MAX_TRACKED) this.sweep(now);
      if (this.failures.size < MAX_TRACKED) this.failures.set(bucket, { count: 1, since: now });
      return "first";
    }
    entry.count++;
    return entry.count === MAX_FAILURES ? "blocked" : "more";
  }

  /** Drops what's expired (called now and then, so the map can't grow forever). */
  sweep(now = Date.now()): void {
    for (const [bucket, entry] of this.failures) if (now - entry.since > WINDOW_MS) this.failures.delete(bucket);
  }

  /** Addresses tracked now (tests). */
  get tracked(): number {
    return this.failures.size;
  }
}
