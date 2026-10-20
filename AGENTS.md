# FastMemo Server - AI Agent Instructions

> **Read this file first.** It is the entry point for all AI agents working on the FastMemo server.

## Project Summary

The self-hosted sync server for FastMemo: devices sync their (end-to-end encrypted) notes through it with a change feed and long
polling, plus an ops dashboard. Node.js ≥ 22.18 running the TypeScript sources directly (type stripping, no build), `node:http`
with no framework, SQLite (`node:sqlite`) by default or PostgreSQL (`pg`). One Docker image.

The app side is `fastmemo-app/src/libs/cloud/serverBackend.ts` (the `CloudBackend` that speaks this API). The API is documented
in [docs/PROTOCOL.md](docs/PROTOCOL.md); the user guide is the [README](README.md).

## Layout

```
src/
  main.ts       -> entry: config, database, migrations, timers (stats flush, hourly maintenance), graceful shutdown
  app.ts        -> createApp(): wires service, hub, stats, auth (authenticate()), routes
  routes.ts     -> the /v1 API (PROTOCOL = 1)
  admin.ts      -> the dashboard: static files from public/ + /admin/api
  service.ts    -> all the logic: devices, feed, push guard, vault, data, maintenance, overview
  hub.ts        -> long-poll versions (boot.counter) and waiters
  http.ts       -> router, JSON bodies with a size limit, gzip, CORS, errors
  stats.ts      -> daily counters (buffered, flushed every 10 s), local-time days
  auth.ts, config.ts, log.ts, model.ts
  store/        -> db.ts (Sql/Database, write mutex), sqlite.ts, postgres.ts (? -> $n), schema.ts (migrations)
public/         -> the dashboard (vanilla JS module, strict CSP)
test/           -> node:test suites (helpers.ts: TEST_DATABASE_URL runs them on Postgres)
docs/           -> PROTOCOL.md
```

## Rules

### NEVER

1. **Never install dependencies** without the developer's approval (the image ships `pg` only).
2. **Never break the protocol**: `/v1` stays compatible with every app version that speaks it. Add optional fields; anything
   else is a new protocol number (and the app refuses servers it doesn't know).
3. **Never edit an applied migration** in `store/schema.ts`: add a new one. A server refuses a database newer than it.
4. **Never diverge from the Firebase adapter's merge rules** (`fastmemo-app/src/libs/cloud/firebaseBackend.ts`, `merge.ts`): the
   push guard must decide exactly like it. `fastmemo-app/scripts/sync-server.test.mjs` checks the pair.
5. **Never log or record note contents or keys** (events end up in the dashboard). Titles and ids are fine.
6. **Never put inline scripts or styles** in `public/`: the CSP forbids them. Values from devices go in with `textContent`,
   never `innerHTML`.
7. **Never read a path from the URL off the disk**: the dashboard serves only the files loaded from `public/` at start.

### ALWAYS

1. **Always run** `npm run typecheck` and `npm test` (and `npm run test:pg` with `TEST_DATABASE_URL` when touching SQL), then
   the app's `node scripts/sync-server.test.mjs` when the API or the guard changes.
2. **Always write SQL both drivers run**: `?` placeholders (translated for Postgres), no driver-only syntax.
3. **Always go through `db.write()`** for writes (one transaction, serialized) and bump the hub (`changed()`) after a write
   devices can see.
4. **Always count operations** in `stats` (reads, writes, deletes) the way Firestore would bill them.
5. **Always keep the README's ELI5 tone**: steps a non-developer can follow, every command tested.
6. **Always give a test that starts its own server its own `describe`**: on Postgres the tests share one database, which every
   new test server empties (a server started inside another suite wipes that suite's data).

## Commands

```sh
npm run dev | npm start | npm test | npm run test:pg | npm run typecheck | npm run format
docker compose up -d --build   # the image, SQLite
```
