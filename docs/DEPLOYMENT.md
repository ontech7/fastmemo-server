# Deployment details

The [README](../README.md) has the short path. This page has the details for each setup, backups, troubleshooting, and how sync
works.

## The image

`ghcr.io/ontech7/fastmemo-server` is built for `linux/amd64` (PC, VPS) and `linux/arm64` (Raspberry Pi with a 64-bit OS, Apple
silicon). Tags:

- `latest`: the newest release.
- `1`: the newest `1.x`.
- `1.0`: the newest `1.0.x`.
- `1.0.0`: exactly that release.

The compose files run `1` (the newest `1.x`), or whatever `FASTMEMO_IMAGE` says in `.env`: one exact version, say. To update by
hand: `docker compose pull && docker compose up -d`, or from the dashboard with [the updater](#the-updater) (which then pins
`FASTMEMO_IMAGE` to the exact version and digest). A new major version (2.0) means reading its notes, then setting
`FASTMEMO_IMAGE`. The server runs read-only, without capabilities and without new privileges, and writes only in `/data` and
`/tmp`. Every release image is built on GitHub for both architectures and carries a signed build provenance
(`gh attestation verify oci://ghcr.io/ontech7/fastmemo-server:1.1.0 --repo ontech7/fastmemo-server`).

To build the image from the cloned folder instead (a failed download, or code you changed), add `docker-compose.build.yml` as a
second file; it names the image `fastmemo-server:local`:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

With another compose file, put it in place of the first one (for example
`-f docker-compose.caddy.yml -f docker-compose.build.yml`), and use the same pair of `-f` for `logs`, `down`, and the next
build.

To run the image without cloning the repository:

```sh
docker run -d --name fastmemo-server --restart unless-stopped -p 8787:8787 -v fastmemo-data:/data \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:size=16m \
  --env-file .env ghcr.io/ontech7/fastmemo-server:1
docker logs fastmemo-server
```

`.env` holds the settings, `FASTMEMO_ACCESS_KEY` at least (copy [.env.example](../.env.example)); `-e NAME=value` works too. The
volume is then `fastmemo-data`, not `fastmemo-server_fastmemo-data` (keep that in mind for the restore steps).

## The updater

The [README](../README.md#updates) has the short path. This is what is behind the **Install** button.

**What talks to what.** The dashboard's **Install** button makes the server write a tiny file, `request.json` (a version number
and a time), in `/var/lib/fastmemo-update/request`. `fastmemo-updater.path` sees it and starts `fastmemo-updater.service`, a
Python script run as root, which reads that version number and decides everything again from the release on GitHub, the running
container and the image. It reports in `/var/lib/fastmemo-update/status/status.json`, which the server reads through a read-only
mount and shows in the dashboard. The server never gets the Docker socket, and nothing the server writes is ever repeated back
to it. The service also runs once at every boot, to undo a switch that a power cut interrupted.

It handles the published image on SQLite, a new release of the same major version. For anything else the dashboard shows the
commands to run by hand: a new major (2.0), PostgreSQL, an image built from source, Coolify (redeploy there).

### What it checks, in order

1. The request is a small plain file with a version like `1.2.3`. Anything else fails.
2. The server is running as a container of the published image (`ghcr.io/ontech7/fastmemo-server`, any tag), with its database
   in a Docker volume mounted at `/data`, on SQLite. Else it is refused.
3. The version is newer than the running one, has the same major, and is a published, final release (not a draft or a
   pre-release) of the repository on GitHub.
4. It pulls `ghcr.io/ontech7/fastmemo-server:<version>`; the image must say it was built from this repository, for that version.
   It pins the image by its digest.
5. **Build provenance**, with `gh attestation verify`: the digest was built by this repository's `release.yml` from the tag
   `v<version>`, on GitHub's own runners. It happens when `gh` and a token are there (`VERIFY_PROVENANCE=auto`, the default),
   always with `required`, never with `off`. The dashboard's status then says **Provenance verified** or **Provenance not
   checked**. With `auto` and no `gh`, an update goes ahead on the strength of the steps above only: the image comes from this
   repository's package on GHCR over HTTPS, and says so. If you want the signature checked every time, use `required`.
6. The data folder and `.env` must be writable by the service, and there must be room for a copy of the database (its size plus
   256 MB). Else it fails, before anything is stopped.
7. The server is stopped, the database (`fastmemo.db`, and `-wal` and `-shm` if present) is copied, the `FASTMEMO_IMAGE` line of
   `.env` is set to `ghcr.io/ontech7/fastmemo-server:<version>@sha256:<digest>`, and the server starts on it.
