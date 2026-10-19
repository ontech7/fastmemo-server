import type { LogLevel } from "./config.ts";

/*
 * Logs are JSON lines on stdout (`docker compose logs`). Warnings and errors are also kept for the dashboard (see
 * `onRecord`). Never log a key, a token or note content: only ids, sizes and codes.
 */

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  at: number;
  level: LogLevel;
  message: string;
  detail?: Record<string, unknown>;
}

let threshold = LEVELS.info;
let sink: (record: LogRecord) => void = () => {};
let silent = false;

export const setLogLevel = (level: LogLevel): void => {
  threshold = LEVELS[level];
};

/** Tests: no output. */
export const silenceLogs = (value: boolean): void => {
  silent = value;
};

/** Receives every warning and error (the dashboard's event list). */
export const onRecord = (listener: (record: LogRecord) => void): void => {
  sink = listener;
};

const errorDetail = (value: unknown): unknown =>
  value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack?.split("\n").slice(0, 6).join("\n") }
    : value;

const write = (level: LogLevel, message: string, detail?: Record<string, unknown>): void => {
  const record: LogRecord = {
    at: Date.now(),
    level,
    message,
    ...(detail && { detail: Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, errorDetail(v)])) }),
  };
  if (LEVELS[level] >= LEVELS.warn) {
    try {
      sink(record);
    } catch {
      // the event store failing must not take logging down
    }
  }
  if (silent || LEVELS[level] < threshold) return;
  const line = JSON.stringify({ time: new Date(record.at).toISOString(), level, message, ...record.detail });
  (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
};

export const log = {
  debug: (message: string, detail?: Record<string, unknown>) => write("debug", message, detail),
  info: (message: string, detail?: Record<string, unknown>) => write("info", message, detail),
  warn: (message: string, detail?: Record<string, unknown>) => write("warn", message, detail),
  error: (message: string, detail?: Record<string, unknown>) => write("error", message, detail),
};
