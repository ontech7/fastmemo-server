# FastMemo Server protocol (version 1)

The HTTP API the FastMemo app's `ServerBackend` (`fastmemo-app/src/libs/cloud/serverBackend.ts`) speaks. JSON in and out, under
`/v1`. `GET /v1/info` reports `protocol: 1`; a breaking change gets a new number (and a new prefix), and the app refuses a
server whose protocol it doesn't know.

Notes and categories are opaque to the server: it stores the JSON the app sends (the note's content is already encrypted) and
reads only `id` (notes), `icon` (categories) and the revision (`rev`, or `updatedAt` for older notes).

## Authentication

| Header                          | Who                     | Used for                                        |
| ------------------------------- | ----------------------- | ----------------------------------------------- |
| `X-Access-Key: <access key>`    | anyone with the key     | `GET /v1/info`, `POST /v1/devices`              |
| `Authorization: Bearer <token>` | a registered device     | everything else                                 |
| either                          | ("member" routes below) | what the app reads and writes while it connects |
| `Authorization: Bearer <admin>` | the dashboard           | `/admin/api/*`                                  |

- A device token is returned once, by `POST /v1/devices`. The server keeps only its SHA-256. Removing the device revokes it.
- A token the server doesn't know: `401 {"error":"device_unknown"}`. The app treats it as "this device was removed" only when
  the refused token is the one it holds now (a request still carrying a token that a new registration replaced is retried).
- A wrong key: `401 {"error":"unauthorized"}`. After 20 wrong keys in 15 minutes, an address gets `429 {"error":"rate_limited"}`
  for a while (tokens don't count).

Errors are `{"error": "<code>", "message": "<text>"}` with codes `bad_request` / `not_supported` (400), `unauthorized` /
`device_unknown` (401), `forbidden` / `device_limit` (403), `not_found` (404), `too_large` (413), `rate_limited` (429),
`server_error` (500).

## Server

| Request          | Auth | Response                                                                                              |
| ---------------- | ---- | ----------------------------------------------------------------------------------------------------- |
| `GET /v1/health` | none | `{ "ok": true }`                                                                                      |
| `GET /v1/info`   | key  | `{ "server": "fastmemo-server", "version", "protocol": 1, "instance", "maxDevices", "maxNoteBytes" }` |

`instance` changes when the database is new: a different server, or the same one reset. `maxNoteBytes` (`MAX_NOTE_MB`) is the
largest note a push may carry, measured as the UTF-8 bytes of the note's JSON as pushed (encrypted): the app doesn't send a note
over it and makes it device-only instead. An app that doesn't read it gets the note refused (`rejected`) as before.

## Devices

| Request                                 | Auth   | Body / response                                                              |
| --------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `POST /v1/devices`                      | key    | `{ uuid, modelName, brand }` → `201 { token }`; `403 device_limit` when full |
| `GET /v1/devices`                       | member | `{ devices: Device[], maxDevices, maxNoteBytes }`                            |
| `DELETE /v1/devices/:uuid`              | member | `204` (any device may remove any device, as in the app's Manage devices)     |
| `POST /v1/devices/:uuid/last-sync`      | device | `204` (only for itself)                                                      |
| `PUT /v1/devices/:uuid/presence`        | device | `{ noteId: string \| null, at: number }` → `204`                             |
| `POST /v1/devices/:uuid/full-sync-done` | device | `{ due }` → `204`: clears the request unless a newer one came meanwhile      |

Registering the same `uuid` again replaces its token and starts its cursor at the present (a reinstalled app pulls the notes on
its own while connecting). A `Device`:

```json
{
  "uuid": "…",
  "modelName": "Pixel 9",
  "brand": "Google",
  "lastSync": "1792454189439",
  "fullSyncDue": null,
  "devicesToSync": ["<uuid of a device that hasn't pulled this one's changes yet>"],
  "pendingNotes": 0,
  "pendingCategories": 0,
  "presence": { "noteId": "…", "at": 1792454189439 }
}
```

## Sync

The server numbers every change (a sequence, `seq`). Each device has a **cursor**: the last `seq` it applied. Its feed is every
item another device changed after its cursor, latest state only, in `seq` order.

### `GET /v1/sync?v=<version>&wait=<seconds>&p=<page>` (device)

Returns a snapshot:

```json
{
  "v": "a1b2c3d4.17",
  "devices": [],
  "change": {
    "token": "42",
    "page": "…",
    "more": false,
    "notes": { "add": { "<id>": {} }, "delete": { "<id>": {} }, "detach": { "<id>": {} } },
    "categories": { "add": { "<icon>": {} }, "delete": { "<icon>": {} } }
  },
  "vault": { "status": "present", "vault": {} }
}
```

- **Long poll**: with `v` (the `v` of the last snapshot), the request waits until something changes, or `wait` seconds (at most
  50), then answers. Without `v` it answers at once. `v` from before a server restart never matches.
- **`change`** is `null` when the feed is empty. A page holds at most 500 items or about 2 MB (at least one item); `more: true`
  means more follow once this page is acknowledged.
- **`p`**: the `page` of the change the device already has. While the feed's next page is still that one, the server answers
  `"change": { "same": true }` instead of sending it again (pages never repeat across restarts).

### `POST /v1/ack` (device)

`{ "token": "42" }` → `204`. The device applied the page: its cursor moves to `token` (never back, never past the last change).

### `POST /v1/push` (device)

The device's outbox, in one transaction:

```json
{
  "notes": { "add": [Note], "delete": [Stub], "detach": [Stub] },
  "categories": { "add": [Category], "delete": [Category] },
  "bases": { "<note id>": 1792454000000 }
}
```

`bases[id]` is the revision the device's edit started from (its last synced revision).

Rules (the same as the Firebase adapter's):

- **Upload** (`notes.add`): written when the server has no live version, or when its version's revision differs from the
  upload's and is not newer than `bases[id]` (or the upload's revision when there's no base). Otherwise it's **superseded**: the
  server's version comes back in `superseded`, and the app keeps both (a conflict copy).
- **Delete**: refused (superseded) when the server's live version is newer than the delete. The same delete again, or an older
  one, changes nothing.
- **Detach** (a note made device-only): always accepted, even over a newer live version (the note leaves the cloud). The same
  detach again, or an older one, changes nothing.
- **Categories**: written only when different.
- A note larger than `MAX_NOTE_MB` is refused for good: `rejected: ["addNotes:<id>"]`.

```json
{
  "committed": { "notes": { "add": [], "delete": [], "detach": [] }, "categories": { "add": [], "delete": [] } },
  "superseded": [Note],
  "rejected": ["addNotes:<id>"],
  "complete": true
}
```

A request larger than `MAX_BODY_MB` gets `413`: the app splits its outbox and retries. The server reads an oversized body to its
end (up to 4 × the limit) before answering, so a client still uploading gets the `413` rather than a broken connection.

## Vault

The vault is the app's end-to-end encryption metadata (salt, the data key wrapped by the password and by the recovery key). The
server stores it as is.

| Request          | Auth   | Body / response                                                        |
| ---------------- | ------ | ---------------------------------------------------------------------- |
| `GET /v1/vault`  | member | `{ status: "present", vault }` or `{ status: "absent", vault: null }`  |
| `POST /v1/vault` | member | the vault → `201 { result: "created" }`, or `409 { result: "exists" }` |
| `PUT /v1/vault`  | member | the vault → `204` (a password change or a vault reset replaces it)     |

## Data

What the app reads and writes outside the feed (connecting, full sync, vault migration and reset).

| Request                     | Auth   | Body / response                                                              |
| --------------------------- | ------ | ---------------------------------------------------------------------------- |
| `GET /v1/notes?after=<seq>` | member | a page of the live notes, as stored: `{ notes, next }` (see below)           |
| `GET /v1/notes/:id`         | member | one live note, or `404`                                                      |
| `POST /v1/notes/import`     | member | `{ notes: [Note] }` → `204`: written as they are, no guard (vault migration) |
| `DELETE /v1/notes`          | member | `204`: every note and deletion marker removed (vault reset)                  |
| `GET /v1/tombstones`        | member | `{ "<id>": { rev, detach?: true } }`: the deletion markers                   |
| `POST /v1/tombstones/prune` | member | `{ ids: [...] }` → `{ removed }` (see below)                                 |
| `GET /v1/categories`        | member | every category, by `order`                                                   |
| `POST /v1/categories/reset` | member | `{ category }` → `204`: every category removed but this one                  |

`GET /v1/notes` pages by `seq`: start with `after=0` and pass each answer's `next` as the next `after`, until `next` is `null`.
A page holds at most 500 notes or about 8 MB (at least one note); `bytes=<n>` asks for smaller pages (a slow link), never
larger. A note changed while the pages are read comes again in a later page, newer: the last one read wins.

A deletion marker is pruned only when every device has read past it (it's how they learn of the deletion) and it's older than
200 days; the ids that don't qualify yet are left alone. With no device registered, every marker is past everyone.

## Dashboard API

`Authorization: Bearer <admin key>`.

| Request                                   | Response                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/api/overview`                 | server info, counts, devices (with cursor, last seen, behind), 30 days of operation counts, the last 100 warnings and errors |
| `DELETE /admin/api/devices/:uuid`         | `204`: the device is removed, its token stops working                                                                        |
| `POST /admin/api/devices/:uuid/full-sync` | `204`: the device runs a full sync on its next sync                                                                          |
| `POST /admin/api/full-sync`               | `{ devices }`: every device runs one                                                                                         |
| `GET /admin/api/backup`                   | the SQLite database, consistent (`VACUUM INTO`); `400` on PostgreSQL                                                         |
