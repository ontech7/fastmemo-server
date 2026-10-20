# Deployment details

The [README](../README.md) has the short path. This page has the details for each setup, backups, troubleshooting, and how sync
works.

## The image

`ghcr.io/ontech7/fastmemo-server` is built for `linux/amd64` (PC, VPS) and `linux/arm64` (Raspberry Pi with a 64-bit OS, Apple
silicon). Tags:

- `latest`: the newest release.
- `1.0`: the newest `1.0.x`.
- `1.0.0`: exactly that release.

The compose files use `latest` and also know how to build the image: when Docker can't download it, it builds it from the cloned
folder. `docker compose up -d --build` always builds from source.

To run the image without cloning the repository:

```sh
docker run -d --name fastmemo-server --restart unless-stopped -p 8787:8787 -v fastmemo-data:/data \
  -e TZ=Europe/Rome ghcr.io/ontech7/fastmemo-server:latest
docker logs fastmemo-server
```

Add `-e NAME=value` for any other setting. The volume is then `fastmemo-data`, not `fastmemo-server_fastmemo-data` (keep that in
mind for the restore steps).

## Raspberry Pi

- A Raspberry Pi 3, 4 or 5 with the **64-bit** Raspberry Pi OS. `uname -m` prints `aarch64` on a 64-bit system; `armv7l` means a
  32-bit one, which the image doesn't support.
- Install Docker, then log out and back in:

  ```sh
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER
  ```

- The container starts again on its own after a reboot or a power cut (`restart: unless-stopped`).
- Tailscale is the simplest way to give it an HTTPS address.

## Tailscale

- `tailscale serve --bg 8787` serves `https://<machine>.<your-tailnet>.ts.net` and forwards to port 8787 on the same machine. If
  it asks to enable HTTPS certificates or MagicDNS, follow the link it prints: it's one click in the Tailscale admin.
- `TRUST_PROXY=true` lets the server see which device sent each request, for the logs and the wrong-key limit. Without it, every
  request seems to come from the same local address.
- To keep the server off your home network (reachable through Tailscale only), also set `PORT=127.0.0.1:8787` in `.env`.

## Caddy

- The domain's DNS record must point to the server, and ports 80 and 443 must be open (forwarded, on a home router).
- Caddy keeps its certificates in the `caddy-data` volume and renews them on its own.
- `docker-compose.caddy.yml` sets `TRUST_PROXY=true` and doesn't publish port 8787: only Caddy is reachable.

## Coolify

1. In Coolify: **+ New → Public Repository** (or your fork), and paste the repository's URL.
2. **Build Pack**: Docker Compose. **Docker Compose Location**: `/docker-compose.coolify.yml`.
3. **Domains** for the `fastmemo` service: `https://notes.example.com:8787`. The `:8787` tells Coolify the container's port;
   people still connect on the normal HTTPS port.
4. **Deploy**.

Coolify gets the HTTPS certificate and generates the keys on the first deploy. Find them under **Environment Variables**:
`SERVICE_PASSWORD_64_ACCESSKEY` is the access key, `SERVICE_PASSWORD_64_ADMINKEY` opens the dashboard. `TZ`, `MAX_DEVICES`,
`MAX_NOTE_MB` and `LOG_LEVEL` can be set there too.

Coolify builds the image from the repository. To run the published image instead, replace `build: .` with
`image: ghcr.io/ontech7/fastmemo-server:latest` in `docker-compose.coolify.yml`.

## PostgreSQL

- Choose it if you already run PostgreSQL or want its tools. SQLite is enough for a person or a family, and its backup is one
  file.
- With your own PostgreSQL, set `DATABASE_URL=postgres://user:password@host:5432/db`. The server creates its tables on start.
- Run **one** server per database. Live updates and the day's counters live in the server's memory, so a second server on the
  same database would miss the first one's changes.
- The dashboard's backup button is for SQLite only: see [Backups](#backups).

## Without Docker

Node.js 22.18 or newer runs the TypeScript sources directly. In the cloned folder:

```sh
npm ci --omit=dev
cp .env.example .env
node --env-file=.env --disable-warning=ExperimentalWarning src/main.ts
```

- `npm ci --omit=dev` installs the one dependency (`pg`). `--env-file=.env` reads the settings; without it, set them in the
  environment.
- The database goes in `./data`; `DATA_DIR` changes it.
- `PORT` must be a plain number here. `HOST=127.0.0.1` keeps the server off your network.
- Keep it running with your system's service manager (systemd, launchd, a Windows service), and put HTTPS in front of it as you
  would with Docker.

## Settings

