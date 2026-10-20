import { randomBytes, randomUUID } from "node:crypto";
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

/** The instance id (new database: new id), and the access key generated when none is configured. */
const prepare = async (db: Database, generateKey: boolean): Promise<{ instance: string; generatedKey: string | null }> =>
  db.write(async (sql) => {
    const read = async (key: string) =>
      (await sql.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key]))?.value;
    const store = (key: string, value: string) => sql.run(`INSERT INTO meta (key, value) VALUES (?, ?)`, [key, value]);

    let instance = await read("instance_id");
    if (!instance) {
      instance = randomUUID();
      await store("instance_id", instance);
    }
    let generatedKey: string | null = null;
    if (generateKey) {
      generatedKey = (await read("access_key")) ?? null;
      if (!generatedKey) {
        generatedKey = randomBytes(24).toString("base64url");
        await store("access_key", generatedKey);
      }
    }
    return { instance, generatedKey };
  });

const main = async () => {
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
  const { instance, generatedKey } = await prepare(db, config.accessKey === null);
  const accessKey = config.accessKey ?? generatedKey!;

  const app = createApp({ config, db, accessKey, adminKey: config.adminKey ?? accessKey, instance, version });
  onRecord((record) => app.service.recordEvent(record));
  const port = await app.listen(config.port, config.host);

  log.info("fastmemo-server started", {
    version,
    port,
    database: config.database.driver === "sqlite" ? `sqlite ${config.database.path}` : "postgres",
    instance,
  });
  if (!config.accessKey) {
    // Printed, not logged: it isn't kept with the events.
    console.log(
      [
        "",
        "  No FASTMEMO_ACCESS_KEY is set: this server generated one (it stays the same across restarts).",
        "  Enter it in the app (Settings > Cloud Sync > FastMemo Server) to connect a device, and to open the dashboard",
        "  (this server's address in a browser):",
        "",
        `      ${accessKey}`,
        "",
        "  To choose your own, set FASTMEMO_ACCESS_KEY (16+ characters) and restart.",
        "",
      ].join("\n")
    );
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
