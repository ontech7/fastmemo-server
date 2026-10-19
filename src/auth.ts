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

export class AuthLimiter {
  private readonly failures = new Map<string, { count: number; since: number }>();

  /** Whether this address is refused right now. */
  blocked(address: string, now = Date.now()): boolean {
    const entry = this.failures.get(address);
    if (!entry) return false;
    if (now - entry.since > WINDOW_MS) {
      this.failures.delete(address);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  }

  fail(address: string, now = Date.now()): void {
    const entry = this.failures.get(address);
    if (!entry || now - entry.since > WINDOW_MS) this.failures.set(address, { count: 1, since: now });
    else entry.count++;
  }

  /** Drops what's expired (called now and then, so the map can't grow forever). */
  sweep(now = Date.now()): void {
    for (const [address, entry] of this.failures) if (now - entry.since > WINDOW_MS) this.failures.delete(address);
  }
}