- `FASTMEMO_ADMIN_KEY`: set it to keep the dashboard's key apart from the one every device holds.
- `TZ`: the image's default is UTC. `.env.example` sets `Europe/Rome`: change it to yours.
- `PORT=127.0.0.1:8787` works with Docker only: compose publishes the port on that address.
- A wrong value stops the server at start with `Configuration error: ...` in the logs.

## Security details

- Each device gets its own token when it joins, and the server keeps only its SHA-256 hash. Removing a device revokes it at
  once.
- Changing the access key only stops new devices from joining. To lock out a device, remove it.
- The server never logs note contents. The only key it prints is a generated access key, at each start (it isn't kept with the
  dashboard's events).
- The container runs as the unprivileged `node` user and writes only to `/data`.
- The dashboard has a strict Content Security Policy and can't be framed.

## Backups

**What's in a SQLite backup:** the whole database. The notes in it stay encrypted, but it also holds the titles, the device list
and, if the server generated it, the access key. Keep it private, like a password.

**Scheduled backups:** the `curl` command in the README works from cron. Keep the admin key in a file only you can read, not in
the crontab line.

**After a restore** (SQLite or PostgreSQL), ask every device for a full sync from the dashboard. Each device then compares all
its notes with the server's, so whatever changed after the backup comes back from the devices. Also:

- A device that connected **after** the backup isn't in it. It gets disconnected: connect it again (turn sync on, same address
  and key).
- A device removed **after** the backup is back in the list: remove it again.

**PostgreSQL** (with `docker-compose.postgres.yml`). Back up:

```sh
docker compose -f docker-compose.postgres.yml exec -T postgres pg_dump -U fastmemo fastmemo > fastmemo-$(date +%F).sql
```

Restore, replacing `fastmemo-2026-10-20.sql` with your file:

```sh
docker compose -f docker-compose.postgres.yml stop fastmemo
docker compose -f docker-compose.postgres.yml exec -T postgres dropdb -U fastmemo fastmemo
docker compose -f docker-compose.postgres.yml exec -T postgres createdb -U fastmemo fastmemo
docker compose -f docker-compose.postgres.yml exec -T postgres psql -q -U fastmemo -d fastmemo < fastmemo-2026-10-20.sql
docker compose -f docker-compose.postgres.yml start fastmemo
```

## The dashboard

Open the server's address in a browser and enter the admin key (`FASTMEMO_ADMIN_KEY`, or the access key when it isn't set).

- **Notes, devices, space:** how many notes, how big, how many devices out of the maximum.
- **Operations per day**, for the last 30 days: reads, writes and deletes, counted the way Firestore counts them.
- **Devices:** when each one last synced, whether it has a note open, and how many changes it hasn't pulled yet. You can
  **remove** a device (its access stops at once) or ask it for a **full sync**.
- **Backup:** downloads the whole SQLite database.
- **Recent warnings and errors:** wrong keys, refused requests, problems.

## Troubleshooting

**The app can't reach the server, or says the key is wrong.**

- Open the server's address in the phone's browser. You should see the dashboard's login page. If not, the phone can't reach the
  server: is Tailscale on? Is the address right? Is a firewall in the way?
- The web app and the Windows desktop app need `https://`. The Android and macOS apps accept `http://` after a warning.
- Check the key: `docker compose logs fastmemo` shows it if the server generated it.

**"Too many attempts".** After 20 wrong keys in 15 minutes from the same address, the server refuses that address for a while.
Wait a few minutes and check the key.

**"Devices limit exceeded".** Remove a device you don't use any more (in the dashboard, or in the app's Manage devices), or
raise `MAX_DEVICES`.

**A device was offline for a long time.** It catches up on its own when it's back. If something looks wrong, click **Full sync**
on that device in the dashboard.

**The dashboard says "Unreachable".** The server stopped. Check `docker compose ps` and `docker compose logs fastmemo`.

**The server won't start after a downgrade.** A server refuses a database written by a newer version. Go back to the newer
image, or restore a backup made with the older one.

## How sync works

The server keeps one table of items (notes and categories). Each item has the revision the devices gave it and a sequence
number: every change takes the next number. Each device has a **cursor**, the last number it has applied. To sync, a device asks
for what's past its cursor (its own changes excluded) and moves the cursor once it has applied them. Devices wait for changes
with a long poll (a request that answers as soon as something changes), so an edit reaches the other devices in about a second.

When a device sends a change, the server applies the same rules as FastMemo's Firebase sync. A note edited on two devices before
they synced is kept twice (the app makes a copy). A delete never undoes a newer edit. A change the server already has isn't
written again. A deleted note leaves a small marker so the other devices learn about it; markers are dropped once every device
has seen them and they're old enough.

The API is described in [PROTOCOL.md](PROTOCOL.md).
