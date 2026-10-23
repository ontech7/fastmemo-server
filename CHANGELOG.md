# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

## [1.1.0] - unreleased

### Added

- The running version in the dashboard, and a notice when a newer release is out (checked on GitHub every 6 hours; nothing else
  is sent; `UPDATE_CHECK=off` turns it off). The dashboard shows the release notes, and `/v1/info` carries an optional `update`
  field.
- **One-click updates** through an optional updater on the host (`contrib/updater`). It checks the release and the image again
  by itself, copies the database, switches to the new image pinned by digest, and goes back to the previous image and database
  if the new version is not healthy (or if a power cut interrupts it). SQLite, the same major version and the published image
  only; PostgreSQL and source builds show the commands to run. Build provenance is verified when the GitHub CLI and a token are
  there (`VERIFY_PROVENANCE`). After a rollback the server asks every device for a full sync, so the notes written to the new
  version meanwhile come back.
- Releases are built natively for `linux/amd64` and `linux/arm64`, signed with a build provenance attestation, and published as
  `:1.1.0`, `:1.1`, `:1` and `:latest`, with the notes of this changelog on the GitHub release.
- Tests on every push (SQLite and PostgreSQL), a multi-arch image build, CodeQL and Dependabot.
- `SECURITY.md`: how to report a vulnerability.
- `docker-compose.build.yml` builds the image from the cloned folder.

### Changed

- The compose files run the published image, `ghcr.io/ontech7/fastmemo-server:1` (the newest 1.x), and no longer build it when
  the download fails: use `docker-compose.build.yml` for a build from source. `FASTMEMO_IMAGE` in `.env` pins another one.
- Read the notes of a new major version before moving to it: `:1` never jumps to 2.0 by itself.

### Security

- The container is read-only, without Linux capabilities and without new privileges, and writes only in `/data` and `/tmp`.
- The server never gets the Docker socket: the updater runs on the host as a separate, sandboxed service, reads only a version
  number from the server, and decides everything again.

## [1.0.0] - 2026-10-22

The first stable release: your own sync server for [FastMemo](https://fastmemo.losav.cc). Your devices sync their notes through
it, live, end-to-end encrypted, without anyone else's cloud.

### Added

- End-to-end encrypted sync: notes are encrypted on your devices before they leave them, and the server stores and forwards data
  it can't read (titles, category names and dates are the exception).
- Live sync: an edit reaches your other devices in about a second, with the same rules as FastMemo's Firebase sync (conflicts,
  deletions, offline edits).
- A dashboard in your browser: devices, space used, operations per day, warnings, one-click backups, and "ask every device for a
  full sync" after a restore.
- Limits you choose: `MAX_DEVICES` (10 by default) and `MAX_NOTE_MB` (5 by default). The app reads them from the server: a note
  over the limit stays offline on the device it's on, instead of failing to sync.
- SQLite or PostgreSQL. SQLite, one file, is plenty for a person or a family.
- One Docker image for `linux/amd64` and `linux/arm64`: a PC, a NAS, a VPS or a Raspberry Pi 3, 4 or 5 (64-bit OS).
- Ready-made setups with HTTPS: Tailscale (on the host or in a container), Caddy with your own domain, Cloudflare Tunnel,
  Coolify, and PostgreSQL.
- A setup guide for AI assistants (`docs/AI_SETUP.md`).

### Security

- `FASTMEMO_ACCESS_KEY` is required (16 characters or more): without it the server doesn't start, so a forgotten setting can't
  leave it open. The server never prints or logs it.
- A separate `FASTMEMO_ADMIN_KEY` for the dashboard: left empty, the access key opens it, and every device holds that one.
- Each device gets its own token (the server keeps only its hash); removing a device revokes it at once.
- Wrong keys are limited per address (an IPv6 /64 counts as one) and overall, while connected devices keep syncing.
- Behind a reverse proxy (`TRUST_PROXY=true`), the client's address is trusted only when the request comes from a private
  address.
- The container runs as an unprivileged user and its data is readable by that user only. Without Docker the server listens on
  `127.0.0.1` unless `HOST` says otherwise.
- A request with an invalid target, such as `GET //`, no longer takes the server down.
