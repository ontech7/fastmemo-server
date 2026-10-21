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

Run it on a PC, a NAS, a Raspberry Pi or a VPS, and your [FastMemo](https://fastmemo.losav.cc) devices sync their notes through
it, live, without anyone else's cloud. Notes are encrypted on your devices, so the server only stores data it can't read (titles
are the exception: see [Security](#security)). One Docker container, one database file, and a dashboard in your browser.

Rather not run a server? FastMemo also syncs through your own Firebase project: see the
[Firebase guide](https://fastmemo.losav.cc/en/guides/google-firebase/).

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
    https["HTTPS<br/>Tailscale · Caddy · Cloudflare · Coolify"]
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
```

Open `.env` and set `FASTMEMO_ACCESS_KEY`: the **access key**, the password your devices connect with (16 characters or more).
Make a random one with `openssl rand -hex 24` (macOS, Linux) or, on any computer with Docker,
`docker run --rm node:24-alpine node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. Keep it in a password
manager: the server never shows it, and without it the server doesn't start. Then:

```sh
docker compose up -d
docker compose logs fastmemo
```

The server now runs on port **8787**, from the image `ghcr.io/ontech7/fastmemo-server`.

Open http://localhost:8787 and enter the key to see the dashboard: devices, space used, operations per day, warnings, backups.
`docker compose down` stops the server. Your notes stay in a Docker volume.

### With an AI assistant

Using Claude Code, Cursor, Codex or a similar assistant with a terminal? Give it this, on the machine that will run the server:

```text
Install FastMemo Server for me, following
https://raw.githubusercontent.com/ontech7/fastmemo-server/main/docs/AI_SETUP.md
```

It asks where the server runs and how your devices reach it, sets it up with HTTPS, checks that it works, and gives you the
address and the key.

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

Use HTTPS. The web app and the Windows desktop app only connect to `https://` addresses (or to a server on the same computer).
The Android, macOS and Linux apps also accept `http://`, after a warning. Over plain HTTP, what a device sends isn't encrypted
on any network it joins, not only at home: a phone set up on your Wi-Fi keeps talking to that address from a café's. Whoever can
see that traffic can read the note titles and the device's credentials, and with them change or delete notes and remove devices;
the notes' content stays end-to-end encrypted. The access key only travels when a device connects; after that each device uses
its own token. If you think one was seen, change the access key and remove and re-add each device: a device's token keeps
working after a key change.

### Tailscale (easiest)

[Tailscale](https://tailscale.com) gives the server an HTTPS address in a private network: no domain, nothing open to the
internet.

1. Install Tailscale on the server and on every device, and sign in with the same account.
2. On the server, run `sudo tailscale serve --bg 8787`. It prints your address, like `https://raspberrypi.your-tailnet.ts.net`.
3. Set `TRUST_PROXY=true` in `.env` and run `docker compose up -d`.

**Can't install Tailscale on the server** (a NAS, for example)? Run it in a container next to the server instead. Turn on
**HTTPS Certificates** in the Tailscale admin (**DNS** page), then:

```sh
docker compose -f docker-compose.tailscale.yml up -d
docker compose -f docker-compose.tailscale.yml logs tailscale
```

Open the link after `To authenticate, visit:` and sign in. Your address is `https://fastmemo.your-tailnet.ts.net`.

**A device without Tailscale** (the web app on a computer that isn't yours)? `sudo tailscale funnel --bg 8787` makes the same
address public, on the internet. Anyone can then reach the server, so use a long access key. To make it private again:
`sudo tailscale funnel reset`, then `sudo tailscale serve --bg 8787`.

### Your own domain (Caddy)

You need a domain that points to the server, and ports 80 and 443 open. Set `DOMAIN=notes.example.com` in `.env`, then run
`docker compose -f docker-compose.caddy.yml up -d`. Caddy gets the certificate, and your address is `https://notes.example.com`.

### Your own domain, no open ports (Cloudflare Tunnel)

You need a domain on [Cloudflare](https://www.cloudflare.com) (the free plan is enough). Nothing is opened on your router.

1. In the Cloudflare dashboard, go to **Networking → Tunnels → Create a tunnel**. Copy the token from the command it shows (the
   long text after `--token`).
2. Set `CLOUDFLARE_TUNNEL_TOKEN=<that token>` in `.env`, then run `docker compose -f docker-compose.cloudflare.yml up -d`.
3. In the tunnel, **Routes → Add route → Published application**: your hostname (e.g. `notes` on `example.com`) and the service
   URL `http://fastmemo:8787`.

Your address is `https://notes.example.com`. Cloudflare decrypts the traffic on its servers, so it can see what plain HTTP would
show (note titles, device credentials); the notes' content stays end-to-end encrypted.

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

| Variable                  | Default        | What it does                                                                             |
| ------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `FASTMEMO_ACCESS_KEY`     | none: required | The key devices connect with, at least 16 characters. The server won't start without it. |
| `FASTMEMO_ADMIN_KEY`      | the access key | Opens the dashboard.                                                                     |
| `PORT`                    | `8787`         | The port on your computer. With Docker, `127.0.0.1:8787` hides it from your network.     |
| `TZ`                      | `UTC`          | The time zone the dashboard counts days in.                                              |
| `MAX_DEVICES`             | `10`           | How many devices can connect.                                                            |
| `MAX_NOTE_MB`             | `5`            | The largest note, in MB.                                                                 |
| `MAX_BODY_MB`             | `64`           | The largest request, in MB.                                                              |
| `TRUST_PROXY`             | `false`        | `true` behind Tailscale Serve, Caddy, Cloudflare Tunnel, nginx, Traefik or Coolify.      |
| `LOG_LEVEL`               | `info`         | `debug`, `info`, `warn` or `error`.                                                      |
| `DATABASE_URL`            | SQLite         | `postgres://user:password@host:5432/db` for PostgreSQL.                                  |
| `DATA_DIR`                | `./data`       | Without Docker: where the SQLite file goes (the image uses `/data`).                     |
| `HOST`                    | `0.0.0.0`      | Without Docker: the address to listen on.                                                |
| `POSTGRES_PASSWORD`       |                | Only for `docker-compose.postgres.yml`.                                                  |
| `DOMAIN`                  |                | Only for `docker-compose.caddy.yml`.                                                     |
| `CLOUDFLARE_TUNNEL_TOKEN` |                | Only for `docker-compose.cloudflare.yml`.                                                |
| `TS_AUTHKEY`              |                | Only for `docker-compose.tailscale.yml`: signs it in, instead of the link in its logs.   |
| `TS_HOSTNAME`             | `fastmemo`     | Only for `docker-compose.tailscale.yml`: the first part of its address.                  |

## Backups and restore

Back up from the dashboard (**Download a backup**), or from a script, with the admin key in `FASTMEMO_ADMIN_KEY`:

```sh
curl -fsS -H "Authorization: Bearer $FASTMEMO_ADMIN_KEY" http://localhost:8787/admin/api/backup -o fastmemo-$(date +%F).db
```

Keep backups private: the notes in them are encrypted, but the titles and the device list are not.

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

With another compose file, add `-f <file>` to each command. If `docker compose pull` fails, `docker compose up -d --build`
builds the new version from source instead. The database is upgraded on start.

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
