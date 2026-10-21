import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { createApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { log, onRecord, setLogLevel } from "./log.ts";
import type { Database } from "./store/db.ts";
import { openPostgres } from "./store/postgres.ts";
import { migrate } from "./store/schema.ts";
import { openSqlite } from "./store/sqlite.ts";

const FLUSH_MS = 10_000;
const MAINTENANCE_MS = 60 * 60 * 1000;

const version: string = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** The instance id (new database: new id). */
const prepare = async (db: Database): Promise<string> =>
  db.write(async (sql) => {
    // Servers before 1.0.0 generated an access key when none was set and kept it here, where backups have it in clear.
    await sql.run(`DELETE FROM meta WHERE key = 'access_key'`);

    const row = await sql.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'instance_id'`);
    if (row) return row.value;
    const instance = randomUUID();
    await sql.run(`INSERT INTO meta (key, value) VALUES ('instance_id', ?)`, [instance]);
    return instance;
  });

const main = async () => {
  // Files this server writes (the database, a backup on its way out) are readable by its own user only.
  process.umask(0o077);
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`Configuration error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  setLogLevel(config.logLevel);

  const db = config.database.driver === "sqlite" ? openSqlite(config.database.path) : await openPostgres(config.database.url);
  await migrate(db);
  const instance = await prepare(db);

  const app = createApp({
    config,
    db,
    accessKey: config.accessKey,
    adminKey: config.adminKey ?? config.accessKey,
    instance,
    version,
  });
  onRecord((record) => app.service.recordEvent(record));
  const port = await app.listen(config.port, config.host);

  log.info("fastmemo-server started", {
    version,
    port,
    database: config.database.driver === "sqlite" ? `sqlite ${config.database.path}` : "postgres",
    instance,
  });
  if (!config.adminKey) {
    log.warn("FASTMEMO_ADMIN_KEY is not set: the access key, which every device holds, also opens the dashboard");
  }

  const flush = setInterval(() => app.service.flush().catch((e) => log.error("flush failed", { error: e })), FLUSH_MS);
  const maintain = () => app.service.maintenance().catch((e) => log.error("maintenance failed", { error: e }));
  const maintenance = setInterval(maintain, MAINTENANCE_MS);
  const firstMaintenance = setTimeout(maintain, 60_000);
  const sweep = setInterval(() => app.limiter.sweep(), 5 * 60_000);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    setTimeout(() => process.exit(1), 10_000).unref();
    [flush, maintenance, sweep].forEach(clearInterval);
    clearTimeout(firstMaintenance);
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
};

main().catch((e) => {
  log.error("fastmemo-server failed to start", { error: e });
  process.exit(1);
});
