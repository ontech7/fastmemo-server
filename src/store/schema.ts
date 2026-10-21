import type { Database } from "./db.ts";

/*
 * Schema migrations, in order. A migration never changes once released: add a new one.
 *
 *   items     notes and categories, one row per id with its latest state (live, deleted, detached). `seq` orders every
 *             change: a device pulls the rows written by others after its cursor. A deleted note's row is its tombstone.
 *   devices   a registered device: its token (hashed), its cursor in the change feed, presence
 *   vault     the vault doc (ADR-012 in the app: wrapped keys only, never a usable key)
 *   counters  the sequence
 *   meta      instance id, schema version
 *   stats     daily counters for the dashboard
 *   events    recent warnings and errors for the dashboard
 */

type Dialect = Database["driver"];

const bigint = (d: Dialect) => (d === "sqlite" ? "INTEGER" : "BIGINT");

const MIGRATIONS: ((d: Dialect) => string[])[] = [
  (d) => [
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value ${bigint(d)} NOT NULL)`,
    `INSERT INTO counters (name, value) VALUES ('seq', 0) ON CONFLICT (name) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS devices (
      uuid TEXT PRIMARY KEY,
      model_name TEXT NOT NULL,
      brand TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      cursor ${bigint(d)} NOT NULL,
      last_sync TEXT NOT NULL,
      presence TEXT,
      full_sync_due ${bigint(d)},
      created_at ${bigint(d)} NOT NULL,
      last_seen ${bigint(d)} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS items (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      state TEXT NOT NULL,
      rev ${bigint(d)} NOT NULL,
      seq ${bigint(d)} NOT NULL,
      author TEXT NOT NULL,
      data TEXT NOT NULL,
      bytes ${bigint(d)} NOT NULL,
      updated_at ${bigint(d)} NOT NULL,
      PRIMARY KEY (kind, key)
    )`,
    `CREATE INDEX IF NOT EXISTS items_seq ON items (seq)`,
    `CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at ${bigint(d)} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS stats (day TEXT NOT NULL, key TEXT NOT NULL, value ${bigint(d)} NOT NULL, PRIMARY KEY (day, key))`,
    `CREATE TABLE IF NOT EXISTS events (
      id ${d === "sqlite" ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "BIGSERIAL PRIMARY KEY"},
      at ${bigint(d)} NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT
    )`,
  ],
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Brings the schema up to date. Refuses a database written by a newer server (downgrade). */
export const migrate = async (db: Database): Promise<void> => {
  await db.write(async (sql) => {
    await sql.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const row = await sql.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`);
    const current = row ? Number(row.value) : 0;
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `The database was written by a newer fastmemo-server (schema ${current}, this one knows ${SCHEMA_VERSION}): update the server`
      );
    }
    for (let version = current; version < SCHEMA_VERSION; version++) {
      for (const statement of MIGRATIONS[version](db.driver)) await sql.run(statement);
    }
    await sql.run(
      `INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [String(SCHEMA_VERSION)]
    );
  });
};
