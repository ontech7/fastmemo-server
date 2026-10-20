# FastMemo Server

Your own sync server for [FastMemo](https://fastmemo.vercel.app). Run it on your PC, a NAS, a Raspberry Pi or a VPS, and your
devices keep their notes in sync through it: live, end-to-end encrypted, and without anyone else's cloud.

- **Private.** Notes are encrypted on your devices before they leave them. The server stores them, it can't read them.
- **Live.** An edit shows up on your other devices in about a second.
- **Offline-proof.** A device that can't reach the server keeps its changes and sends them when it can.
- **Small.** One Docker container, one database file. A Raspberry Pi is plenty.
- **With a dashboard.** Devices, space, reads, writes and deletes per day, warnings, one-click backups.

> Prefer not to run a server? FastMemo also syncs through your own Google Firebase project: see the
> [Firebase guide](https://fastmemo.vercel.app/en/guides/google-firebase/).

---

## Contents

1. [Try it on your computer (5 minutes)](#1-try-it-on-your-computer-5-minutes)
2. [Make it reachable from your phone: HTTPS](#2-make-it-reachable-from-your-phone-https)
3. [Connect the app](#3-connect-the-app)
4. [The dashboard](#4-the-dashboard)
5. [Raspberry Pi](#5-raspberry-pi)
6. [Coolify](#6-coolify)
7. [A VPS with a domain (Caddy)](#7-a-vps-with-a-domain-caddy)
8. [Backups and restore](#8-backups-and-restore)
9. [Updating](#9-updating)
10. [Settings](#10-settings)
11. [PostgreSQL instead of SQLite](#11-postgresql-instead-of-sqlite)
12. [Troubleshooting](#12-troubleshooting)
13. [Security](#13-security)
14. [How it works](#14-how-it-works)
15. [Development](#15-development)

---

## 1. Try it on your computer (5 minutes)

You need [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on Windows and macOS). Then, in a terminal:

```sh
git clone https://github.com/ontech7/fastmemo-server.git
cd fastmemo-server
cp .env.example .env
docker compose up -d
```

That's it: the server is running on port **8787**. Find your **access key**, the password your devices use to connect:

```sh
docker compose logs fastmemo
```

```
  No FASTMEMO_ACCESS_KEY is set: this server generated one (it stays the same across restarts).
  ...
      p7J2k...your key...Qz
```

Keep it somewhere safe (a password manager). Prefer to choose it yourself? Put it in `.env` as `FASTMEMO_ACCESS_KEY=...` (16
characters or more; `openssl rand -base64 24` makes a good one) and run `docker compose up -d` again.

Open **http://localhost:8787** in a browser and enter the key: that's the dashboard.

To stop it: `docker compose down` (your notes stay, in a Docker volume). To start it again: `docker compose up -d`.

## 2. Make it reachable from your phone: HTTPS

Your devices need to reach the server, and **phones only talk to `https://` addresses** (so does the web app at
fastmemo.vercel.app). Pick one of these, from the easiest:

| Option                                    | Good for                                   | What you need                   |
| ----------------------------------------- | ------------------------------------------ | ------------------------------- |
| **[Tailscale](#tailscale-easiest)**       | Your devices only, no domain, nothing open | A free Tailscale account        |
| **[Coolify](#6-coolify)**                 | You already run Coolify                    | Coolify and a domain            |
| **[Caddy](#7-a-vps-with-a-domain-caddy)** | A VPS, or a home server with ports 80/443  | A domain pointing to the server |
| Plain `http://`                           | Trying it out from the computer it runs on | Nothing (not for phones)        |

### Tailscale (easiest)

[Tailscale](https://tailscale.com) links your devices in a private network, with a real HTTPS address and nothing exposed to the
internet.

1. Install Tailscale on the server and on each device (phone, PC), and sign in with the same account.
2. On the server, run:

   ```sh
   sudo tailscale serve --bg 8787
   ```

   It prints the address, like `https://raspberrypi.your-tailnet.ts.net`. That's your server address.

(If it asks to enable HTTPS certificates or MagicDNS, follow the link it prints: it's one click in the Tailscale admin.)

## 3. Connect the app

On **each** device:

1. FastMemo → **Settings → Cloud Sync**, and turn on **Enable Cloud sync**.
2. **Sync with: FastMemo Server**.
3. **Server address**: your `https://...` address (or `http://localhost:8787` to try it on the same computer).
4. **Access key**: the key from step 1.
5. **Save settings**.

The **first** device asks you to choose an **encryption password**, and then shows a **recovery key**: write it down. Every
other device asks for that same password. The password never reaches the server: lose both the password and the recovery key,
and nobody (not you, not us, not the server) can read the notes again.

Every device you connect shows up in **Settings → Cloud Sync → Manage devices** and in the dashboard.

## 4. The dashboard

Open the server's address in a browser and enter the admin key (`FASTMEMO_ADMIN_KEY`, or the access key when you didn't set
one). You see:

- **Notes, devices, space**: how many notes, how big, how many devices out of the maximum.
- **Operations per day**, for the last 30 days: reads, writes and deletes, counted the way Firestore counts them.
- **Devices**: when each one last synced, whether it has a note open, and how many changes it hasn't pulled yet. From here you
  can **remove** a device (lost phone: its access stops at once) or ask it for a **full sync**.
- **Backup**: one click downloads the whole database.
- **Recent warnings and errors**: wrong keys, refused requests, problems.

## 5. Raspberry Pi

Any Raspberry Pi 3, 4 or 5 with the **64-bit** Raspberry Pi OS works.

1. Install Docker:

   ```sh
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER   # then log out and back in
   ```

2. Follow [step 1](#1-try-it-on-your-computer-5-minutes) on the Pi.
3. Make it reachable over HTTPS: [Tailscale](#tailscale-easiest) is the simplest, or Coolify if you run it.

The container restarts on its own after a reboot or a power cut (`restart: unless-stopped`).

## 6. Coolify

1. In Coolify: **+ New → Public Repository** (or your fork), and paste the repository URL.
2. **Build Pack: Docker Compose**, **Docker Compose Location: `/docker-compose.coolify.yml`**.
3. **Domains** for the `fastmemo` service: `https://notes.example.com:8787` (the `:8787` tells Coolify the container's port;
   people still connect on the normal HTTPS port).
4. **Deploy**.

Coolify generates the keys on the first deploy: find them under **Environment Variables** (`SERVICE_PASSWORD_64_ACCESSKEY` is
the access key, `SERVICE_PASSWORD_64_ADMINKEY` opens the dashboard). Coolify takes care of the HTTPS certificate.

## 7. A VPS with a domain (Caddy)

For a VPS (or a home server with ports 80 and 443 forwarded) and a domain whose DNS points to it:

```sh
cp .env.example .env    # set DOMAIN=notes.example.com and FASTMEMO_ACCESS_KEY
docker compose -f docker-compose.caddy.yml up -d
```

[Caddy](https://caddyserver.com) gets and renews the HTTPS certificate by itself. Your server address is
`https://notes.example.com`.

## 8. Backups and restore

**Back up**: in the dashboard, **Download a backup**: a single `.db` file with everything. The notes in it stay encrypted, so
you can keep it anywhere.

From the command line (for a cron job):

```sh
curl -fsS -H "Authorization: Bearer $FASTMEMO_ADMIN_KEY" http://localhost:8787/admin/api/backup -o fastmemo-$(date +%F).db
```

**Restore**:

```sh
docker compose down
docker run --rm -v fastmemo-server_fastmemo-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -f /data/fastmemo.db-wal /data/fastmemo.db-shm && cp /backup/fastmemo-2026-10-20.db /data/fastmemo.db && chown 1000:1000 /data/fastmemo.db'
docker compose up -d
```

Then, in the dashboard, **Ask every device for a full sync**: each device compares all its notes with the server's, so whatever
changed after the backup comes back from the devices.

(The volume is called `<folder name>_fastmemo-data`: `docker volume ls` shows it.)

## 9. Updating

```sh
git pull
docker compose up -d --build
```

The database is upgraded on start when needed. A newer database is never opened by an older server: it refuses to start instead
of guessing.

## 10. Settings

All settings are environment variables, in `.env` (or in Coolify's Environment Variables).

| Variable              | Default                  | What it does                                                                      |
| --------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `FASTMEMO_ACCESS_KEY` | generated on first start | The key devices use to connect. At least 16 characters.                           |
| `FASTMEMO_ADMIN_KEY`  | the access key           | Opens the dashboard. Set it to keep the dashboard separate from the devices' key. |
| `PORT`                | `8787`                   | The port on your computer (in the container it's always 8787).                    |
| `TZ`                  | `UTC`                    | Your time zone (e.g. `Europe/Rome`): the dashboard counts days in it.             |
| `MAX_DEVICES`         | `10`                     | How many devices can connect.                                                     |
| `MAX_NOTE_MB`         | `5`                      | The largest note (pictures make notes big).                                       |
| `MAX_BODY_MB`         | `64`                     | The largest request.                                                              |
| `TRUST_PROXY`         | `false`                  | `true` behind Caddy, nginx, Traefik, Coolify or Tailscale Serve.                  |
| `LOG_LEVEL`           | `info`                   | `debug`, `info`, `warn` or `error`.                                               |
| `DATABASE_URL`        | SQLite in `/data`        | `postgres://user:password@host:5432/db` for PostgreSQL.                           |

## 11. PostgreSQL instead of SQLite

SQLite is plenty for a person or a family, and a backup is one file. If you'd rather use PostgreSQL:

```sh
cp .env.example .env    # set POSTGRES_PASSWORD (letters and digits) and FASTMEMO_ACCESS_KEY
docker compose -f docker-compose.postgres.yml up -d
```

Or point `DATABASE_URL` at a PostgreSQL you already run. Back it up with `pg_dump` (the dashboard's backup button is for
SQLite).

## 12. Troubleshooting

**The app says it couldn't reach the server, or that the key is wrong.**

- Open the server address in the phone's browser: you should see the dashboard's login page. If not, the phone can't reach the
  server (Tailscale off? wrong address? firewall?).
- Phones need `https://` (see [step 2](#2-make-it-reachable-from-your-phone-https)).
- Check the key: `docker compose logs fastmemo` shows it if it was generated.

**"Too many attempts".** After 20 wrong keys in 15 minutes from the same address, the server waits before accepting more. Wait a
few minutes and check the key.

**"Devices limit exceeded".** Remove a device you don't use any more (dashboard, or the app's Manage devices), or raise
`MAX_DEVICES`.

**A device was offline for a long time.** It catches up on its own when it's back. If something looks off, the dashboard's
**Full sync** on that device makes it compare everything.

**The dashboard shows "Unreachable".** The server stopped: `docker compose ps` and `docker compose logs fastmemo`.

## 13. Security

- **Notes** are encrypted on your devices (AES, with a key derived from your encryption password). The server, its database, its
  backups and its logs never contain a readable note. **Titles** are not encrypted (the app sorts by them).
- **The access key** lets a device join. Each device then gets its own token: removing a device revokes it at once.
- **Over plain `http://`** the key and the titles travel unencrypted: use it only to try things out on your own computer or home
  network. For anything else, use HTTPS.
- **Wrong keys** are counted and slowed down per address, and logged in the dashboard.
- The container runs as an unprivileged user, and only writes to its `/data` volume.

## 14. How it works

The server keeps one table of items (notes and categories), each with the revision the devices gave it and a sequence number
from a counter. Every change takes the next number. Each device has a **cursor**, the last number it has seen: to sync, it asks
for what's past its cursor (its own changes excluded) and moves the cursor when it has applied them. A device waits for changes
with a long poll (an HTTP request that answers as soon as something changes, or after 25 seconds), so an edit reaches the other
devices in about a second without WebSockets.

When a device sends a change, the server applies the same rules as FastMemo's Firebase sync: a note edited on two devices before
they synced is kept twice (the app makes a copy), a delete never undoes a newer edit, and a change the server already has is not
written again. Deleted notes leave a small marker so the other devices learn about it; markers are dropped once every device has
seen them and they're old enough.

The API is described in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## 15. Development

Node.js 22.18 or newer runs the TypeScript sources directly (no build step).

```sh
npm install
npm run dev          # restarts on changes; data in ./data
npm test             # SQLite
TEST_DATABASE_URL=postgres://... npm run test:pg
npm run typecheck
```

The app's integration tests (`fastmemo-app/scripts/sync-server.test.mjs`) start this server from `../fastmemo-server` and run
the app's sync engine against it.

## License

[AGPL-3.0](LICENSE)
