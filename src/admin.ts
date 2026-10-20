import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Route } from "./http.ts";
import { HttpError } from "./model.ts";
import type { Service } from "./service.ts";
import { dayOf, type Stats } from "./stats.ts";
import type { Database } from "./store/db.ts";

/*
 * The dashboard: a static page (public/) and the API it reads, under /admin with the admin key. What the server sees and
 * does: devices, space, operations per day, recent warnings and errors. It can't read a note: they're encrypted.
 */

export interface AdminContext {
  service: Service;
  stats: Stats;
  db: Database;
  version: string;
  instance: string;
  startedAt: number;
  limits: { maxDevices: number; maxNoteBytes: number; maxBodyBytes: number };
}

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

/** The page may only load its own files, and can't be framed. */
const PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-cache",
};

/** The dashboard's files, read once at start (only these can be served: no path from the URL reaches the disk). */
const loadAssets = (): Map<string, { body: Buffer; type: string }> => {
  const assets = new Map<string, { body: Buffer; type: string }>();
  if (!fs.existsSync(PUBLIC_DIR)) return assets;
  for (const name of fs.readdirSync(PUBLIC_DIR)) {
    const type = TYPES[path.extname(name)];
    if (type) assets.set(name, { body: fs.readFileSync(path.join(PUBLIC_DIR, name)), type });
  }
  return assets;
};

export const adminRoutes = (ctx: AdminContext): Route[] => {
  const assets = loadAssets();
  const page = (name: string) => {
    const asset = assets.get(name);
    if (!asset) throw new HttpError(404, "not_found");
    return { body: asset.body, type: asset.type, headers: PAGE_HEADERS };
  };

  return [
    { method: "GET", pattern: /^\/$/, auth: "none", handler: async () => page("index.html") },
    { method: "GET", pattern: /^\/assets\/([\w.-]+)$/, auth: "none", handler: async (req) => page(req.params[0]) },
    {
      method: "GET",
      pattern: /^\/admin\/api\/overview$/,
      auth: "admin",
      handler: async () => {
        const overview = await ctx.service.overview();
        return {
          json: {
            server: {
              version: ctx.version,
              instance: ctx.instance,
              startedAt: ctx.startedAt,
              node: process.version,
              platform: `${os.platform()} ${os.arch()}`,
              memoryBytes: process.memoryUsage().rss,
              database: { driver: ctx.db.driver, bytes: await ctx.db.sizeBytes() },
              limits: ctx.limits,
            },
            ...overview,
            history: await ctx.stats.history(ctx.db, 30),
            events: await ctx.service.recentEvents(100),
          },
        };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/admin\/api\/devices\/([^/]+)$/,
      auth: "admin",
      handler: async (req) => {
        if (!(await ctx.service.unregister(req.params[0]))) throw new HttpError(404, "not_found");
        return { status: 204 };
      },
    },
    {
      method: "POST",
      pattern: /^\/admin\/api\/devices\/([^/]+)\/full-sync$/,
      auth: "admin",
      handler: async (req) => {
        if ((await ctx.service.requestFullSync(req.params[0])) === 0) throw new HttpError(404, "not_found");
        return { status: 204 };
      },
    },
    {
      method: "POST",
      pattern: /^\/admin\/api\/full-sync$/,
      auth: "admin",
      handler: async () => ({ json: { devices: await ctx.service.requestFullSync() } }),
    },
    {
      method: "GET",
      pattern: /^\/admin\/api\/backup$/,
      auth: "admin",
      handler: async () => {
        if (ctx.db.driver !== "sqlite") {
          throw new HttpError(400, "not_supported", "Back up a Postgres database with pg_dump");
        }
        const file = path.join(os.tmpdir(), `fastmemo-backup-${process.pid}-${Date.now()}.db`);
        try {
          await ctx.db.backup(file);
          const body = fs.readFileSync(file);
          const now = new Date();
          const stamp = `${dayOf(now.getTime()).replace(/-/g, "")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
          return {
            body,
            type: "application/octet-stream",
            headers: { "Content-Disposition": `attachment; filename="fastmemo-${stamp}.db"` },
          };
        } finally {
          fs.rmSync(file, { force: true });
        }
      },
    },
  ];
};
