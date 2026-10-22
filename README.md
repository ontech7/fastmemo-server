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
- [Updates](#updates)
- [Security](#security)
- [Quality](#quality)
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
manager: the server never shows it, and without it the server doesn't start. Set `FASTMEMO_ADMIN_KEY` too, made the same way: it
opens the dashboard (left empty, the access key does, and every device holds that one). Then:

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

The web app only reaches `https://` addresses; Android and the desktop apps accept `http://` too (see [HTTPS](#https)). To try
it on the computer that runs the server, `http://localhost:8787` is enough. Then, on each device:

1. Open **Settings → Cloud Sync** and turn on **Enable Cloud sync**.
2. In **Sync with**, choose **FastMemo Server**.
3. Enter the **Server address** and the **Access key**, then tap **Save settings**.

The first device asks you to choose an **encryption password** and shows a **recovery key**: write it down. The other devices
ask for the same password. It never reaches the server. Lose both the password and the recovery key, and nobody can read the
notes.

## HTTPS

The web app only connects to `https://` addresses (or to a server on the same computer). The Android app and the desktop apps
(macOS, Linux, Windows) accept `http://` too.

Plain HTTP isn't encrypted, and that's fine through Tailscale or a VPN like WireGuard: the tunnel encrypts the traffic (the app
doesn't even warn for a Tailscale address). Elsewhere, use HTTPS: a phone set up on your Wi-Fi keeps talking to that address
from a café's, and whoever can see that traffic can read the note titles and the device's credentials, and with them change or
delete notes and remove devices; the notes' content stays end-to-end encrypted. The access key only travels when a device
connects; after that each device uses its own token. If you think one was seen, change the access key and remove and re-add each
device: a device's token keeps working after a key change.

### Tailscale (easiest)

[Tailscale](https://tailscale.com) puts the server in a private, encrypted network that your devices reach from anywhere: no
domain, nothing open to the internet.

1. Install Tailscale on the server and on every device, and sign in with the same account.
2. On the server, run `sudo tailscale serve --bg 8787`. It prints your address, like `https://raspberrypi.your-tailnet.ts.net`.
3. Set `TRUST_PROXY=true` and `PORT=127.0.0.1:8787` in `.env`, and run `docker compose up -d`. The server is then reached
   through Tailscale only: nobody on your network can reach it directly and pose as another address.

**Rather have no certificate?** An HTTPS address puts its name (`raspberrypi.your-tailnet.ts.net`) in the public Certificate
Transparency logs: the server stays private, but the name can be seen. Plain HTTP through Tailscale is encrypted all the same,
and enough for Android and the desktop apps (not the web app): in step 2 run
`sudo tailscale serve --bg --tcp=8787 tcp://127.0.0.1:8787`, and the address is `http://raspberrypi.your-tailnet.ts.net:8787`.

**Can't install Tailscale on the server** (a NAS, for example)? Run it in a container next to the server instead. Turn on
**HTTPS Certificates** in the Tailscale admin (**DNS** page), then:

```sh
docker compose -f docker-compose.tailscale.yml up -d
docker compose -f docker-compose.tailscale.yml logs tailscale
```

Open the link after `To authenticate, visit:` and sign in. Your address is `https://fastmemo.your-tailnet.ts.net`. For plain
HTTP with no certificate, put `{"TCP": {"8787": {"TCPForward": "127.0.0.1:8787"}}}` in `tailscale/serve.json` (HTTPS
Certificates can stay off): the address is `http://fastmemo.your-tailnet.ts.net:8787`.

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
  `https://notes.example.com:8787`. Coolify handles HTTPS and generates the keys. Update it with **Redeploy**.
- **Without Docker**, with Node.js 22.18 or newer: `npm ci --omit=dev`, then
  `node --env-file=.env --disable-warning=ExperimentalWarning src/main.ts`.

Step by step, and troubleshooting: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Configuration

Settings go in `.env` (on Coolify, in Environment Variables). Run `docker compose up -d` after a change.

| Variable                  | Default          | What it does                                                                                                              |
| ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `FASTMEMO_ACCESS_KEY`     | none: required   | The key devices connect with, at least 16 characters. The server won't start without it.                                  |
| `FASTMEMO_ADMIN_KEY`      | the access key   | Opens the dashboard.                                                                                                      |
| `PORT`                    | `8787`           | The port on your computer. With Docker, `127.0.0.1:8787` hides it from your network.                                      |
| `TZ`                      | `UTC`            | The time zone the dashboard counts days in.                                                                               |
| `MAX_DEVICES`             | `10`             | How many devices can connect.                                                                                             |
| `MAX_NOTE_MB`             | `5`              | The largest note, in MB, encrypted: its text can be about 3/4 of it. Bigger notes stay offline on their device.           |
| `MAX_BODY_MB`             | `64`             | The largest request, in MB.                                                                                               |
| `TRUST_PROXY`             | `false`          | `true` behind Tailscale Serve, Caddy, Cloudflare Tunnel, nginx, Traefik or Coolify (trusted from private addresses only). |
| `LOG_LEVEL`               | `info`           | `debug`, `info`, `warn` or `error`.                                                                                       |
| `UPDATE_CHECK`            | `on`             | `off` stops the check, every 6 hours, for a newer release on GitHub (the dashboard says when there is one: see Updates).  |
| `FASTMEMO_IMAGE`          | the newest `1.x` | The image the compose files run (not Coolify's). The updater sets it to one exact version.                                |
| `DATABASE_URL`            | SQLite           | `postgres://user:password@host:5432/db` for PostgreSQL.                                                                   |
| `DATA_DIR`                | `./data`         | Without Docker: where the SQLite file goes (the image uses `/data`).                                                      |
| `HOST`                    | `127.0.0.1`      | Without Docker: the address to listen on. `0.0.0.0` puts the server on your network.                                      |
| `POSTGRES_PASSWORD`       |                  | Only for `docker-compose.postgres.yml`.                                                                                   |
| `DOMAIN`                  |                  | Only for `docker-compose.caddy.yml`.                                                                                      |
| `CLOUDFLARE_TUNNEL_TOKEN` |                  | Only for `docker-compose.cloudflare.yml`.                                                                                 |
| `TS_AUTHKEY`              |                  | Only for `docker-compose.tailscale.yml`: signs it in, instead of the link in its logs.                                    |
| `TS_HOSTNAME`             | `fastmemo`       | Only for `docker-compose.tailscale.yml`: the first part of its address.                                                   |

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

## Updates

The dashboard shows the version it runs and, unless you set `UPDATE_CHECK=off`, asks GitHub every 6 hours which release is the
latest (that request is all that leaves the server). A newer one appears next to the version, with its release notes; one with a
**Security** section in its notes is marked as a security update. The app will show it too, from a later app version. To hear
about releases by email, open the repository on GitHub and choose **Watch → Custom → Releases**.

**By hand** works on every setup. In the server's folder:

```sh
git pull
docker compose pull && docker compose up -d
```

With another compose file, add `-f <file>` to each command. The compose files run the newest `1.x` image. A new major version
(2.0) means reading its notes first. Then set `FASTMEMO_IMAGE` in `.env`, for example
`FASTMEMO_IMAGE=ghcr.io/ontech7/fastmemo-server:2`. The database is upgraded on start. If `docker compose pull` fails, or you
changed the code, [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#the-image) shows how to build it from source.

**With one click**, if you install the optional updater on the host: the dashboard's **Install** button does the same, safely,
and shows its progress. It works for SQLite, for the published image, and for the same major version (a new major, PostgreSQL
and source builds show the commands to run instead). The updater is the only piece that runs as root, because it drives Docker.
The server never gets the Docker socket: it can only leave a version number in a folder, and the updater decides everything
again by itself:

- it reads nothing but that version (no symlinks, no special files, a few bytes at most), and echoes nothing back;
- the version must be a published, final release of this repository, newer than the running one, of the same major;
- the image it pulls must say it was built from this repository, for that version, and it runs pinned by its digest;
- its **build provenance** is verified (built by this repository's release workflow, from that version's tag) when the GitHub
  CLI and a token are on the host. Without them the update still goes ahead, and the dashboard says "Provenance not checked":
  every update says "verified" or "not checked". `VERIFY_PROVENANCE=required` makes the check mandatory;
- the database is copied first (when there is room for it), and if the new version is not healthy within two minutes, or the run
  is stopped half-way, the previous image and database come back. An update a power cut interrupted is undone at the next boot.

<details>
<summary><strong>Install the updater</strong></summary>

You need Linux with systemd and Python 3 (a Raspberry Pi or a VPS, say), and the server started with `docker compose` from a
cloned folder (not Coolify). Read [`contrib/updater`](contrib/updater) first: it runs as root. In the server's folder:

```sh
sudo install -m 0755 -D contrib/updater/fastmemo-updater.py /usr/local/lib/fastmemo/fastmemo-updater.py
sudo install -m 0644 -D contrib/updater/updater.env.example /etc/fastmemo/updater.env
sudo install -m 0644 contrib/updater/fastmemo-updater.path contrib/updater/fastmemo-updater.service /etc/systemd/system/
sudo install -d -o 1000 -g 1000 -m 0750 /var/lib/fastmemo-update/request
sudo install -d -m 0755 /var/lib/fastmemo-update/status
sudo install -d -m 0700 /var/lib/fastmemo-update/backup /var/lib/fastmemo-update/docker /var/lib/fastmemo-update/gh
```

Then tell it where your server's folder is. Open `/etc/fastmemo/updater.env` (`sudo nano /etc/fastmemo/updater.env`) and set
`COMPOSE_DIR` to this folder (the line `pwd` prints), and `COMPOSE_FILE` to the compose files you start the server with, in
order and separated by `:` (the default is `docker-compose.yml:contrib/updater/compose.updater.yaml`). Let the service write in
that folder (it keeps `.env` up to date), start it, and start the server with the updater's extra compose file:

```sh
sudo mkdir -p /etc/systemd/system/fastmemo-updater.service.d
printf '[Service]\nReadWritePaths=%s\n' "$PWD" | sudo tee /etc/systemd/system/fastmemo-updater.service.d/checkout.conf
sudo systemctl daemon-reload
sudo systemctl enable fastmemo-updater.service
sudo systemctl enable --now fastmemo-updater.path
docker compose -f docker-compose.yml -f contrib/updater/compose.updater.yaml up -d
```

With another compose file than `docker-compose.yml` (Caddy, Cloudflare, Tailscale), put it first in place of
`docker-compose.yml`, here and in `COMPOSE_FILE`, and use the same pair of `-f` for every later command. Set
`FASTMEMO_ADMIN_KEY` in `.env` as well: otherwise the access key, which every device holds, opens the dashboard and its
**Install** button.

For the provenance check, install a recent [GitHub CLI](https://cli.github.com) (`gh`, 2.49 or newer) and put a token with **no
scopes** (**GitHub → Settings → Developer settings → Personal access tokens**, no boxes ticked) in a file only root reads:

```sh
sudo install -m 0600 /dev/null /etc/fastmemo/updater.secret
sudo nano /etc/fastmemo/updater.secret    # one line: GH_TOKEN=<the token>
```

The details (what each status means, where the backups are, troubleshooting a rollback) are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#the-updater).

</details>

## Security

| Who                                              | What they get                                                                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Someone on the internet without a key            | Nothing. Wrong keys are logged, and an address that fails 20 times in 15 minutes is refused for a while.                                                         |
| Someone with the access key                      | They can join as a device, download the encrypted notes, remove devices or wipe the server's copy. Without the password, they can't read the notes.              |
| A device (its token)                             | Its own sync. Removing the device stops its token at once.                                                                                                       |
| Someone with the admin key                       | The dashboard: devices, backups, removing devices and, with the updater, installing a newer release (see Updates).                                               |
| The tunnel or proxy provider (Cloudflare Tunnel) | The traffic as plain HTTP would show it: note titles, device names and tokens. Not the notes' content. Tailscale and Caddy keep the certificate on your machine. |
| Someone on your network, without HTTPS           | The same, and with the device credentials they could change or delete notes. Use HTTPS (see [HTTPS](#https)).                                                    |
| A compromised server container                   | The encrypted notes and the titles. It has no capabilities, a read-only filesystem, no Docker socket, and only its own settings.                                 |
| Someone with root on the host                    | Everything on it, the updater included. The notes stay encrypted, but the server can't protect itself from the machine's owner.                                  |

- **Encrypted on your devices:** the contents of your notes (text, checklists, kanban cards, code).
- **Not encrypted:** note titles, category names, kanban column names, device names, dates and note types. The server stores
  them as they are, and sees when each device syncs and how big the notes are.
- **The container** runs as an unprivileged user, read-only, with all Linux capabilities dropped and no new privileges. It
  writes only in `/data` (its database, readable by that user only) and a small `/tmp`. It gets only its own settings from
  `.env`, never another service's secret (a tunnel token, a Tailscale key). After an update the image is pinned by its digest.
- **The updater** is separate and optional: the server never gets the Docker socket. See [Updates](#updates).
- Before 1.0.0 the code was reviewed. The review found, among others, a request that took the server down (`GET //`), a forged
  `X-Forwarded-For` that dodged the wrong-key limit, a limiter that could be made to grow, a backup held in memory and files
  readable by other users. All were fixed, each with a regression test in [`test/hardening.test.ts`](test/hardening.test.ts). To
  report a vulnerability, see [`SECURITY.md`](SECURITY.md).

### Lost device or leaked key

- **Lost or stolen device:** remove it in the dashboard, or in the app (**Settings → Cloud Sync → Manage devices**), **and**
  change the access key (a new `FASTMEMO_ACCESS_KEY`, then `docker compose up -d`). Removing it stops its token at once, but the
  device also holds the access key, with which it could join again. Your other devices keep syncing: their tokens don't change.
- **Leaked access key:** set a new `FASTMEMO_ACCESS_KEY` and run `docker compose up -d`. New devices then need the new key, but
  connected devices keep working, so also remove any device you don't recognize.
- **Encryption password:** change it in the app (**Settings → Cloud Sync → Change password**). The server never sees it.

## Quality

These checks run on GitHub for every pull request and every push to `main` and `dev`, and a release is only published when the
tests pass:

| Check                     | What it covers                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Types and tests**       | TypeScript strict mode, and the test suite on a real server: the API, the push guard, the dashboard, long polls                 |
| **SQLite and PostgreSQL** | The same suite runs on both databases                                                                                           |
| **The app's sync rules**  | The push guard decides like the app's Firebase adapter; the app's own `sync-server.test.mjs` checks the pair                    |
| **The updater**           | Tested against a stand-in Docker: refusals, the switch, a version that never becomes healthy, a stop half-way, a power cut      |
| **Security regressions**  | One test per issue found in reviews, in `test/hardening.test.ts`                                                                |
| **CodeQL**                | GitHub's security-extended queries on the server and the updater, weekly and on every pull request                              |
| **Dependabot**            | Weekly updates of the npm packages, the GitHub Actions and the Docker base image                                                |
| **Multi-arch image**      | `linux/amd64` and `linux/arm64`, each built on its own kind of machine, published with signed build provenance on every release |

## Development

The API is in [docs/PROTOCOL.md](docs/PROTOCOL.md). Node.js 22.18 or newer runs the TypeScript sources directly, with no build.

```sh
npm install
npm run dev         # restarts on changes, data in ./data
npm test            # SQLite
npm run typecheck
TEST_DATABASE_URL=postgres://user:password@localhost:5432/test npm run test:pg   # drops that database's tables
```

A release: write its section in [CHANGELOG.md](CHANGELOG.md), `npm version`, and push the `v*` tag.
`.github/workflows/release.yml` tests, publishes the image with signed provenance and opens the GitHub release with that section
as its notes.

## License

[AGPL-3.0](LICENSE)
