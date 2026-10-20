<div align="center">

<img width="600" height="114" alt="FastMemo" src="https://github.com/user-attachments/assets/2b91e421-2c6b-4739-bb16-1220bd591667" />

# FastMemo Server

**Your own sync server for FastMemo: end-to-end encrypted notes, live sync between your devices, and a dashboard. One Docker
container.**

![Docker](https://badgen.net/badge/Docker/amd64%20%C2%B7%20arm64/blue)
![Database](https://badgen.net/badge/Database/SQLite%20%C2%B7%20PostgreSQL/blue)
![Protocol](https://badgen.net/badge/Protocol/v1/blue) ![License](https://badgen.net/badge/License/AGPL-3.0/grey)

[Quick start](#quick-start) | [Deployment guide](docs/DEPLOYMENT.md) | [Protocol](docs/PROTOCOL.md) |
[Report Bug](https://github.com/ontech7/fastmemo-server/issues)

---

If you find this project useful, consider [buying me a coffee](https://www.buymeacoffee.com/ontech7)! ☕

<img width="1280" alt="The FastMemo Server dashboard: notes, devices, operations per day" src="docs/images/dashboard.png" />

</div>

Run it on a PC, a NAS, a Raspberry Pi or a VPS, and your [FastMemo](https://fastmemo.vercel.app) devices sync their notes
through it, live, without anyone else's cloud. Notes are encrypted on your devices, so the server only stores data it can't read
(titles are the exception: see [Security](#security)). One Docker container, one database file, and a dashboard in your browser.

Rather not run a server? FastMemo also syncs through your own Firebase project: see the
[Firebase guide](https://fastmemo.vercel.app/en/guides/google-firebase/).

## Table of Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Connect the app](#connect-the-app)
- [HTTPS](#https)
- [Other setups](#other-setups)
- [Configuration](#configuration)
- [Backups and restore](#backups-and-restore)
- [Updating](#updating)
- [Security](#security)
- [Development](#development)

## How it works

```mermaid
flowchart LR
  subgraph devices["FastMemo app"]
    phone["Android"]
    desktop["Desktop<br/>macOS · Windows · Linux"]
    web["Web app"]
  end
  browser["A browser<br/>(you, with the admin key)"]

  subgraph host["Your PC, NAS, Pi or VPS"]
    https["HTTPS<br/>Tailscale · Caddy · Coolify"]
    server["fastmemo-server<br/>sync API + dashboard<br/>(one Docker container)"]
    db[("SQLite file<br/>or PostgreSQL")]
  end

  phone & desktop & web -- "encrypted notes" --> https
  browser -- "admin key" --> https
  https --> server --> db
```

Notes are encrypted on your devices before they leave them: the server stores and forwards data it can't read. A device joins
with the **access key** and gets its own token. Every change gets the next number; each device remembers the last one it applied
and waits for the next with a long poll, so an edit reaches the other devices in about a second:

```mermaid
sequenceDiagram
  participant P as Phone
  participant S as fastmemo-server
  participant L as Laptop
  L->>S: GET /v1/sync (long poll: waits for a change)
  P->>P: edit a note, encrypt it
  P->>S: POST /v1/push
  S->>S: same rules as the Firebase sync, next change number
  S-->>P: committed
  S-->>L: the long poll answers with the change
  L->>L: decrypt it, apply it
  L->>S: POST /v1/ack (done up to this change)
```

More in [How sync works](docs/DEPLOYMENT.md#how-sync-works); the API is in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Quick start

You need [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on Windows and macOS). In a terminal:

```sh
git clone https://github.com/ontech7/fastmemo-server.git
cd fastmemo-server
cp .env.example .env
docker compose up -d
docker compose logs fastmemo
```

The server now runs on port **8787**, from the image `ghcr.io/ontech7/fastmemo-server`. The logs show the **access key**, the
password your devices connect with: keep it in a password manager. To choose your own, set `FASTMEMO_ACCESS_KEY` in `.env` (16
characters or more, for example from `openssl rand -base64 24`) and run `docker compose up -d` again.

Open http://localhost:8787 and enter the key to see the dashboard: devices, space used, operations per day, warnings, backups.
`docker compose down` stops the server. Your notes stay in a Docker volume.

## Connect the app

Set up [HTTPS](#https) first: the web app and the Windows desktop app only reach `https://` addresses. To try it on the computer
that runs the server, `http://localhost:8787` is enough. Then, on each device:

1. Open **Settings → Cloud Sync** and turn on **Enable Cloud sync**.
2. In **Sync with**, choose **FastMemo Server**.
3. Enter the **Server address** and the **Access key**, then tap **Save settings**.

The first device asks you to choose an **encryption password** and shows a **recovery key**: write it down. The other devices
ask for the same password. It never reaches the server. Lose both the password and the recovery key, and nobody can read the
notes.

## HTTPS

Use HTTPS. The web app and the Windows desktop app only connect to `https://` addresses. The Android and macOS apps also accept
`http://`, after a warning: over plain HTTP anyone on the network can read the access key and the note titles, and with the key
join your server. Plain HTTP only makes sense on a home network you trust.

### Tailscale (easiest)

[Tailscale](https://tailscale.com) gives the server an HTTPS address in a private network: no domain, nothing open to the
internet.

1. Install Tailscale on the server and on every device, and sign in with the same account.
2. On the server, run `sudo tailscale serve --bg 8787`. It prints your address, like `https://raspberrypi.your-tailnet.ts.net`.
3. Set `TRUST_PROXY=true` in `.env` and run `docker compose up -d`.

### Your own domain (Caddy)

You need a domain that points to the server, and ports 80 and 443 open. Set `DOMAIN=notes.example.com` in `.env`, then run
`docker compose -f docker-compose.caddy.yml up -d`. Caddy gets the certificate, and your address is `https://notes.example.com`.

## Other setups

- **Raspberry Pi** 3, 4 or 5 with the **64-bit** Raspberry Pi OS: the image is built for arm64 too. Install Docker
  (`curl -fsSL https://get.docker.com | sh`, then `sudo usermod -aG docker $USER` and log in again), then follow the
  [Quick start](#quick-start).
- **PostgreSQL**: set `POSTGRES_PASSWORD` in `.env` and run `docker compose -f docker-compose.postgres.yml up -d`, or point
  `DATABASE_URL` at your own PostgreSQL. SQLite is plenty for a person or a family.
- **Coolify**: deploy this repository with the **Docker Compose** build pack and `/docker-compose.coolify.yml`, on a domain like
  `https://notes.example.com:8787`. Coolify handles HTTPS and generates the keys.
- **Without Docker**, with Node.js 22.18 or newer: `npm ci --omit=dev`, then
  `node --env-file=.env --disable-warning=ExperimentalWarning src/main.ts`.

Step by step, and troubleshooting: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Configuration

Settings go in `.env` (on Coolify, in Environment Variables). Run `docker compose up -d` after a change.

| Variable              | Default        | What it does                                                                         |
| --------------------- | -------------- | ------------------------------------------------------------------------------------ |
| `FASTMEMO_ACCESS_KEY` | generated      | The key devices connect with. At least 16 characters.                                |
| `FASTMEMO_ADMIN_KEY`  | the access key | Opens the dashboard.                                                                 |
| `PORT`                | `8787`         | The port on your computer. With Docker, `127.0.0.1:8787` hides it from your network. |
| `TZ`                  | `UTC`          | The time zone the dashboard counts days in.                                          |
| `MAX_DEVICES`         | `10`           | How many devices can connect.                                                        |
| `MAX_NOTE_MB`         | `5`            | The largest note, in MB.                                                             |
| `MAX_BODY_MB`         | `64`           | The largest request, in MB.                                                          |
| `TRUST_PROXY`         | `false`        | `true` behind Tailscale Serve, Caddy, nginx, Traefik or Coolify.                     |
| `LOG_LEVEL`           | `info`         | `debug`, `info`, `warn` or `error`.                                                  |
| `DATABASE_URL`        | SQLite         | `postgres://user:password@host:5432/db` for PostgreSQL.                              |
| `DATA_DIR`            | `./data`       | Without Docker: where the SQLite file goes (the image uses `/data`).                 |
| `HOST`                | `0.0.0.0`      | Without Docker: the address to listen on.                                            |
| `POSTGRES_PASSWORD`   |                | Only for `docker-compose.postgres.yml`.                                              |
| `DOMAIN`              |                | Only for `docker-compose.caddy.yml`.                                                 |

## Backups and restore

Back up from the dashboard (**Download a backup**), or from a script, with the admin key in `FASTMEMO_ADMIN_KEY`:

```sh
curl -fsS -H "Authorization: Bearer $FASTMEMO_ADMIN_KEY" http://localhost:8787/admin/api/backup -o fastmemo-$(date +%F).db
```

Keep backups private: the notes in them are encrypted, but the titles, the device list and a generated access key are not.

To restore, put the backup in the server's folder and use its name in place of `fastmemo-2026-10-20.db`:

```sh
docker compose down
docker run --rm -v fastmemo-server_fastmemo-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -f /data/fastmemo.db-wal /data/fastmemo.db-shm && cp /backup/fastmemo-2026-10-20.db /data/fastmemo.db && chown 1000:1000 /data/fastmemo.db'
docker compose up -d
```

Then click **Ask every device for a full sync** in the dashboard: the devices send back what changed after the backup. The
volume is `<folder name>_fastmemo-data` (`docker volume ls` lists it). For PostgreSQL, see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#backups).

## Updating

```sh
git pull
docker compose pull
docker compose up -d
```

With another compose file, add `-f <file>` to each command. `docker compose up -d --build` builds from source instead. The
database is upgraded on start.

## Security

- **Encrypted on your devices:** the contents of your notes (text, checklists, kanban cards, code).
- **Not encrypted:** note titles, category names, kanban column names, device names, dates and note types. The server stores
  them as they are.
- **The access key** lets a device join. Whoever has it can download the encrypted notes, remove devices or wipe the server's
  copy, but can't read the notes without the encryption password.
- **Wrong keys** are logged. An address that fails 20 times in 15 minutes is refused for a while.

### Lost device or leaked key

- **Lost or stolen device:** remove it in the dashboard, or in the app (**Settings → Cloud Sync → Manage devices**). Its access
  stops at once.
- **Leaked access key:** set a new `FASTMEMO_ACCESS_KEY` and run `docker compose up -d`. New devices then need the new key, but
  connected devices keep working, so also remove any device you don't recognize.
- **Encryption password:** change it in the app (**Settings → Cloud Sync → Change password**). The server never sees it.

## Development

The API is in [docs/PROTOCOL.md](docs/PROTOCOL.md). Node.js 22.18 or newer runs the TypeScript sources directly, with no build.

```sh
npm install
npm run dev         # restarts on changes, data in ./data
npm test            # SQLite
npm run typecheck
TEST_DATABASE_URL=postgres://user:password@localhost:5432/test npm run test:pg   # drops that database's tables
```

Pushing a `v*` tag publishes the image (`.github/workflows/docker.yml`).

## License

[AGPL-3.0](LICENSE)