8. It waits up to `HEALTH_TIMEOUT` seconds (120) for the container to be healthy. If it isn't, or the updater is stopped, or
   Docker fails, the previous `.env` line and the database copy come back, and the previous version starts again.
9. After a rollback, the server (the previous version, running again) asks every device for a full sync, once per rollback,
   within a minute of the status saying so. While the new version was waiting for its health check it was serving, and the notes
   it took went with it when the copy came back; the devices still have them and send back what changed since. Its log says
   "update rolled back: asked every device for a full sync".

### Installing it

The commands are in the [README](../README.md#updates). Why each one:

| What                                                           | Why                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/usr/local/lib/fastmemo/fastmemo-updater.py`                  | The script, owned by root: it runs as root.                                                                                    |
| `/etc/fastmemo/updater.env`                                    | Its settings, owned by root, mode 0644 (it refuses a file group- or world-writable).                                           |
| `/etc/systemd/system/fastmemo-updater.{service,path}`          | The service, and the path unit that starts it when a request appears.                                                          |
| `/var/lib/fastmemo-update/request`, owned `1000:1000`, 0750    | The server (the `node` user, 1000) leaves the request here.                                                                    |
| `/var/lib/fastmemo-update/status`, 0755                        | The updater writes the status, the server reads it.                                                                            |
| `/var/lib/fastmemo-update/backup`, `docker`, `gh`, 0700        | Database copies; Docker's and the GitHub CLI's config for the service (so it never uses yours).                                |
| `/etc/fastmemo/updater.secret`, root, 0600                     | Optional: `GH_TOKEN=<a token with no scopes>`, for the provenance check.                                                       |
| `/etc/systemd/system/fastmemo-updater.service.d/checkout.conf` | `ReadWritePaths=<your server's folder>`: the service is sandboxed (`ProtectSystem=strict`) and must write the folder's `.env`. |

Create the folders **before** you start the server with `contrib/updater/compose.updater.yaml`: Docker would otherwise create
the request folder owned by root, and the server couldn't write to it (the **Install** button would then fail).

**`/etc/fastmemo/updater.env`** (the file is commented; `updater.env.example` has every key):

| Key                                              | Default                                                   | What it does                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `COMPOSE_DIR`                                    | none: required                                            | Your server's folder (absolute path), where you run `docker compose`.                                               |
| `COMPOSE_FILE`                                   | `docker-compose.yml:contrib/updater/compose.updater.yaml` | The compose files you start the server with, relative to `COMPOSE_DIR`, separated by `:`. Keep the second one last. |
| `ENV_FILE`                                       | `COMPOSE_DIR/.env`                                        | The `.env` used with them. `FASTMEMO_IMAGE` is the only line the updater changes in it.                             |
| `SERVICE`                                        | `fastmemo`                                                | The server's service in the compose files.                                                                          |
| `HEALTH_TIMEOUT`                                 | `120`                                                     | Seconds the new version has to become healthy. A slow Raspberry Pi may need `300`.                                  |
| `COOLDOWN`                                       | `15`                                                      | Seconds between two runs.                                                                                           |
| `VERIFY_PROVENANCE`                              | `auto`                                                    | `auto`, `required` (fail without `gh` and a token) or `off`.                                                        |
| `REPO`, `IMAGE`, `SIGNER_WORKFLOW`, `GITHUB_API` | this repository                                           | For a fork that publishes its own image.                                                                            |
| `REQUEST_DIR`, `STATUS_DIR`, `BACKUP_DIR`        | `/var/lib/fastmemo-update/...`                            | The folders above.                                                                                                  |

After a change to `updater.env`, nothing needs restarting: it is read at every run. After a change to the service or its
drop-in, run `sudo systemctl daemon-reload`.

**`required` provenance.** Install `gh` 2.49 or newer (a distribution's older package won't have `gh attestation`), create a
token with no scopes at [github.com/settings/tokens](https://github.com/settings/tokens) (`gh` needs a token to fetch the
attestations; for a public repository, one without scopes is enough), save it as above in `/etc/fastmemo/updater.secret`, and
set `VERIFY_PROVENANCE=required` in `updater.env`. Then an update without a verified signature is refused with "build provenance
is required but the GitHub CLI or its token is missing" or "the build provenance of the image could not be verified". To check
an image by hand: `gh attestation verify oci://ghcr.io/ontech7/fastmemo-server:1.1.0 --repo ontech7/fastmemo-server`.

**A different Docker folder.** The service may write in `/var/lib/docker/volumes`, where Docker keeps the data volume. If
`docker info --format '{{.DockerRootDir}}'` prints something else (a `data-root` in `/etc/docker/daemon.json`), or
`/var/lib/docker` is a symlink (an SSD on a Raspberry Pi), add that real folder's `volumes` to the drop-in, then
`sudo systemctl daemon-reload`:

```ini
[Service]
ReadWritePaths=/home/pi/fastmemo-server
ReadWritePaths=/mnt/ssd/docker/volumes
```

Without it, the update stops before anything is touched, with "the updater can't write the data volume".

**After the first update** `.env` holds a `FASTMEMO_IMAGE=...:<version>@sha256:...` line: the server runs exactly that image,
and a later `docker compose pull && docker compose up -d` doesn't move it. Update from the dashboard, or delete that line to
follow the newest `1.x` again.

To stop using the updater: `sudo systemctl disable --now fastmemo-updater.path fastmemo-updater.service`, then start the server
without `contrib/updater/compose.updater.yaml`.

### What the status says

The dashboard shows the last run's status (until the next run):

| Status                                                                                                   | What it means                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Checking the release, Downloading the new version, Verifying the image                                   | The first steps above.                                                                                                                                                                                                                                                                                                                                                               |
| Copying the database                                                                                     | The server is stopped while the database is copied: a few seconds for a small database.                                                                                                                                                                                                                                                                                              |
| Restarting on the new version                                                                            | The new version is starting; it waits for the healthy check.                                                                                                                                                                                                                                                                                                                         |
| **Updated**                                                                                              | Done: the new version is healthy.                                                                                                                                                                                                                                                                                                                                                    |
| **Rolled back to the previous version**                                                                  | The new version didn't become healthy (or the run was interrupted), so the previous image and database are back. The message says why. If it adds "not healthy yet: check the containers", the previous version was started but hadn't passed its health check yet: look at `docker compose ps`. The server asks every device for a full sync, so nothing written meanwhile is lost. |
| **Refused**                                                                                              | The request is something one click doesn't do: PostgreSQL, a source build, another major, an older version. Nothing was touched. The message says which. Use the commands in the dashboard.                                                                                                                                                                                          |
| **Failed**                                                                                               | The update didn't happen: usually nothing was changed ("nothing was changed" in the message): GitHub or Docker couldn't be reached, the image or its provenance didn't match, no room for the copy, the service can't write. Try again, or read the log.                                                                                                                             |
| Failed: "could not be undone completely", "the database could not be put back" or "could not be stopped" | A rollback step failed. Read the log, then check `docker compose ps`, the `FASTMEMO_IMAGE` line of `.env` and the backup (below). If the message says the new version was started again, that version runs on its own, already migrated, database: the copy is in the backup folder.                                                                                                 |

### The log

The status is a short fixed sentence. What happened in detail goes to the journal:

```sh
sudo journalctl -u fastmemo-updater              # all runs
sudo journalctl -u fastmemo-updater -b -e        # this boot, from the end
sudo journalctl -u fastmemo-updater -f           # follow an update while it runs
systemctl status fastmemo-updater.path           # is the watcher active?
```

### The backups

Before every switch the database is copied to `/var/lib/fastmemo-update/backup/<date and time>-<previous version>/` (the last 3
are kept): `fastmemo.db`, `fastmemo.db-wal` and `fastmemo.db-shm` when they exist, and `image.env`, the `FASTMEMO_IMAGE` line
that was in `.env` (empty if there was none). The folder is readable by root only: `sudo ls /var/lib/fastmemo-update/backup`.

To put one back by hand (if the update's own rollback couldn't), stop the server, replace the database, and put the image line
back. In the server's folder, with the name of the backup folder and your compose files (`docker volume ls` shows the volume,
`<folder name>_fastmemo-data`):

