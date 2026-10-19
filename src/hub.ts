import { randomBytes } from "node:crypto";

/*
 * Live updates by long polling: a device asks for the state after the version it has, and the request waits until
 * something changes (any committed write bumps the version) or a timeout. Plain HTTP: it works through any reverse proxy
 * and needs no WebSocket library on either side.
 */

export class Hub {
  /** Changes on every start: a version from before a restart never matches. */
  private readonly boot = randomBytes(4).toString("hex");
  private counter = 0;
  private waiters = new Set<() => void>();
  private closed = false;

  version(): string {
    return `${this.boot}.${this.counter}`;
  }

  /** Something devices can see changed: wake everyone waiting. */
  bump(): void {
    this.counter++;
    this.release();
  }

  /** Resolves once the version isn't `version` anymore, after `ms`, or when `signal` aborts. */
  wait(version: string, ms: number, signal?: AbortSignal): Promise<void> {
    if (this.closed || version !== this.version() || ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
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
