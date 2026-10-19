/*
 * What travels between the app and the server. Notes are opaque to the server: their content is encrypted on the device
 * (the app's per-vault E2E encryption, ADR-012); the server reads only `id`, `rev` and `updatedAt` (to order versions) and
 * a category's `icon` and `order`.
 */

export type Json = Record<string, unknown>;

export type ItemKind = "note" | "category";
/** A note row's state: the note, or its tombstone (deleted for good / made device-only). Categories: live or deleted. */
export type ItemState = "live" | "deleted" | "detached";

/** Same rule as the app (libs/cloud/revision.ts): `rev`, or `updatedAt` for a version an older app wrote. */
export const noteRev = (note: Json): number => Math.max(Number(note.rev) || 0, Number(note.updatedAt) || 0);

export interface Presence {
  noteId: string | null;
  at: number;
}

/** A device as every device sees it (the app's `CloudDevice`). */
export interface DeviceView {
  uuid: string;
  modelName: string;
  brand: string;
  lastSync: string;
  fullSyncDue: number | null;
  /** Devices that haven't pulled this device's latest changes yet. */
  devicesToSync: string[];
  pendingNotes: number;
  pendingCategories: number;
  presence: Presence | null;
}

export interface PushBody {
  notes: { add: Json[]; delete: Json[]; detach: Json[] };
  categories: { add: Json[]; delete: Json[] };
  /** Per upload, the revision the device last knew in the cloud (missing: overwrite only older versions). */
  bases: Record<string, number | null | undefined>;
}

export interface PushResult {
  committed: {
    notes: { add: string[]; delete: string[]; detach: string[] };
    categories: { add: string[]; delete: string[] };
  };
  /** The server's versions of the notes whose upload or deletion it refused for being based on an older one. */
  superseded: Json[];
  /** `<queue>:<key>` of the entries refused for good (too large). */
  rejected: string[];
  complete: boolean;
}

/** One page of the change feed: what other devices wrote after this device's cursor. */
export interface Change {
  /** The sequence number of the page's last change: acknowledging it moves the cursor there. */
  token: string;
  /** Identifies the page's content: the device sends it back, and gets `{ same: true }` while it hasn't changed. */
  page: string;
  /** More changes follow the page (they come once it's acknowledged). */
  more: boolean;
  notes: { add: Record<string, Json>; delete: Record<string, Json>; detach: Record<string, Json> };
  categories: { add: Record<string, Json>; delete: Record<string, Json> };
}

export type VaultRead = { status: "present"; vault: Json } | { status: "absent"; vault: null };

export interface Snapshot {
  /** Send it back as `v` to wait for the next change. */
  v: string;
  devices: DeviceView[];
  change: Change | { same: true } | null;
  vault: VaultRead;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

/** An id the app generates (a UUID), or a category icon name. */
export const isKey = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