```sh
docker compose -f docker-compose.yml -f contrib/updater/compose.updater.yaml stop fastmemo
sudo docker run --rm -v fastmemo-server_fastmemo-data:/data \
  -v /var/lib/fastmemo-update/backup/20261023-101500-123456-1.1.0:/backup:ro alpine \
  sh -c 'rm -f /data/fastmemo.db /data/fastmemo.db-wal /data/fastmemo.db-shm && cp /backup/fastmemo.db* /data/ && chown 1000:1000 /data/fastmemo.db*'
sudo cat /var/lib/fastmemo-update/backup/20261023-101500-123456-1.1.0/image.env
```

Put that line in `.env` in place of the `FASTMEMO_IMAGE` line (delete the line if `image.env` is empty), then
`docker compose -f docker-compose.yml -f contrib/updater/compose.updater.yaml up -d`. The image must be the one the copy belongs
to: a server refuses a database newer than itself. The notes written after the copy are gone from this server; click **Ask every
device for a full sync** in the dashboard and the devices send them back.

### Troubleshooting the updater

- **No Install button.** The server isn't set up for it: it needs SQLite, the two folders mounted
  (`contrib/updater/compose.updater.yaml` in the `docker compose` command that started it, and the folders existing), and a
  newer release of the same major. Look at `docker inspect fastmemo-server` for the mounts at `/updates/request` and
  `/updates/status`.
