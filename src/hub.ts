import { randomBytes } from "node:crypto";

/*
 * Live updates by long polling: a device asks for the state after the version it has, and the request waits until
 * something changes (any committed write bumps the version) or a timeout. Plain HTTP: it works through any reverse proxy
 * and needs no WebSocket library on either side.
 */

/** Long polls one device may hold at once. */
export const MAX_WAITS_PER_DEVICE = 4;

export class Hub {
  /** Changes on every start: a version (or a feed page) from before a restart never matches. */
  readonly boot = randomBytes(4).toString("hex");
  private counter = 0;
  private waiters = new Set<() => void>();
  /** Each device's long polls, oldest first: a device past MAX_WAITS_PER_DEVICE has its oldest answered. */
  private readonly byDevice = new Map<string, (() => void)[]>();
  private closed = false;

  version(): string {
    return `${this.boot}.${this.counter}`;
  }

  /** Something devices can see changed: wake everyone waiting. */
  bump(): void {
    this.counter++;
    this.release();
  }

  /**
   * Resolves once the version isn't `version` anymore, after `ms`, or when `signal` aborts. `device`: whose long poll it is (an
   * app has one at a time; a few more are let through, then the oldest is answered, so no device can hold the server's
   * connections).
   */
  wait(version: string, ms: number, signal?: AbortSignal, device?: string): Promise<void> {
    if (this.closed || version !== this.version() || ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        if (device !== undefined) {
          const mine = this.byDevice.get(device)?.filter((waiter) => waiter !== done) ?? [];
          if (mine.length > 0) this.byDevice.set(device, mine);
          else this.byDevice.delete(device);
        }
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
      if (device !== undefined) {
        const mine = [...(this.byDevice.get(device) ?? []), done];
        this.byDevice.set(device, mine);
        if (mine.length > MAX_WAITS_PER_DEVICE) mine[0]();
      }
    });
  }

  get waiting(): number {
    return this.waiters.size;
  }

  /** Shutting down: answer everyone now. */
  close(): void {
    this.closed = true;
    this.release();
  }

  private release(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    waiters.forEach((done) => done());
  }
}
