import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { createMutex, type Database, type Param, type Sql } from "./db.ts";

/*
 * SQLite through node:sqlite (built into Node: no native module to compile on a Raspberry Pi). One connection; every
 * read and write goes through one queue, so a transaction never interleaves with another.
 */

export const openSqlite = (file: string): Database => {
  const memory = file === ":memory:";
  if (!memory) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

  const db = new DatabaseSync(file);
  if (!memory) db.exec("PRAGMA journal_mode = WAL");
  // FULL: a commit is on disk when the push returns, and the device then drops its copy from the outbox.
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 5000");

  const statements = new Map<string, StatementSync>();
  const prepare = (text: string): StatementSync => {
    let statement = statements.get(text);
    if (!statement) {
      statement = db.prepare(text);
      statements.set(text, statement);
    }
    return statement;
  };

  const sql: Sql = {
    all: async <T>(text: string, params: Param[] = []) => prepare(text).all(...params) as T[],
    get: async <T>(text: string, params: Param[] = []) => prepare(text).get(...params) as T | undefined,
    run: async (text: string, params: Param[] = []) => Number(prepare(text).run(...params).changes),
  };

  const queue = createMutex();
  const transaction = <T>(begin: string, fn: (sql: Sql) => Promise<T>): Promise<T> =>
    queue(async () => {
      db.exec(begin);
      try {
        const result = await fn(sql);
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    });

  return {
    driver: "sqlite",
    read: (fn) => transaction("BEGIN", fn),
    write: (fn) => transaction("BEGIN IMMEDIATE", fn),
    sizeBytes: async () => {
      if (memory) return 0;
      const size = (suffix: string) => {
        try {
          return fs.statSync(file + suffix).size;
        } catch {
          return 0;
        }
      };
      return size("") + size("-wal");
    },
    backup: (target) =>
      queue(async () => {
        fs.rmSync(target, { force: true });
        prepare("VACUUM INTO ?").run(target);
      }),
    close: () =>
      queue(async () => {
        statements.clear();
        db.close();
      }),
  };
};