- **"An update is already waiting for the updater", and nothing happens.** The watcher isn't running, or doesn't see the file:
  `systemctl status fastmemo-updater.path`, then `sudo journalctl -u fastmemo-updater`. If a `request.json` is left in
  `/var/lib/fastmemo-update/request` from long ago, delete it.
- **"Refused": the database is not in a volume mounted at /data**, or the image "was built from source". A bind mount, a custom
  `DATA_DIR` or `DATABASE_URL`, and `docker-compose.build.yml` are all updated by hand.
- **Fails at once with "the updater can't write the checkout's .env".** The drop-in is missing or names another folder
  (`systemctl show -p ReadWritePaths fastmemo-updater` lists what it may write).
- **`updater.env` "must be a regular file owned by this user and not writable by group or others".** Run
  `sudo chown root:root /etc/fastmemo/updater.env && sudo chmod 0644 /etc/fastmemo/updater.env`. The journal shows this.

## Raspberry Pi

- A Raspberry Pi 3, 4 or 5 with the **64-bit** Raspberry Pi OS. `uname -m` prints `aarch64` on a 64-bit system; `armv7l` means a
  32-bit one, which the image doesn't support.
- Install Docker, then log out and back in:

  ```sh
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER
  ```

- The container starts again on its own after a reboot or a power cut (`restart: unless-stopped`).
- Tailscale is the simplest way to reach it from anywhere, encrypted: over HTTPS, or plain HTTP inside the tailnet.

## Tailscale

- `tailscale serve --bg 8787` serves `https://<machine>.<your-tailnet>.ts.net` and forwards to port 8787 on the same machine. If
  it asks to enable HTTPS certificates or MagicDNS, follow the link it prints: it's one click in the Tailscale admin.
- `tailscale serve --bg --tcp=8787 tcp://127.0.0.1:8787` serves `http://<machine>.<your-tailnet>.ts.net:8787` instead, with no
  certificate. Tailscale encrypts the traffic all the same, and Android and the desktop apps connect without a warning; the web
  app needs HTTPS. Choose it to keep the machine's name out of the public Certificate Transparency logs, where every HTTPS
  certificate is listed. A TCP forward passes no `X-Forwarded-For`: every request seems to come from the same local address.
- `TRUST_PROXY=true` lets the server see which device sent each request, for the logs and the wrong-key limit. Without it, every
  request seems to come from the same local address. The server takes the address from the proxy's `X-Forwarded-For` only on a
  connection from a private address (where a proxy connects from).
- Set `PORT=127.0.0.1:8787` in `.env` as well: the server is then reached through Tailscale only. Published on every address, a
  device on your network could reach it directly and, with `TRUST_PROXY`, pose as another address.
- Tailscale signs a machine out after 180 days by default. For a server, turn that off: on the **Machines** page of the admin,
  open the server's menu and choose **Disable key expiry**.

### Tailscale in a container

`docker-compose.tailscale.yml` runs Tailscale in its own container, and the server shares its network: no Tailscale on the
computer, no published port. The dashboard and the API are only at the `ts.net` address.

- **HTTPS certificates:** turn on **HTTPS Certificates** (and MagicDNS) on the **DNS** page of the Tailscale admin before the
  first start. The container can't ask for it the way `tailscale serve` does.
- **Signing in:** leave `TS_AUTHKEY` empty and open the link after `To authenticate, visit:` in
  `docker compose -f docker-compose.tailscale.yml logs tailscale`. Or create an auth key (**Settings → Keys → Generate auth
  key**) and set `TS_AUTHKEY` in `.env` before the first start. The key is used once: the machine stays signed in, in the
  `tailscale-state` volume, across restarts and updates.
