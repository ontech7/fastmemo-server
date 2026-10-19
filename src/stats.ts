import type { Database } from "./store/db.ts";

/*
 * Daily counters for the dashboard: what the server did (documents read, written, deleted, like Firestore's quotas,
 * plus requests, traffic and errors). Counted in memory and written every few seconds, so counting costs no write.
 * Days follow the server's time zone (TZ).
 */

export const STAT_KEYS = [
  "requests",
  "reads",
  "writes",
  "deletes",
  "pushes",
  "syncs",
  "acks",
  "bytesIn",
  "bytesOut",
  "errors",
  "authFailures",
] as const;

export type StatKey = (typeof STAT_KEYS)[number];

export type DayStats = { day: string } & Record<StatKey, number>;

/** YYYY-MM-DD in the server's time zone. */
export const dayOf = (time: number = Date.now()): string => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export class Stats {
  private pending = new Map<string, number>();

  count(key: StatKey, n = 1): void {
    if (n <= 0) return;
    const id = `${dayOf()}|${key}`;
    this.pending.set(id, (this.pending.get(id) ?? 0) + n);
  }

  /** Writes what was counted since the last flush. */
  async flush(db: Database): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    try {
      await db.write(async (sql) => {
        for (const [id, n] of batch) {
          const [day, key] = id.split("|");
          await sql.run(
            `INSERT INTO stats (day, key, value) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET value = stats.value + excluded.value`,
            [day, key, n]
          );
        }
      });
    } catch (e) {
      // Counted again on the next flush.
      for (const [id, n] of batch) this.pending.set(id, (this.pending.get(id) ?? 0) + n);
      throw e;
    }
  }

  /** The last `days` days, oldest first, with what's not flushed yet. */
  async history(db: Database, days: number): Promise<DayStats[]> {
    const since = dayOf(Date.now() - (days - 1) * 86_400_000);
    const rows = await db.read((sql) =>
      sql.all<{ day: string; key: string; value: number }>(`SELECT day, key, value FROM stats WHERE day >= ?`, [since])
    );
    const byDay = new Map<string, DayStats>();
    const at = (day: string) => {
      let entry = byDay.get(day);
      if (!entry) {
        entry = { day, ...(Object.fromEntries(STAT_KEYS.map((k) => [k, 0])) as Record<StatKey, number>) };
        byDay.set(day, entry);
      }
      return entry;
    };
    for (let i = days - 1; i >= 0; i--) at(dayOf(Date.now() - i * 86_400_000));
    for (const { day, key, value } of rows) {
      if ((STAT_KEYS as readonly string[]).includes(key)) at(day)[key as StatKey] += Number(value);
    }
    for (const [id, n] of this.pending) {
      const [day, key] = id.split("|");
      if (day >= since) at(day)[key as StatKey] += n;
    }
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  }
}
