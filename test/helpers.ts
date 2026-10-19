import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp, type App } from "../src/app.ts";
import { silenceLogs } from "../src/log.ts";
import type { Database } from "../src/store/db.ts";
import { openPostgres } from "../src/store/postgres.ts";
import { migrate } from "../src/store/schema.ts";
import { openSqlite } from "../src/store/sqlite.ts";

/*
 * Starts a server on a free port over a fresh database: SQLite in a temp file, or the Postgres at TEST_DATABASE_URL
 * (wiped first). Every test file runs against both when TEST_DATABASE_URL is set (npm run test:pg).
 */

silenceLogs(true);

export const ACCESS_KEY = "test-access-key-0123456789";
export const ADMIN_KEY = "test-admin-key-0123456789";

export const PG_URL = process.env.TEST_DATABASE_URL;

export interface Limits {
  maxDevices?: number;
  maxNoteBytes?: number;
  maxBodyBytes?: number;
}

export const openTestDb = async (file?: string): Promise<Database> => {
  if (PG_URL) {
    const db = await openPostgres(PG_URL);
    if (!file) {
      await db.write((sql) => sql.run(`DROP TABLE IF EXISTS meta, counters, devices, items, vault, stats, events CASCADE`));
    }
    return db;
  }
  return openSqlite(file ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fastmemo-test-")), "test.db"));
};

export interface Reply<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface TestServer {
  app: App;
  db: Database;
  base: string;
  call<T = any>(
    method: string,
    path: string,
    options?: { body?: unknown; token?: string; key?: string | null; admin?: string; headers?: Record<string, string> }
  ): Promise<Reply<T>>;
  /** Registers a device and returns its token. */
  register(uuid: string): Promise<string>;
  close(): Promise<void>;
}

export const startServer = async (limits: Limits = {}, db?: Database): Promise<TestServer> => {
  db ??= await openTestDb();
  await migrate(db);
  const app = createApp({
    config: {
      maxDevices: limits.maxDevices ?? 5,
      maxNoteBytes: limits.maxNoteBytes ?? 1024 * 1024,
      maxBodyBytes: limits.maxBodyBytes ?? 8 * 1024 * 1024,
      trustProxy: false,
    },
    db,
    accessKey: ACCESS_KEY,
    adminKey: ADMIN_KEY,
    instance: "test-instance",
    version: "test",
  });
  const port = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;

  const call: TestServer["call"] = async (method, url, options = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.admin) headers.Authorization = `Bearer ${options.admin}`;
    if (options.key !== undefined && options.key !== null) headers["X-Access-Key"] = options.key;
    let body: string | undefined;
    if (options.body !== undefined) {
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(base + url, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as any, headers: res.headers };
  };

  return {
    app,
    db,
    base,
    call,
    register: async (uuid) => {
      const res = await call("POST", "/v1/devices", {
        key: ACCESS_KEY,
        body: { uuid, modelName: `model-${uuid}`, brand: "test" },
      });
      if (res.status !== 201) throw new Error(`register ${uuid}: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.token;
    },
    close: async () => {
      await app.close();
      await db!.close();
    },
  };
};

export const note = (id: string, rev: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "text",
  title: id,
  text: `sealed:${id}@${rev}`,
  updatedAt: rev,
  rev,
  ...extra,
});

export const stub = (id: string, rev: number) => ({ id, type: "text", rev, updatedAt: rev });

export const ops = (
  parts: {
    add?: object[];
    delete?: object[];
    detach?: object[];
    categories?: object[];
    deleteCategories?: object[];
    bases?: Record<string, number>;
  } = {}
) => ({
  notes: { add: parts.add ?? [], delete: parts.delete ?? [], detach: parts.detach ?? [] },
  categories: { add: parts.categories ?? [], delete: parts.deleteCategories ?? [] },
  bases: parts.bases ?? {},
});

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
