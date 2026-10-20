import http from "node:http";
import { promisify } from "node:util";
import zlib from "node:zlib";

import { log } from "./log.ts";
import { HttpError } from "./model.ts";
import type { Stats } from "./stats.ts";

/*
 * A small HTTP layer on node:http (no framework): routes with a pattern and an auth requirement, JSON bodies with a size
 * limit, CORS for the app (web, desktop), gzip for large replies.
 */

const gzip = promisify(zlib.gzip);

/** none; key: the access key; device: a device token; member: either (the device is "" with the key); admin. */
export type Auth = "none" | "key" | "device" | "member" | "admin";

export interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  ip: string;
  /** Pattern captures. */
  params: string[];
  /** The authenticated device (routes with `auth: "device"`). */
  device: string;
  /** Aborted when the client goes away (a long poll stops waiting). */
  signal: AbortSignal;
  /** The JSON body. */
  json(): Promise<unknown>;
}

export interface Reply {
  status?: number;
  json?: unknown;
  /** Already serialized JSON. */
  rawJson?: string;
  body?: string | Buffer;
  type?: string;
  headers?: Record<string, string>;
}

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  pattern: RegExp;
  auth: Auth;
  handler: (req: Request) => Promise<Reply>;
}

export interface HttpOptions {
  routes: Route[];
  maxBodyBytes: number;
  trustProxy: boolean;
  stats: Stats;
  /** Resolves the request's identity for `auth`, or throws an HttpError (401, 429). Returns the device for "device". */
  authenticate(auth: Auth, req: Request): Promise<string>;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Access-Key",
  "Access-Control-Max-Age": "600",
};

const COMPRESSIBLE = /^(application\/json|text\/|application\/javascript|image\/svg)/;
const GZIP_MIN_BYTES = 4096;

/**
 * Behind a proxy, the address it saw: the last X-Forwarded-For entry (the ones before it come from the client, which could
 * make them up to dodge the wrong-key limit).
 */
const clientIp = (req: http.IncomingMessage, trustProxy: boolean): string => {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const last = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded)?.split(",").pop()?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
};

/** A malformed escape is the client's mistake (400), not the server's. */
const decodeParam = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "bad_request", "malformed URL");
  }
};

/** An oversized body up to this many times the limit is still read (and dropped) before the 413; past it, cut off. */
const DRAIN_FACTOR = 4;

/**
 * The body, up to `limit` bytes. An oversized one is read to its end before the 413 goes out: a client still sending when
 * the connection closes sees a broken connection, not the answer that tells it to send less (it would retry forever).
 */
const readBody = (req: http.IncomingMessage, limit: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, "too_large", `The request is over ${Math.round(limit / 1048576)} MB`);
    const declared = Number(req.headers["content-length"]);
    if (declared > limit * DRAIN_FACTOR) {
      reject(tooLarge());
      return;
    }
    let chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit * DRAIN_FACTOR) {
        reject(tooLarge());
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      if (size > limit) chunks = [];
      else chunks.push(chunk);
    });
    req.on("end", () => (size > limit ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });

export const createHttpServer = (options: HttpOptions): http.Server => {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    let bytesIn = 0;
    const closed = new AbortController();
    res.on("close", () => closed.abort());

    const send = async (status: number, reply: Reply) => {
      if (res.headersSent || res.destroyed) return;
      let body: string | Buffer = "";
      let type = reply.type;
      if (reply.rawJson !== undefined) {
        body = reply.rawJson;
        type = "application/json; charset=utf-8";
      } else if (reply.json !== undefined) {
        body = JSON.stringify(reply.json);
        type = "application/json; charset=utf-8";
      } else if (reply.body !== undefined) {
        body = reply.body;
      }
      const headers: Record<string, string> = {
        ...CORS,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
        ...(type && { "Content-Type": type }),
        ...reply.headers,
      };
      const accepts = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
      if (accepts && type && COMPRESSIBLE.test(type) && Buffer.byteLength(body) >= GZIP_MIN_BYTES) {
        body = await gzip(body);
        headers["Content-Encoding"] = "gzip";
        headers.Vary = "Accept-Encoding";
      }
      const length = Buffer.byteLength(body);
      headers["Content-Length"] = String(length);
      options.stats.count("bytesOut", length);
      res.writeHead(status, headers);
      res.end(method === "HEAD" ? undefined : body);
    };

    try {
      options.stats.count("requests");
      if (method === "OPTIONS") {
        // Chrome asks before a public site calls a private address (a server on the LAN).
        const pna = req.headers["access-control-request-private-network"] === "true";
        await send(204, { headers: pna ? { "Access-Control-Allow-Private-Network": "true" } : {} });
        return;
      }

      let params: string[] = [];
      const route = options.routes.find((r) => {
        if (r.method !== method && !(method === "HEAD" && r.method === "GET")) return false;
        const match = r.pattern.exec(url.pathname);
        if (match) params = match.slice(1).map(decodeParam);
        return match !== null;
      });
      if (!route) throw new HttpError(404, "not_found");

      const request: Request = {
        method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        ip: clientIp(req, options.trustProxy),
        params,
        device: "",
        signal: closed.signal,
        json: async () => {
          const raw = await readBody(req, options.maxBodyBytes);
          bytesIn = raw.length;
          options.stats.count("bytesIn", raw.length);
          if (raw.length === 0) return undefined;
          try {
            return JSON.parse(raw.toString("utf8"));
          } catch {
            throw new HttpError(400, "bad_request", "The body isn't valid JSON");
          }
        },
      };
      request.device = await options.authenticate(route.auth, request);
      const reply = await route.handler(request);
      await send(reply.status ?? 200, reply);
    } catch (e) {
      const error = e instanceof HttpError ? e : null;
      const status = error?.status ?? 500;
      if (status >= 500) {
        options.stats.count("errors");
        log.error("request failed", { method, path: url.pathname, error: e });
      }
      if (status === 413) res.setHeader("Connection", "close");
      await send(status, { json: { error: error?.code ?? "server_error", message: error?.message ?? "Internal error" } }).catch(
        () => {}
      );
    } finally {
      log.debug("request", { method, path: url.pathname, status: res.statusCode, ms: Date.now() - started, bytesIn });
    }
  });
  // Above a reverse proxy's idle timeout, so the proxy closes idle connections first.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  return server;
};
