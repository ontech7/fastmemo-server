import path from "node:path";

/*
 * Configuration, from the environment only (docker compose, Coolify, a shell). Every value has a safe default but the
 * access key, which is generated on first start when it's missing (see main.ts).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type DatabaseConfig = { driver: "sqlite"; path: string } | { driver: "postgres"; url: string };

export interface Config {
  port: number;
  host: string;
  database: DatabaseConfig;
  /** Enrolls devices. Null: use the one generated on first start. */
  accessKey: string | null;
  /** Opens the dashboard. Null: the access key does. */
  adminKey: string | null;
  maxDevices: number;
  /** Largest note (its encrypted JSON) a push may carry. */
  maxNoteBytes: number;
  maxBodyBytes: number;
  /** Behind a reverse proxy (Coolify, Traefik, nginx): the client address comes from X-Forwarded-For. */
  trustProxy: boolean;
  logLevel: LogLevel;
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

const key = (env: NodeJS.ProcessEnv, name: string): string | null => {
  const value = env[name]?.trim();
  if (!value) return null;
  if (value.length < MIN_KEY_LENGTH) throw new ConfigError(`${name} must be at least ${MIN_KEY_LENGTH} characters long`);
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
    host: env.HOST?.trim() || "0.0.0.0",
    database,
    accessKey: key(env, "FASTMEMO_ACCESS_KEY"),
    adminKey: key(env, "FASTMEMO_ADMIN_KEY"),
    maxDevices: integer(env, "MAX_DEVICES", 10, 1),
    maxNoteBytes: integer(env, "MAX_NOTE_MB", 5, 1) * MIB,
    maxBodyBytes: integer(env, "MAX_BODY_MB", 64, 1) * MIB,
    trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY?.trim() ?? ""),
    logLevel: level,
  };
};
