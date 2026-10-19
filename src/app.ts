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

export interface AppOptions {
  config: Pick<Config, "maxDevices" | "maxNoteBytes" | "maxBodyBytes" | "trustProxy">;
  db: Database;
  accessKey: string;
  adminKey: string;
  instance: string;
  version: string;
}

export interface App {
  server: http.Server;
  service: Service;
  hub: Hub;
  stats: Stats;
  limiter: AuthLimiter;
  /** Resolves with the port it listens on (0 picks a free one). */
  listen(port: number, host?: string): Promise<number>;
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
    limiter.fail(req.ip);
    stats.count("authFailures");
    log.warn("wrong key", { ip: req.ip, path: req.path, kind: auth === "admin" ? "admin key" : "access key" });
    throw new HttpError(401, "unauthorized", "Wrong key");
  };

  const server = createHttpServer({
    routes: [
      ...apiRoutes(service, { version: options.version, instance: options.instance }),
      ...adminRoutes({
        service,
        stats,
        db,
        version: options.version,
        instance: options.instance,
        startedAt,
        limits: { maxDevices: config.maxDevices, maxNoteBytes: config.maxNoteBytes, maxBodyBytes: config.maxBodyBytes },
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
    listen: (port, host = "0.0.0.0") =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      }),
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
