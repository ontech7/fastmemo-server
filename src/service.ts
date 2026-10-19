import { createHash, randomBytes } from "node:crypto";

import type { Hub } from "./hub.ts";
import type { LogRecord } from "./log.ts";
import { log } from "./log.ts";
import {
  HttpError,
  isKey,
  isObject,
  noteRev,
  type Change,
  type DeviceView,
  type ItemKind,
  type ItemState,
  type Json,
  type Presence,
  type PushBody,
  type PushResult,
  type Snapshot,
  type VaultRead,
} from "./model.ts";
import type { Stats } from "./stats.ts";
import type { Database, Param, Sql } from "./store/db.ts";

/*
 * What the API does, on top of the database. The sync model (the app's ADR-016, served differently than on Firestore):
 *
 *  - Every note and category has one row with its latest state; every write gives it the next sequence number.
 *  - Each device has a cursor: the changes other devices wrote after it are its incoming changes (the feed), served a
 *    page at a time. Acknowledging a page moves the cursor. No per-sender queues: nothing to overflow, and a device that
 *    was offline for months just reads more pages.
 *  - A push applies uploads and deletions only over older versions (the same guard as the Firestore adapter), and returns
 *    the newer ones it refused, for the device to merge first.
 */

interface DeviceRow {
  uuid: string;
  model_name: string;
  brand: string;
  token_hash: string;
  cursor: number;
  last_sync: string;
  presence: string | null;
  full_sync_due: number | null;
  created_at: number;
  last_seen: number;
}

interface ItemRow {
  kind: ItemKind;
  key: string;
  state: ItemState;
  rev: number;
  seq: number;
  author: string;
  data: string;
}

export interface Limits {
  maxDevices: number;
  maxNoteBytes: number;
}

export interface DeviceInfo {
  uuid: string;
  modelName: string;
  brand: string;
}

/** A page of the feed is cut at whichever comes first. */
const PAGE_ROWS = 500;
const PAGE_BYTES = 2 * 1024 * 1024;
const MAX_VAULT_BYTES = 256 * 1024;
const MAX_PRESENCE_BYTES = 1024;
/** A deleted category's row is dropped once every device has it, after this long. */
const CATEGORY_TOMBSTONE_TTL_MS = 30 * 86_400_000;
/** The app forgets a deleted note's id after 180 days (TOMBSTONE_TTL_MS): the server keeps it a little longer. */
const NOTE_TOMBSTONE_TTL_MS = 200 * 86_400_000;
const EVENTS_KEPT = 1000;
const STATS_KEPT_DAYS = 400;

export const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

const queueOf = (kind: ItemKind, state: ItemState): string =>
  kind === "note"
    ? state === "live"
      ? "addNotes"
      : state === "deleted"
        ? "deleteNotes"
        : "detachNotes"
    : state === "live"
      ? "addCategories"
      : "deleteCategories";

const parsePresence = (raw: string | null): Presence | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return isObject(value) && typeof value.at === "number"
      ? { noteId: typeof value.noteId === "string" ? value.noteId : null, at: value.at }
      : null;
  } catch {
    return null;
  }
};

/** Runs `fn` over `items` in slices (a statement takes a limited number of parameters). */
const inChunks = async <T>(items: T[], size: number, fn: (chunk: T[]) => Promise<unknown>): Promise<void> => {
  for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size));
};

export class Service {
  private readonly db: Database;
  private readonly hub: Hub;
  private readonly stats: Stats;
  private readonly limits: Limits;

  /** Token hash -> device uuid (dropped when the device is removed or registers again). */
  private readonly tokens = new Map<string, string>();
  /** Last request per device, written with the stats. */
  private readonly seen = new Map<string, number>();
  private events: LogRecord[] = [];
  /** The device list as of a hub version (every device's snapshot carries it). */
  private viewCache: { version: string; devices: DeviceView[] } | null = null;

  constructor(db: Database, hub: Hub, stats: Stats, limits: Limits) {
    this.db = db;
    this.hub = hub;
    this.stats = stats;
    this.limits = limits;
  }

