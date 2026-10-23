import type http from "node:http";

import { adminRoutes } from "./admin.ts";
import { AuthLimiter, sameKey } from "./auth.ts";
import type { Config } from "./config.ts";
import { createHttpServer, type Auth, type Request } from "./http.ts";
import { Hub } from "./hub.ts";
import { log } from "./log.ts";
import { HttpError } from "./model.ts";
import { apiRoutes } from "./routes.ts";
import { Service } from "./service.ts";
import { Stats } from "./stats.ts";
import type { Database } from "./store/db.ts";
import type { Updates } from "./updates.ts";

export interface AppOptions {
  config: Pick<Config, "maxDevices" | "maxNoteBytes" | "maxBodyBytes" | "trustProxy">;
  db: Database;
  accessKey: string;
  adminKey: string;
  instance: string;
  version: string;
  updates?: Updates;
}

export interface App {
  server: http.Server;
  service: Service;
  hub: Hub;
  stats: Stats;
  limiter: AuthLimiter;
  /** Resolves with the port it listens on (0 picks a free one). */
  listen(port: number, host?: string): Promise<number>;
  /** Asks every device for a full sync when the updater's last run ended with a rollback not handled yet. */
  checkRollback(): Promise<void>;
  /** Answers the waiting long polls, stops accepting requests, writes what's in memory. */
  close(): Promise<void>;
}

export const createApp = (options: AppOptions): App => {
  const { config, db } = options;
  const hub = new Hub();
  const stats = new Stats();
  const service = new Service(db, hub, stats, { maxDevices: config.maxDevices, maxNoteBytes: config.maxNoteBytes });
  const limiter = new AuthLimiter();
  const startedAt = Date.now();

  const bearerOf = (req: Request) => /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization ?? ""))?.[1];
  const header = (req: Request, name: string) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  /**
   * A device token is checked as is (it can't be guessed); a key attempt counts against the address, which is refused for
   * a while after too many failures (a key is what someone could try to guess).
   */
  const authenticate = async (auth: Auth, req: Request): Promise<string> => {
    if (auth === "none") return "";
    if (auth === "device" || auth === "member") {
      const token = bearerOf(req);
      const device = token ? await service.deviceForToken(token) : null;
      if (device) return device;
      if (auth === "device" || header(req, "x-access-key") === undefined) {
        throw new HttpError(401, "device_unknown", "This device isn't registered on the server (anymore)");
      }
    }
    if (limiter.blocked(req.ip)) throw new HttpError(429, "rate_limited", "Too many failed attempts: try again later");
    const valid =
      auth === "admin" ? sameKey(bearerOf(req), options.adminKey) : sameKey(header(req, "x-access-key"), options.accessKey);
    if (valid) return auth === "admin" ? "admin" : "";
    const failure = limiter.fail(req.ip);
    stats.count("authFailures");
    // One line when an address starts failing and one when it's refused, not one per attempt (a guessing client would fill
    // the logs and the dashboard's events).
    if (failure !== "more") {
      log.warn(failure === "first" ? "wrong key" : "wrong key: address refused for 15 minutes", {
        ip: req.ip,
        path: req.path,
        kind: auth === "admin" ? "admin key" : "access key",
      });
    }
    throw new HttpError(401, "unauthorized", "Wrong key");
  };

  const server = createHttpServer({
    routes: [
      ...apiRoutes(service, {
        version: options.version,
        instance: options.instance,
        update: () => options.updates?.summary() ?? null,
      }),
      ...adminRoutes({
        service,
        stats,
        db,
        version: options.version,
        instance: options.instance,
        startedAt,
        limits: { maxDevices: config.maxDevices, maxNoteBytes: config.maxNoteBytes, maxBodyBytes: config.maxBodyBytes },
        updates: options.updates,
      }),
    ],
    maxBodyBytes: config.maxBodyBytes,
    trustProxy: config.trustProxy,
    stats,
    authenticate,
  });

  return {
    server,
    service,
    hub,
    stats,
    limiter,
    listen: (port, host = "127.0.0.1") =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      }),
    checkRollback: async () => {
      const status = options.updates?.status();
      if (status?.state !== "rolled_back") return;
      if ((await service.fullSyncAfterRollback(status.at)) !== null) {
        log.warn("update rolled back: asked every device for a full sync", { version: status.version });
      }
    },
    close: async () => {
      hub.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        // Long polls were just answered; whatever is still open after a moment is dropped.
        setTimeout(() => server.closeAllConnections(), 2000).unref();
      });
      await service.flush().catch((e) => log.error("flush on shutdown failed", { error: e }));
    },
  };
};
