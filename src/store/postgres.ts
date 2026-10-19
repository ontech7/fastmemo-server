import type { PoolClient } from "pg";

import { createMutex, type Database, type Param, type Sql } from "./db.ts";

/*
 * PostgreSQL through `pg` (loaded only when DATABASE_URL points to Postgres). Reads are REPEATABLE READ snapshots; writes
 * take a transaction-wide advisory lock, so they're serialized like on SQLite even with several server processes.
 */

/** Any constant: the advisory lock every write takes. */
const WRITE_LOCK = 7_316_221;

/** `?` placeholders (the SQL above this layer) to Postgres' `$1, $2, ...`. No query here has a `?` inside a literal. */
const numbered = (text: string): string => {
  let n = 0;
  return text.replace(/\?/g, () => `$${++n}`);
};

export const openPostgres = async (url: string): Promise<Database> => {
  const { default: pg } = await import("pg");
  // BIGINT columns hold sequence numbers and millisecond timestamps, far below 2^53: plain numbers.
  pg.types.setTypeParser(20, (value: string) => Number(value));
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on("error", () => {}); // an idle client dropped by the server: the pool replaces it

  const sqlOf = (client: PoolClient): Sql => ({
    all: async <T>(text: string, params: Param[] = []) => (await client.query(numbered(text), params)).rows as T[],
    get: async <T>(text: string, params: Param[] = []) => (await client.query(numbered(text), params)).rows[0] as T | undefined,
    run: async (text: string, params: Param[] = []) => (await client.query(numbered(text), params)).rowCount ?? 0,
  });

  const transaction = async <T>(begin: string, lock: boolean, fn: (sql: Sql) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query(begin);
      if (lock) await client.query("SELECT pg_advisory_xact_lock($1)", [WRITE_LOCK]);
      const result = await fn(sqlOf(client));
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };

  // Writes from this process also queue here, so they don't hold a pool connection each while waiting for the lock.
  const writes = createMutex();

  return {
    driver: "postgres",
    read: (fn) => transaction("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", false, fn),
    write: (fn) => writes(() => transaction("BEGIN", true, fn)),
    sizeBytes: async () => {
      const { rows } = await pool.query("SELECT pg_database_size(current_database()) AS size");
      return Number(rows[0]?.size ?? 0);
    },
    backup: async () => {
      throw new Error("Back up a Postgres database with pg_dump");
    },
    close: () => pool.end(),
  };
};
