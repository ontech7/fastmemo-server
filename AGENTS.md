# FastMemo Server - AI Agent Instructions

> **Read this file first.** It is the entry point for all AI agents working on the FastMemo server.
>
> **Here to install or deploy the server** (not to change its code)? Follow [docs/AI_SETUP.md](docs/AI_SETUP.md) instead.

## Project Summary

The self-hosted sync server for FastMemo: devices sync their (end-to-end encrypted) notes through it with a change feed and long
polling, plus an ops dashboard. Node.js ≥ 24 running the TypeScript sources directly (type stripping, no build), `node:http`
with no framework, SQLite (`node:sqlite`) by default or PostgreSQL (`pg`). One Docker image.

The app side is `fastmemo-app/src/libs/cloud/serverBackend.ts` (the `CloudBackend` that speaks this API). The API is documented
in [docs/PROTOCOL.md](docs/PROTOCOL.md); the user guide is the [README](README.md), with the details in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

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
  updates.ts    -> the release check against GitHub, the updater's status file, install requests (a version number in a folder)
  auth.ts, config.ts, log.ts, model.ts
  store/        -> db.ts (Sql/Database, write mutex), sqlite.ts, postgres.ts (? -> $n), schema.ts (migrations)
public/         -> the dashboard (vanilla JS module, strict CSP)
contrib/updater/ -> the optional host updater (Python, runs as root under systemd): checks the release and the image again,
                   copies the database, switches the image pinned by digest, rolls back. Units, compose overlay, updater.env.example
test/           -> node:test suites (helpers.ts: TEST_DATABASE_URL runs them on Postgres)
docs/           -> PROTOCOL.md (the API), DEPLOYMENT.md (setups, backups, troubleshooting), AI_SETUP.md (the install
                   runbook for AI assistants: keep it in step with the README), images/ (README screenshot)
CHANGELOG.md, SECURITY.md -> the release notes (also the GitHub release's text), how to report a vulnerability
.github/        -> dependabot.yml; workflows/ci.yml (SQLite, PostgreSQL, image build on every push and PR), codeql.yml;
                   workflows/release.yml: a v* tag (matching package.json, with a CHANGELOG.md section) tests, builds both
                   architectures natively, publishes ghcr.io/ontech7/fastmemo-server with signed provenance, opens the release
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
8. **Never let a request throw outside the handler's `try`** (parsing the URL included): an unhandled rejection exits Node.
   Before 1.0.0 a plain `GET //`, with no key, took the server down.
9. **Never load a file or a database dump into memory to send it**: stream it (`Reply.file`). A backup can be bigger than a
   Raspberry Pi's memory.
10. **Never trust `X-Forwarded-For` from a public address**: only a proxy (a private address) may set the client's address, or a
    client picks its own and dodges the wrong-key limit.
11. **Never give the container the Docker socket** (or any way to run Docker). The server only leaves a version number in a
    folder; the updater, a separate service on the host, decides everything again. Nothing the server wrote is echoed back to
    it.
12. **Never make a 1.x release that needs more than the image to change.** The updater switches the image line of `.env` and
    starts the same compose files, so a 1.x release must start with any earlier 1.x's compose files and `.env`. If it can't, it
    is 2.0 (a new major, updated by hand). Keep `release.yml`'s path and the image's name and labels: the updater verifies them.

### ALWAYS

1. **Always run** `npm run typecheck` and `npm test` (and `npm run test:pg` with `TEST_DATABASE_URL` when touching SQL), then
   the app's `node scripts/sync-server.test.mjs` when the API or the guard changes.
2. **Always write SQL both drivers run**: `?` placeholders (translated for Postgres), no driver-only syntax.
3. **Always go through `db.write()`** for writes (one transaction, serialized) and bump the hub (`changed()`) after a write
   devices can see.
4. **Always count operations** in `stats` (reads, writes, deletes) the way Firestore would bill them.
5. **Always keep the README's ELI5 tone**: short, plain steps a non-developer can follow, every command tested. Long detail goes
   in `docs/DEPLOYMENT.md`.
6. **Always give a test that starts its own server its own `describe`**: on Postgres the tests share one database, which every
   new test server empties (a server started inside another suite wipes that suite's data).
7. **Always write a `### Security` entry** in the changelog section of a release for every security fix, with a regression test
   in `test/hardening.test.ts`: the dashboard marks a release with that section as a security update.
8. **Always write the release's `## [x.y.z]` section in `CHANGELOG.md` before tagging**: `release.yml` refuses a tag without it,
   and its text becomes the GitHub release's notes. Keep `## [x.y.z] - unreleased` until the day it is tagged.

## Commands

```sh
npm run dev | npm start | npm test | npm run test:pg | npm run typecheck | npm run format
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build   # built from source, SQLite
# a release: commit CHANGELOG.md first (the "## [1.2.3]" section, its date replacing "unreleased"; npm version needs a clean
# tree), then the v* tag publishes the image and the GitHub release
npm version 1.2.3 -m "chore: release v%s" && git push --follow-tags
```

## Subagents

- `protocol-guard` (`.claude/agents/`): before committing a change to the API, the push guard, the schema or the dashboard, it
  checks the rules above against the app's side and runs both test suites.
