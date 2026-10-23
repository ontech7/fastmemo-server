import path from "node:path";

/*
 * Configuration, from the environment only (docker compose, Coolify, a shell). Every value has a safe default but the
 * access key: without one the server doesn't start, so a forgotten setting can't leave it open or put a key in the logs.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type DatabaseConfig = { driver: "sqlite"; path: string } | { driver: "postgres"; url: string };

export interface Config {
  port: number;
  host: string;
  database: DatabaseConfig;
  /** Enrolls devices. Required. */
  accessKey: string;
  /** Opens the dashboard. Null: the access key does. */
  adminKey: string | null;
  maxDevices: number;
  /** Largest note (its encrypted JSON) a push may carry. */
  maxNoteBytes: number;
  maxBodyBytes: number;
  /** Behind a reverse proxy (Coolify, Traefik, nginx): the client address comes from X-Forwarded-For. */
  trustProxy: boolean;
  logLevel: LogLevel;
  /** Asks GitHub every 6 hours whether a newer release is out. */
  updateCheck: boolean;
  /** Where an install request is left for the updater, and where it reports. Null: no updater. */
  updateRequestDir: string | null;
  updateStatusDir: string | null;
}

export class ConfigError extends Error {}

const MIN_KEY_LENGTH = 16;

const integer = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new ConfigError(`${name} must be an integer >= ${min} (got "${raw}")`);
  return value;
};

const flag = (env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean => {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["on", "true", "1", "yes"].includes(raw)) return true;
  if (["off", "false", "0", "no"].includes(raw)) return false;
  throw new ConfigError(`${name} must be on or off (got "${env[name]?.trim()}")`);
};

const key = (env: NodeJS.ProcessEnv, name: string): string | null => {
  const value = env[name]?.trim();
  if (!value) return null;
  if (value.length < MIN_KEY_LENGTH) throw new ConfigError(`${name} must be at least ${MIN_KEY_LENGTH} characters long`);
  return value;
};

const requiredKey = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = key(env, name);
  if (value === null) {
    throw new ConfigError(
      `${name} is not set. Set it in .env to a random value of at least ${MIN_KEY_LENGTH} characters (for example the ` +
        `output of: openssl rand -hex 24), then start the server again.`
    );
  }
  return value;
};

const MIB = 1024 * 1024;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const dataDir = env.DATA_DIR?.trim() || path.resolve("data");
  const url = env.DATABASE_URL?.trim() ?? "";
  let database: DatabaseConfig;
  if (/^postgres(ql)?:\/\//i.test(url)) database = { driver: "postgres", url };
  else if (url.startsWith("sqlite:")) database = { driver: "sqlite", path: url.slice("sqlite:".length) || ":memory:" };
  else if (url) throw new ConfigError(`DATABASE_URL must start with sqlite: or postgres:// (got "${url.split(":")[0]}:...")`);
  else database = { driver: "sqlite", path: path.join(dataDir, "fastmemo.db") };

  const level = (env.LOG_LEVEL?.trim().toLowerCase() || "info") as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(level))
    throw new ConfigError(`LOG_LEVEL must be debug, info, warn or error`);

  return {
    port: integer(env, "PORT", 8787, 0),
    // This computer only, unless asked: a plain install isn't on the network over plain HTTP by accident (the image sets
    // 0.0.0.0: the container's port is published by Docker).
    host: env.HOST?.trim() || "127.0.0.1",
    database,
    accessKey: requiredKey(env, "FASTMEMO_ACCESS_KEY"),
    adminKey: key(env, "FASTMEMO_ADMIN_KEY"),
    maxDevices: integer(env, "MAX_DEVICES", 10, 1),
    maxNoteBytes: integer(env, "MAX_NOTE_MB", 5, 1) * MIB,
    maxBodyBytes: integer(env, "MAX_BODY_MB", 64, 1) * MIB,
    trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY?.trim() ?? ""),
    logLevel: level,
    updateCheck: flag(env, "UPDATE_CHECK", true),
    updateRequestDir: env.UPDATE_REQUEST_DIR?.trim() || null,
    updateStatusDir: env.UPDATE_STATUS_DIR?.trim() || null,
  };
};