- **The address:** `https://fastmemo.<your-tailnet>.ts.net`. `TS_HOSTNAME` changes `fastmemo`. If the name is taken, Tailscale
  adds a number (`fastmemo-1`): the **Machines** page shows the real one.
- **What's served** is in `tailscale/serve.json`: port 443 forwards to the server at `127.0.0.1:8787`. For plain HTTP with no
  certificate (see above), replace its content with `{"TCP": {"8787": {"TCPForward": "127.0.0.1:8787"}}}`: the address is
  `http://fastmemo.<your-tailnet>.ts.net:8787`, and HTTPS Certificates can stay off.

### Tailscale Funnel

Funnel makes the Tailscale address public: devices without Tailscale (the web app on a computer that isn't yours) can reach it.

- `sudo tailscale funnel --bg 8787` serves the same `https://<machine>.<your-tailnet>.ts.net` to the whole internet. The first
  time, it prints a link to allow Funnel in your tailnet: one click in the admin.
- With `docker-compose.tailscale.yml`, set `AllowFunnel` to `true` in `tailscale/serve.json`. The container picks the change up
  on its own. If Funnel was never allowed in your tailnet, allow it once in the admin: **Access controls → Add Funnel to
  policy**.
- Anyone can now reach the server, and only the access key keeps them out: use a long one (`openssl rand -hex 24`). After 20
  wrong keys in 15 minutes, an address is refused for a while.
- The certificate stays on your machine: Tailscale forwards the encrypted traffic and can't read it.
- Funnel traffic has bandwidth limits, which Tailscale doesn't publish.
- To make it private again: `sudo tailscale funnel reset`, then `sudo tailscale serve --bg 8787`. In a container, set
  `AllowFunnel` back to `false`.

## Caddy

- The domain's DNS record must point to the server, and ports 80 and 443 must be open (forwarded, on a home router).
- Caddy keeps its certificates in the `caddy-data` volume and renews them on its own.
- `docker-compose.caddy.yml` sets `TRUST_PROXY=true` and doesn't publish port 8787: only Caddy is reachable.

## Cloudflare Tunnel

A public HTTPS address on your domain, with nothing opened on the router: the `cloudflared` container connects out to
Cloudflare, and Cloudflare sends the requests back through that connection. It works behind CGNAT and routers you can't
configure.

- The domain must use Cloudflare's nameservers. The free plan is enough.
- In the Cloudflare dashboard: **Networking → Tunnels → Create a tunnel**, any name. Choose Docker: the command it shows ends
  with `--token <a long text>`. That text goes in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`. Then
  `docker compose -f docker-compose.cloudflare.yml up -d`, and the dashboard shows the tunnel as connected.
- In the tunnel: **Routes → Add route → Published application**. Subdomain `notes`, your domain, service URL
  `http://fastmemo:8787` (the server's name inside Docker, not `localhost`). Cloudflare creates the DNS record.
- The token lets anyone run your tunnel: keep `.env` private. To replace it, refresh the token in the tunnel's settings, update
  `.env` and run `docker compose -f docker-compose.cloudflare.yml up -d`.
- **Cloudflare can see the traffic.** It decrypts HTTPS on its servers before it forwards it: note titles, device names and
  device tokens pass through it in the clear, the notes' content doesn't (it's end-to-end encrypted). If that's not fine for
  you, use Tailscale (Funnel included) or Caddy, which keep the certificate on your machine.
- Limits that matter here: a request can be up to 100 MB on the free plan (`MAX_BODY_MB` is 64), and must be answered within 100
  seconds (a long poll waits 50 at most).
- `docker-compose.cloudflare.yml` sets `TRUST_PROXY=true` and doesn't publish port 8787: only the tunnel reaches the server.
- Quick tunnels (`trycloudflare.com`) get a new address at every start: the devices would lose the server.

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
`image: ghcr.io/ontech7/fastmemo-server:1` in `docker-compose.coolify.yml`. Update it with **Redeploy**; the one-click updater
doesn't apply to Coolify (the dashboard still shows the update).

## PostgreSQL

- Choose it if you already run PostgreSQL or want its tools. SQLite is enough for a person or a family, and its backup is one
  file.
- With your own PostgreSQL, set `DATABASE_URL=postgres://user:password@host:5432/db`. The server creates its tables on start.
- Run **one** server per database. Live updates and the day's counters live in the server's memory, so a second server on the
  same database would miss the first one's changes.
- The dashboard's backup button is for SQLite only: see [Backups](#backups).

## Without Docker

Node.js 24 or newer runs the TypeScript sources directly. On Node.js 20 or 22, install Node.js 24 first (for example
`nvm install 24`). In the cloned folder:

```sh
npm ci --omit=dev
cp .env.example .env
node --env-file=.env src/main.ts
```

- `npm ci --omit=dev` installs the one dependency (`pg`). `--env-file=.env` reads the settings; without it, set them in the
  environment.
- The database goes in `./data`; `DATA_DIR` changes it.
- `PORT` must be a plain number here. The server listens on this computer only: put HTTPS in front of it, or set `HOST=0.0.0.0`
  for the devices on your network to reach it directly.
- Keep it running with your system's service manager (systemd, launchd, a Windows service), and put HTTPS in front of it as you
  would with Docker.

## Settings

- `FASTMEMO_ADMIN_KEY`: set it to keep the dashboard's key apart from the one every device holds.
- `TZ`: the image's default is UTC. `.env.example` sets `Europe/Rome`: change it to yours.
- `PORT=127.0.0.1:8787` works with Docker only: compose publishes the port on that address.
- A wrong value stops the server at start with `Configuration error: ...` in the logs.

## Security details

- Each device gets its own token when it joins, and the server keeps only its SHA-256 hash. Removing a device revokes its token
  at once.
- Every device also holds the access key, and can join again with it. To lock out a lost device: remove it **and** change the
  access key. Changing the key alone only stops new devices from joining: the others keep syncing with their tokens.
- The server never logs note contents or keys. The access key comes only from the environment: without one the server doesn't
  start, so a forgotten setting can't leave it open.
- The container runs as the unprivileged `node` user and writes only to `/data` (a backup is written there before it's sent,
  then removed). Its files are readable by that user only.
- Without Docker the server listens on `127.0.0.1` unless `HOST` says otherwise.
- Wrong keys: 20 per address (an IPv6 /64 counts as one) in 15 minutes, then that address is refused for a while; 500 from all
  addresses together, then every key attempt is refused for a while (devices keep syncing with their tokens).
- The dashboard has a strict Content Security Policy and can't be framed.
- The server never gets the Docker socket. With the updater on, the dashboard can ask for a newer release of this project to be
  installed, nothing else: the updater, a separate root service, checks the request again. Set `FASTMEMO_ADMIN_KEY` so that the
  access key every device holds doesn't open the dashboard.

## Backups

**What's in a SQLite backup:** the whole database. The notes in it stay encrypted, but it also holds the titles and the device
list. Keep it private, like a password.

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
  **remove** a device (its token stops at once: for a lost device, change the access key too) or ask it for a **full sync**.
- **Backup:** downloads the whole SQLite database.
- **Recent warnings and errors:** wrong keys, refused requests, problems.

## Troubleshooting

**The app can't reach the server, or says the key is wrong.**

- Open the server's address in the phone's browser. You should see the dashboard's login page. If not, the phone can't reach the
  server: is Tailscale on? Is the address right? Is a firewall in the way?
- With Cloudflare Tunnel, if the browser opens the dashboard but the app can't connect, a Cloudflare security setting may be
  challenging the app (Bot Fight Mode, "I'm Under Attack" mode): an app can't solve a challenge. Turn it off for the domain.
- The web app needs `https://` (so did the Windows desktop app before 2.0). The Android and desktop apps accept `http://` after
  a warning: type `http://` before a name (`http://nas.home.arpa:8787`); without it the app assumes `https://`, except for an IP
  address, `localhost` or a `.local` name.
- Check the key: it's `FASTMEMO_ACCESS_KEY` in `.env` (on Coolify, in Environment Variables).

**"Too many attempts".** After 20 wrong keys in 15 minutes from the same address, the server refuses that address for a while.
Wait a few minutes and check the key.

**"Devices limit exceeded".** Remove a device you don't use any more (in the dashboard, or in the app's Manage devices), or
raise `MAX_DEVICES`.

**A device was offline for a long time.** It catches up on its own when it's back. If something looks wrong, click **Full sync**
on that device in the dashboard.

**The dashboard says "Unreachable".** The server stopped. Check `docker compose ps` and `docker compose logs fastmemo`.

**The dashboard shows an update I don't want, or none at all.** `UPDATE_CHECK=off` in `.env` stops the check (every 6 hours, one
request to `api.github.com`). **Check now** in the dashboard looks again (at most once a minute). If the last check failed, the
dashboard says why (GitHub unreachable, a rate limit): it keeps what it knew and tries again later.

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
