import type { Route } from "./http.ts";
import { HttpError, isKey, isObject } from "./model.ts";
import type { Service } from "./service.ts";

/*
 * The app's API (the app's `ServerBackend` speaks it). Version 1, under /v1.
 *
 * Auth: `X-Access-Key` (the server's access key) enrolls a device and gets its token; `Authorization: Bearer <token>`
 * identifies a device. Routes marked "member" take either: the app reads the vault and the notes while connecting, before
 * it registers (it registers once the vault is unlocked).
 */

export const PROTOCOL = 1;

/** The longest a long poll may wait, in seconds. */
const MAX_WAIT_S = 50;

export interface ServerInfo {
  version: string;
  instance: string;
}

const self = (req: { params: string[]; device: string }) => {
  if (req.params[0] !== req.device) throw new HttpError(403, "forbidden", "A device can only change itself");
  return req.device;
};

const deviceInfo = (body: unknown) => {
  if (!isObject(body) || !isKey(body.uuid)) throw new HttpError(400, "bad_request", "expected { uuid, modelName, brand }");
  const text = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : fallback;
  return { uuid: body.uuid, modelName: text(body.modelName, "web"), brand: text(body.brand, "web") };
};

export const apiRoutes = (service: Service, info: ServerInfo): Route[] => [
  { method: "GET", pattern: /^\/v1\/health$/, auth: "none", handler: async () => ({ json: { ok: true } }) },
  {
    method: "GET",
    pattern: /^\/v1\/info$/,
    auth: "key",
    handler: async () => ({
      json: {
        server: "fastmemo-server",
        version: info.version,
        protocol: PROTOCOL,
        instance: info.instance,
        maxDevices: service.maxDevices,
        maxNoteBytes: service.maxNoteBytes,
      },
    }),
  },

  // --- Devices ---
  {
    method: "POST",
    pattern: /^\/v1\/devices$/,
    auth: "key",
    handler: async (req) => ({ status: 201, json: await service.register(deviceInfo(await req.json())) }),
  },
  {
    method: "GET",
    pattern: /^\/v1\/devices$/,
    auth: "member",
    // With the limits: a device that didn't connect in this run (no /v1/info handshake) still knows them.
    handler: async () => ({
      json: { devices: await service.listDevices(), maxDevices: service.maxDevices, maxNoteBytes: service.maxNoteBytes },
    }),
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/devices\/([^/]+)$/,
    auth: "member",
    handler: async (req) => {
      await service.unregister(req.params[0]);
      return { status: 204 };
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/devices\/([^/]+)\/last-sync$/,
    auth: "device",
    handler: async (req) => {
      await service.touchLastSync(self(req));
      return { status: 204 };
    },
  },
  {
    method: "PUT",
    pattern: /^\/v1\/devices\/([^/]+)\/presence$/,
    auth: "device",
    handler: async (req) => {
      await service.setPresence(self(req), await req.json());
      return { status: 204 };
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/devices\/([^/]+)\/full-sync-done$/,
    auth: "device",
    handler: async (req) => {
      const body = await req.json();
      if (!isObject(body) || typeof body.due !== "number") throw new HttpError(400, "bad_request", "expected { due }");
      await service.clearFullSyncDue(self(req), body.due);
      return { status: 204 };
    },
  },

  // --- Sync ---
  {
    method: "GET",
    pattern: /^\/v1\/sync$/,
    auth: "device",
    handler: async (req) => {
      const wait = Math.min(Math.max(Number(req.query.get("wait")) || 0, 0), MAX_WAIT_S) * 1000;
      const version = req.query.get("v");
      if (version) await service.waitForChange(version, wait, req.signal, req.device);
      return { json: await service.snapshot(req.device, req.query.get("p")) };
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/ack$/,
    auth: "device",
    handler: async (req) => {
      const body = await req.json();
      await service.ack(req.device, isObject(body) ? body.token : undefined);
      return { status: 204 };
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/push$/,
    auth: "device",
    handler: async (req) => ({ json: await service.push(req.device, await req.json()) }),
  },

  // --- Vault ---
  { method: "GET", pattern: /^\/v1\/vault$/, auth: "member", handler: async () => ({ json: await service.readVault() }) },
  {
    method: "POST",
    pattern: /^\/v1\/vault$/,
    auth: "member",
    handler: async (req) => {
      const result = await service.createVault(await req.json());
      return { status: result === "created" ? 201 : 409, json: { result } };
    },
  },
  {
    method: "PUT",
    pattern: /^\/v1\/vault$/,
    auth: "member",
    handler: async (req) => {
      await service.writeVault(await req.json());
      return { status: 204 };
    },
  },

  // --- Data ---
  {
    method: "GET",
    pattern: /^\/v1\/notes$/,
    auth: "member",
    handler: async (req) => {
      const after = Number(req.query.get("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "bad_request", "after must be a sequence number");
      // Optional: a client on a slow link asks for smaller pages (the server's size is the most it gets).
      const bytes = req.query.has("bytes") ? Number(req.query.get("bytes")) : undefined;
      if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 1)) {
        throw new HttpError(400, "bad_request", "bytes must be a positive size");
      }
      return { rawJson: await service.notesPage(after, bytes) };
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/notes\/([^/]+)$/,
    auth: "member",
    handler: async (req) => {
      const note = await service.noteJson(req.params[0]);
      if (note === null) throw new HttpError(404, "not_found");
      return { rawJson: note };
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/notes\/import$/,
    auth: "member",
    handler: async (req) => {
      const body = await req.json();
      await service.importNotes(req.device, isObject(body) ? body.notes : undefined);
      return { status: 204 };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/notes$/,
    auth: "member",
    handler: async () => {
      await service.wipeNotes();
      return { status: 204 };
    },
  },
  { method: "GET", pattern: /^\/v1\/tombstones$/, auth: "member", handler: async () => ({ json: await service.tombstones() }) },
  {
    method: "POST",
    pattern: /^\/v1\/tombstones\/prune$/,
    auth: "member",
    handler: async (req) => {
      const body = await req.json();
      return { json: { removed: await service.pruneTombstones(isObject(body) ? body.ids : undefined) } };
    },
  },
  { method: "GET", pattern: /^\/v1\/categories$/, auth: "member", handler: async () => ({ json: await service.categories() }) },
  {
    method: "POST",
    pattern: /^\/v1\/categories\/reset$/,
    auth: "member",
    handler: async (req) => {
      const body = await req.json();
      await service.resetCategories(req.device, isObject(body) ? body.category : undefined);
      return { status: 204 };
    },
  },
];