  get maxDevices(): number {
    return this.limits.maxDevices;
  }

  /** A committed change devices can see: wake the long polls. */
  private changed(): void {
    this.viewCache = null;
    this.hub.bump();
  }

  // --- Devices ---

  /** The device a token belongs to, or null. */
  async deviceForToken(token: string): Promise<string | null> {
    const hash = hashToken(token);
    let uuid = this.tokens.get(hash) ?? null;
    if (!uuid) {
      const row = await this.db.read((sql) =>
        sql.get<{ uuid: string }>(`SELECT uuid FROM devices WHERE token_hash = ?`, [hash])
      );
      if (!row) return null;
      uuid = row.uuid;
      this.tokens.set(hash, uuid);
    }
    this.seen.set(uuid, Date.now());
    return uuid;
  }

  private forgetTokens(uuid: string): void {
    for (const [hash, owner] of this.tokens) if (owner === uuid) this.tokens.delete(hash);
  }

  /**
   * Registers a device (again: a new token, and the old one stops working). Its cursor starts at the current change: what
   * came before reaches it through the full sync the app runs on connect.
   */
  async register(info: DeviceInfo): Promise<{ token: string }> {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    await this.db.write(async (sql) => {
      const others = await sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM devices WHERE uuid <> ?`, [info.uuid]);
      if (Number(others?.n ?? 0) >= this.limits.maxDevices) {
        throw new HttpError(403, "device_limit", `This server allows ${this.limits.maxDevices} devices`);
      }
      const cursor = await currentSeq(sql);
      await sql.run(
        `INSERT INTO devices (uuid, model_name, brand, token_hash, cursor, last_sync, presence, full_sync_due, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
         ON CONFLICT (uuid) DO UPDATE SET model_name = excluded.model_name, brand = excluded.brand,
           token_hash = excluded.token_hash, cursor = excluded.cursor, last_sync = excluded.last_sync, presence = NULL,
           full_sync_due = NULL, last_seen = excluded.last_seen`,
        [info.uuid, info.modelName, info.brand, hashToken(token), cursor, String(now), now, now]
      );
    });
    this.forgetTokens(info.uuid);
    this.stats.count("writes");
    this.changed();
    log.info("device registered", { device: info.uuid, model: info.modelName });
    return { token };
  }

  /** Removes a device: its token stops working at once. */
  async unregister(uuid: string): Promise<boolean> {
    const removed = await this.db.write((sql) => sql.run(`DELETE FROM devices WHERE uuid = ?`, [uuid]));
    this.forgetTokens(uuid);
    this.seen.delete(uuid);
    if (removed > 0) {
      this.stats.count("deletes");
      this.changed();
      log.info("device removed", { device: uuid });
    }
    return removed > 0;
  }

  async listDevices(): Promise<DeviceView[]> {
    const version = this.hub.version();
    if (this.viewCache?.version === version) return this.viewCache.devices;
    const devices = await this.db.read((sql) => devicesView(sql));
    this.viewCache = { version, devices };
    this.stats.count("reads", devices.length);
    return devices;
  }

  private async updateDevice(uuid: string, assignments: string, params: Param[]): Promise<boolean> {
    const changed = await this.db.write((sql) =>
      sql.run(`UPDATE devices SET ${assignments} WHERE uuid = ?`, [...params, uuid])
    );
    if (changed > 0) {
      this.stats.count("writes");
      this.changed();
    }
    return changed > 0;
  }

  touchLastSync(uuid: string): Promise<boolean> {
    return this.updateDevice(uuid, "last_sync = ?", [String(Date.now())]);
  }

  setPresence(uuid: string, presence: unknown): Promise<boolean> {
    if (!isObject(presence) || typeof presence.at !== "number" || !(presence.noteId === null || isKey(presence.noteId))) {
      throw new HttpError(400, "bad_request", "presence must be { noteId: string | null, at: number }");
    }
    const value = JSON.stringify({ noteId: presence.noteId, at: presence.at });
    if (byteLength(value) > MAX_PRESENCE_BYTES) throw new HttpError(413, "too_large");
    return this.updateDevice(uuid, "presence = ?", [value]);
  }

  /** Clears the request for a full sync, unless it was made again since (another `due`). */
  async clearFullSyncDue(uuid: string, due: number): Promise<void> {
    const changed = await this.db.write((sql) =>
      sql.run(`UPDATE devices SET full_sync_due = NULL WHERE uuid = ? AND full_sync_due = ?`, [uuid, due])
    );
    if (changed > 0) {
      this.stats.count("writes");
      this.changed();
    }
  }

  /** Asks one device (or all) to run a full sync, e.g. after restoring a backup. */
  async requestFullSync(uuid?: string): Promise<number> {
    const now = Date.now();
    const changed = await this.db.write((sql) =>
      uuid
        ? sql.run(`UPDATE devices SET full_sync_due = ? WHERE uuid = ?`, [now, uuid])
        : sql.run(`UPDATE devices SET full_sync_due = ?`, [now])
    );
    if (changed > 0) {
      this.stats.count("writes", changed);
      this.changed();
    }
    return changed;
  }

  // --- Sync ---

  /** Waits until something changed since `version` (a long poll), at most `ms`. */
  waitForChange(version: string, ms: number, signal: AbortSignal): Promise<void> {
    return this.hub.wait(version, ms, signal);
  }

  /**
   * What a device needs to stay in sync: every device, its next page of changes, and the vault. `page`: the page it has;
   * unchanged, it gets `{ same: true }` instead of the whole page again.
   */
  async snapshot(me: string, page?: string | null): Promise<Snapshot> {
    const v = this.hub.version();
    const devices = await this.listDevices();
    const { change, vault, reads } = await this.db.read(async (sql) => {
      const device = await sql.get<{ cursor: number }>(`SELECT cursor FROM devices WHERE uuid = ?`, [me]);
      // Removed meanwhile: the list (without it) tells the app.
      const feed = device ? await feedPage(sql, me, Number(device.cursor)) : { change: null, reads: 0 };
      return { change: feed.change, vault: await readVault(sql), reads: feed.reads + 1 };
    });
    this.stats.count("syncs");
    const same = change !== null && page != null && change.page === page;
    if (!same) this.stats.count("reads", reads);
    return { v, devices, change: same ? { same: true } : change, vault };
  }

  /** The device applied the feed up to `token`: its cursor moves there (never back, never past the last change). */
  async ack(me: string, token: unknown): Promise<void> {
    const seq = Number(token);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new HttpError(400, "bad_request", "token must be a sequence number");
    const changed = await this.db.write(async (sql) => {
      const to = Math.min(seq, await currentSeq(sql));
      return sql.run(`UPDATE devices SET cursor = ? WHERE uuid = ? AND cursor < ?`, [to, me, to]);
    });
    this.stats.count("acks");
    if (changed > 0) {
      this.stats.count("writes");
      this.changed();
    }
  }

  /**
   * Applies a device's outbox in one transaction (the same rules as the Firestore adapter's push): an upload goes through
   * only over an older version (and never over the same revision: it may be other content), a deletion only over versions
   * up to its own revision; what's refused comes back as `superseded`.
   */
  async push(me: string, body: unknown): Promise<PushResult> {
    const ops = parsePush(body);
    const result: PushResult = {
      committed: { notes: { add: [], delete: [], detach: [] }, categories: { add: [], delete: [] } },
      superseded: [],
      rejected: [],
      complete: true,
    };
    let writes = 0;
    const now = Date.now();

    await this.db.write(async (sql) => {
      const write = async (kind: ItemKind, key: string, state: ItemState, rev: number, data: string) => {
        const seq = await nextSeq(sql);
        await sql.run(
          `INSERT INTO items (kind, key, state, rev, seq, author, data, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (kind, key) DO UPDATE SET state = excluded.state, rev = excluded.rev, seq = excluded.seq,
             author = excluded.author, data = excluded.data, bytes = excluded.bytes, updated_at = excluded.updated_at`,
          [kind, key, state, rev, seq, me, data, byteLength(data), now]
        );
        writes++;
      };
      const tooLarge = (data: string) => byteLength(data) > this.limits.maxNoteBytes;

      for (const note of ops.notes.add) {
        const key = note.id as string;
        const data = JSON.stringify(note);
        if (tooLarge(data)) {
          result.rejected.push(`addNotes:${key}`);
          continue;
        }
        const rev = noteRev(note);
        const current = await getItem(sql, "note", key);
        if (current?.state === "live") {
          const base = ops.bases[key];
          const cloudRev = Number(current.rev);
          if (!(cloudRev !== rev && cloudRev <= (typeof base === "number" ? base : rev))) {
            result.superseded.push(JSON.parse(current.data));
            continue;
          }
        }
        await write("note", key, "live", rev, data);
        result.committed.notes.add.push(key);
      }

      for (const [state, stubs] of [
        ["deleted", ops.notes.delete],
        ["detached", ops.notes.detach],
      ] as const) {
        for (const stub of stubs) {
          const key = stub.id as string;
          const data = JSON.stringify(stub);
          const rev = noteRev(stub);
          const current = await getItem(sql, "note", key);
          if (state === "deleted" && current?.state === "live" && Number(current.rev) > rev) {
            result.superseded.push(JSON.parse(current.data));
            continue;
          }
          // The same tombstone, or a newer one: nothing to change.
          const known = current?.state === state && Number(current.rev) >= rev;
          if (!known) await write("note", key, state, rev, data);
          result.committed.notes[state === "deleted" ? "delete" : "detach"].push(key);
        }
      }

      for (const [state, categories] of [
        ["live", ops.categories.add],
        ["deleted", ops.categories.delete],
      ] as const) {
        for (const category of categories) {
          const key = category.icon as string;
          const data = JSON.stringify(category);
          if (tooLarge(data)) {
            result.rejected.push(`${queueOf("category", state)}:${key}`);
            continue;
          }
          const current = await getItem(sql, "category", key);
          if (!(current?.state === state && current.data === data)) await write("category", key, state, 0, data);
          result.committed.categories[state === "live" ? "add" : "delete"].push(key);
        }
      }

      if (writes > 0) {
        // Nothing from the others after its cursor: the device is up to date, past its own changes too (so the next
        // feed read doesn't walk over them).
        const device = await sql.get<{ cursor: number }>(`SELECT cursor FROM devices WHERE uuid = ?`, [me]);
        const cursor = Number(device?.cursor ?? 0);
        const foreign = await sql.get(`SELECT 1 AS found FROM items WHERE seq > ? AND author <> ? LIMIT 1`, [cursor, me]);
        await sql.run(`UPDATE devices SET last_sync = ?${foreign ? "" : ", cursor = ?"} WHERE uuid = ?`, [
          String(now),
          ...(foreign ? [] : [await currentSeq(sql)]),
          me,
        ]);
      }
    });

    this.stats.count("pushes");
    this.stats.count("reads", ops.notes.add.length + ops.notes.delete.length + ops.notes.detach.length);
    this.stats.count("writes", writes);
    if (result.rejected.length > 0) log.warn("push: entries refused for size", { device: me, entries: result.rejected });
    if (writes > 0) this.changed();
    return result;
  }

  // --- Vault ---

  readVault(): Promise<VaultRead> {
    this.stats.count("reads");
    return this.db.read((sql) => readVault(sql));
  }

  /** Creates the vault only if there's none (two devices setting up encryption at once: one wins, the other unlocks). */
  async createVault(vault: unknown): Promise<"created" | "exists"> {
    const data = vaultData(vault);
    const created = await this.db.write(async (sql) => {
      if (await sql.get(`SELECT 1 AS found FROM vault WHERE id = 1`)) return false;
      await sql.run(`INSERT INTO vault (id, data, updated_at) VALUES (1, ?, ?)`, [data, Date.now()]);
      return true;
    });
    if (!created) return "exists";
    this.stats.count("writes");
    this.changed();
    log.info("vault created");
    return "created";
  }

  async writeVault(vault: unknown): Promise<void> {
    const data = vaultData(vault);
    await this.db.write((sql) =>
      sql.run(
        `INSERT INTO vault (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        [data, Date.now()]
      )
    );
    this.stats.count("writes");
    this.changed();
    log.info("vault replaced");
  }

  // --- Data ---

  /** Every note (encrypted), as a JSON array. */
  async notesJson(): Promise<string> {
    const rows = await this.db.read((sql) =>
      sql.all<{ data: string }>(`SELECT data FROM items WHERE kind = 'note' AND state = 'live' ORDER BY seq`)
    );
    this.stats.count("reads", rows.length);
    return `[${rows.map((row) => row.data).join(",")}]`;
  }

  /** One note (encrypted JSON), or null when there's none. */
  async noteJson(id: string): Promise<string | null> {
    const row = await this.db.read((sql) => getItem(sql, "note", id));
    this.stats.count("reads");
    return row?.state === "live" ? row.data : null;
  }

  async tombstones(): Promise<Record<string, { rev: number; detach?: true }>> {
    const rows = await this.db.read((sql) =>
      sql.all<{ key: string; rev: number; state: ItemState }>(
        `SELECT key, rev, state FROM items WHERE kind = 'note' AND state <> 'live'`
      )
    );
    this.stats.count("reads", rows.length);
    return Object.fromEntries(
      rows.map((row) => [row.key, { rev: Number(row.rev), ...(row.state === "detached" && { detach: true as const }) }])
    );
  }

  async pruneTombstones(ids: unknown): Promise<number> {
    if (!Array.isArray(ids) || !ids.every(isKey)) throw new HttpError(400, "bad_request", "ids must be a list of note ids");
    let removed = 0;
    await this.db.write((sql) =>
      inChunks(ids, 500, async (chunk) => {
        removed += await sql.run(
          `DELETE FROM items WHERE kind = 'note' AND state <> 'live' AND key IN (${chunk.map(() => "?").join(", ")})`,
          chunk
        );
      })
    );
    this.stats.count("deletes", removed);
    return removed;
  }

  /** Every category, by `order`. */
  async categories(): Promise<Json[]> {
    const rows = await this.db.read((sql) =>
      sql.all<{ data: string }>(`SELECT data FROM items WHERE kind = 'category' AND state = 'live'`)
    );
    this.stats.count("reads", rows.length);
    return rows.map((row) => JSON.parse(row.data) as Json).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  }

  /** Writes notes as they are, with no guard (the app's vault migration re-encrypts the cloud's notes this way). */
  async importNotes(me: string, notes: unknown): Promise<void> {
    if (!Array.isArray(notes) || !notes.every((n) => isObject(n) && isKey(n.id))) {
      throw new HttpError(400, "bad_request", "notes must be a list of notes");
    }
    const now = Date.now();
    await this.db.write(async (sql) => {
      for (const note of notes as Json[]) {
        const data = JSON.stringify(note);
        if (byteLength(data) > this.limits.maxNoteBytes) throw new HttpError(413, "too_large", `note ${note.id} is too large`);
        await sql.run(
          `INSERT INTO items (kind, key, state, rev, seq, author, data, bytes, updated_at) VALUES ('note', ?, 'live', ?, ?, ?, ?, ?, ?)
           ON CONFLICT (kind, key) DO UPDATE SET state = excluded.state, rev = excluded.rev, seq = excluded.seq,
             author = excluded.author, data = excluded.data, bytes = excluded.bytes, updated_at = excluded.updated_at`,
          [note.id as string, noteRev(note), await nextSeq(sql), me, data, byteLength(data), now]
        );
      }
    });
    this.stats.count("writes", notes.length);
    if (notes.length > 0) this.changed();
  }

  /** Deletes every note and tombstone (the app's vault reset: the old notes can't be read anymore). */
  async wipeNotes(): Promise<void> {
    const removed = await this.db.write((sql) => sql.run(`DELETE FROM items WHERE kind = 'note'`));
    this.stats.count("deletes", removed);
    this.changed();
    log.info("notes wiped", { notes: removed });
  }

  /** Deletes every category but `fallback` (the app's default one). */
  async resetCategories(me: string, fallback: unknown): Promise<void> {
    if (!isObject(fallback) || !isKey(fallback.icon)) throw new HttpError(400, "bad_request", "category must have an icon");
    const data = JSON.stringify(fallback);
    const removed = await this.db.write(async (sql) => {
      const n = await sql.run(`DELETE FROM items WHERE kind = 'category'`);
      await sql.run(
        `INSERT INTO items (kind, key, state, rev, seq, author, data, bytes, updated_at) VALUES ('category', ?, 'live', 0, ?, ?, ?, ?, ?)`,
        [fallback.icon as string, await nextSeq(sql), me, data, byteLength(data), Date.now()]
      );
      return n;
    });
    this.stats.count("deletes", removed);
    this.stats.count("writes");
    this.changed();
  }

  // --- Operations ---

  /** Keeps the newest warnings and errors for the dashboard (written with the stats). */
  recordEvent(record: LogRecord): void {
    this.events.push(record);
    if (this.events.length > EVENTS_KEPT) this.events.splice(0, this.events.length - EVENTS_KEPT);
  }

  /** Writes what's kept in memory: stats, events, when devices were last seen. */
  async flush(): Promise<void> {
    const events = this.events;
    this.events = [];
    const seen = [...this.seen];
    this.seen.clear();
    if (events.length > 0 || seen.length > 0) {
      await this.db.write(async (sql) => {
        for (const event of events) {
          await sql.run(`INSERT INTO events (at, level, message, detail) VALUES (?, ?, ?, ?)`, [
            event.at,
            event.level,
            event.message.slice(0, 500),
            event.detail ? JSON.stringify(event.detail).slice(0, 4000) : null,
          ]);
        }
        for (const [uuid, at] of seen) {
          await sql.run(`UPDATE devices SET last_seen = ? WHERE uuid = ? AND last_seen < ?`, [at, uuid, at]);
        }
      });
    }
    await this.stats.flush(this.db);
  }

  /** Hourly: drops what nobody needs anymore. */
  async maintenance(): Promise<void> {
    const now = Date.now();
    const removed = await this.db.write(async (sql) => {
      const min = await sql.get<{ cursor: number | null }>(`SELECT MIN(cursor) AS cursor FROM devices`);
      // Every device has read up to here (no device: nobody will).
      const everyone = min?.cursor != null ? Number(min.cursor) : await currentSeq(sql);
      let n = await sql.run(`DELETE FROM items WHERE kind = 'category' AND state = 'deleted' AND seq <= ? AND updated_at < ?`, [
        everyone,
        now - CATEGORY_TOMBSTONE_TTL_MS,
      ]);
      n += await sql.run(`DELETE FROM items WHERE kind = 'note' AND state <> 'live' AND seq <= ? AND rev < ?`, [
        everyone,
        now - NOTE_TOMBSTONE_TTL_MS,
      ]);
      await sql.run(`DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?`, [EVENTS_KEPT]);
      const oldest = new Date(now - STATS_KEPT_DAYS * 86_400_000).toISOString().slice(0, 10);
      await sql.run(`DELETE FROM stats WHERE day < ?`, [oldest]);
      return n;
    });
    if (removed > 0) {
      this.stats.count("deletes", removed);
      log.info("maintenance: old tombstones dropped", { rows: removed });
    }
  }

  /** Everything the dashboard shows but the history and the events. */
  async overview() {
    const devices = await this.listDevices();
    const { counts, rows, seq } = await this.db.read(async (sql) => ({
      counts: await sql.all<{ kind: ItemKind; state: ItemState; n: number; bytes: number }>(
        `SELECT kind, state, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM items GROUP BY kind, state`
      ),
      rows: await sql.all<DeviceRow>(`SELECT * FROM devices`),
      seq: await currentSeq(sql),
    }));
    const behind = await this.db.read(async (sql) => {
      const out: Record<string, number> = {};
      for (const row of rows) {
        const r = await sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM items WHERE seq > ? AND author <> ?`, [
          Number(row.cursor),
          row.uuid,
        ]);
        out[row.uuid] = Number(r?.n ?? 0);
      }
      return out;
    });
    const count = (kind: ItemKind, state: ItemState) => counts.find((c) => c.kind === kind && c.state === state);
    const byUuid = new Map(rows.map((row) => [row.uuid, row]));
    return {
      seq,
      counts: {
        notes: Number(count("note", "live")?.n ?? 0),
        noteBytes: Number(count("note", "live")?.bytes ?? 0),
        tombstones: Number(count("note", "deleted")?.n ?? 0) + Number(count("note", "detached")?.n ?? 0),
        categories: Number(count("category", "live")?.n ?? 0),
        devices: devices.length,
      },
      devices: devices.map((device) => {
        const row = byUuid.get(device.uuid);
        return {
          ...device,
          cursor: Number(row?.cursor ?? 0),
          createdAt: Number(row?.created_at ?? 0),
          lastSeen: Math.max(Number(row?.last_seen ?? 0), this.seen.get(device.uuid) ?? 0),
          behind: behind[device.uuid] ?? 0,
        };
      }),
    };
  }

  async recentEvents(limit: number): Promise<{ at: number; level: string; message: string; detail: unknown }[]> {
    const rows = await this.db.read((sql) =>
      sql.all<{ at: number; level: string; message: string; detail: string | null }>(
        `SELECT at, level, message, detail FROM events ORDER BY id DESC LIMIT ?`,
        [limit]
      )
    );
    const parse = (detail: string | null) => {
      try {
        return detail ? JSON.parse(detail) : null;
      } catch {
        return detail;
      }
    };
    return [
      ...[...this.events].reverse().map((e) => ({ at: e.at, level: e.level, message: e.message, detail: e.detail ?? null })),
      ...rows.map((row) => ({ at: Number(row.at), level: row.level, message: row.message, detail: parse(row.detail) })),
    ].slice(0, limit);
  }
}

// --- Queries ---

const currentSeq = async (sql: Sql): Promise<number> =>
  Number((await sql.get<{ value: number }>(`SELECT value FROM counters WHERE name = 'seq'`))?.value ?? 0);

const nextSeq = async (sql: Sql): Promise<number> => {
  const row = await sql.get<{ value: number }>(`UPDATE counters SET value = value + 1 WHERE name = 'seq' RETURNING value`);
  if (!row) throw new Error("the sequence counter is missing");
  return Number(row.value);
};

const getItem = (sql: Sql, kind: ItemKind, key: string): Promise<ItemRow | undefined> =>
  sql.get<ItemRow>(`SELECT kind, key, state, rev, seq, author, data FROM items WHERE kind = ? AND key = ?`, [kind, key]);

const readVault = async (sql: Sql): Promise<VaultRead> => {
  const row = await sql.get<{ data: string }>(`SELECT data FROM vault WHERE id = 1`);
  return row ? { status: "present", vault: JSON.parse(row.data) } : { status: "absent", vault: null };
};

const vaultData = (vault: unknown): string => {
  if (!isObject(vault)) throw new HttpError(400, "bad_request", "the vault must be an object");
  const data = JSON.stringify(vault);
  if (byteLength(data) > MAX_VAULT_BYTES) throw new HttpError(413, "too_large");
  return data;
};

/** The next page of what others wrote after `cursor`. */
const feedPage = async (sql: Sql, me: string, cursor: number): Promise<{ change: Change | null; reads: number }> => {
  const rows = await sql.all<ItemRow & { bytes: number }>(
    `SELECT kind, key, state, seq, data, bytes FROM items WHERE seq > ? AND author <> ? ORDER BY seq LIMIT ?`,
    [cursor, me, PAGE_ROWS + 1]
  );
  if (rows.length === 0) return { change: null, reads: 0 };
  const taken: typeof rows = [];
  let bytes = 0;
  for (const row of rows.slice(0, PAGE_ROWS)) {
    bytes += Number(row.bytes);
    if (taken.length > 0 && bytes > PAGE_BYTES) break;
    taken.push(row);
  }
  const last = Number(taken[taken.length - 1].seq);
  const change: Change = {
    token: String(last),
    page: `${cursor}.${last}.${taken.length}`,
    more: rows.length > taken.length,
    notes: { add: {}, delete: {}, detach: {} },
    categories: { add: {}, delete: {} },
  };
  for (const row of taken) {
    const value = JSON.parse(row.data) as Json;
    if (row.kind === "note") {
      change.notes[row.state === "live" ? "add" : row.state === "deleted" ? "delete" : "detach"][row.key] = value;
    } else {
      change.categories[row.state === "live" ? "add" : "delete"][row.key] = value;
    }
  }
  return { change, reads: taken.length };
};

/**
 * Every device, with who hasn't pulled its latest changes yet (the app's devices screen shows who's behind). Counted per
 * reader: what each author wrote after the reader's cursor.
 */
const devicesView = async (sql: Sql): Promise<DeviceView[]> => {
  const rows = await sql.all<DeviceRow>(`SELECT * FROM devices ORDER BY created_at, uuid`);
  const views = new Map<string, DeviceView>(
    rows.map((row) => [
      row.uuid,
      {
        uuid: row.uuid,
        modelName: row.model_name,
        brand: row.brand,
        lastSync: row.last_sync,
        fullSyncDue: row.full_sync_due == null ? null : Number(row.full_sync_due),
        devicesToSync: [],
        pendingNotes: 0,
        pendingCategories: 0,
        presence: parsePresence(row.presence),
      },
    ])
  );
  for (const reader of rows) {
    const pending = await sql.all<{ author: string; kind: ItemKind; n: number }>(
      `SELECT author, kind, COUNT(*) AS n FROM items WHERE seq > ? AND author <> ? GROUP BY author, kind`,
      [Number(reader.cursor), reader.uuid]
    );
    for (const { author, kind, n } of pending) {
      const view = views.get(author);
      if (!view) continue; // written by a device removed since
      if (!view.devicesToSync.includes(reader.uuid)) view.devicesToSync.push(reader.uuid);
      if (kind === "note") view.pendingNotes = Math.max(view.pendingNotes, Number(n));
      else view.pendingCategories = Math.max(view.pendingCategories, Number(n));
    }
  }
  return [...views.values()];
};

/** Checks a push body's shape; entries without an id are dropped (nothing could refer to them). */
const parsePush = (body: unknown): PushBody => {
  if (!isObject(body) || !isObject(body.notes) || !isObject(body.categories)) {
    throw new HttpError(400, "bad_request", "expected { notes, categories, bases }");
  }
  const list = (value: unknown, keyField: "id" | "icon"): Json[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new HttpError(400, "bad_request", "every queue must be a list");
    const valid = value.filter((entry): entry is Json => isObject(entry) && isKey(entry[keyField]));
    if (valid.length < value.length) log.warn("push: entries without an id dropped", { dropped: value.length - valid.length });
    return valid;
  };
  const bases = isObject(body.bases) ? body.bases : {};
  return {
    notes: { add: list(body.notes.add, "id"), delete: list(body.notes.delete, "id"), detach: list(body.notes.detach, "id") },
    categories: { add: list(body.categories.add, "icon"), delete: list(body.categories.delete, "icon") },
    bases: Object.fromEntries(Object.entries(bases).filter(([, rev]) => typeof rev === "number")) as Record<string, number>,
  };
};
