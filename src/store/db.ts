/*
 * The database as the server sees it: SQL with `?` placeholders, run inside a read or a write transaction. SQLite and
 * Postgres implement it (sqlite.ts, postgres.ts); everything above this layer is written once.
 *
 * Writes are serialized (one at a time, server-wide): every change takes the next sequence number, and a reader must
 * never see seq N committed before N-1, or a device's cursor could skip it.
 */

export type Param = string | number | null;

export interface Sql {
  all<T>(sql: string, params?: Param[]): Promise<T[]>;
  get<T>(sql: string, params?: Param[]): Promise<T | undefined>;
  /** Returns the number of rows changed. */
  run(sql: string, params?: Param[]): Promise<number>;
}

export interface Database {
  readonly driver: "sqlite" | "postgres";
  /** A consistent snapshot. */
  read<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  /** One transaction, serialized with every other write. Rolled back if `fn` throws. */
  write<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  /** Space taken on disk. */
  sizeBytes(): Promise<number>;
  /** A consistent copy of the whole database into `file` (SQLite only). */
  backup(file: string): Promise<void>;
  close(): Promise<void>;
}

/** A queue of async tasks run one at a time. */
export const createMutex = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
};
