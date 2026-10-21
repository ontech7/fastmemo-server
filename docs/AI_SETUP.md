# Setting up FastMemo Server: a guide for AI assistants

You are an AI assistant (Claude Code, Cursor, Codex, ...) asked to install FastMemo Server for someone. Follow this page in
order. The person may not be a developer: talk in plain words, ask one thing at a time, and tell them what you're doing before
each step that changes their machine.

The [README](../README.md) is the human version of the same setup, and [DEPLOYMENT.md](DEPLOYMENT.md) has the details. This page
adds what you need on top: what to ask, what to check, what never to do, and how to hand over.

## Never

1. **Never delete the data.** No `docker compose down -v`, no `docker volume rm` or `docker volume prune`, no deleting `data/`
   or `*.db` files. The notes live there. `docker compose down` (without `-v`) is safe.
2. **Never put plain `http://` on the internet.** On a VPS or any machine reachable from the internet, the server goes behind
   HTTPS (Tailscale, Caddy, Cloudflare Tunnel or Coolify), and port 8787 is published on `127.0.0.1` only. Docker publishes
   ports past firewalls like `ufw`, so a firewall rule isn't enough.
3. **Never ask for the encryption password or the recovery key.** The person chooses them in the app; they never reach the
   server, and you don't need them.
4. **Never paste the access key anywhere but the person's machine** (`.env`) and your final message to them. Don't put it in a
   commit, an issue, or a command that sends it to another service.
5. **Never edit the source code** to make the setup work. If something fails, see [If something fails](#if-something-fails).

## 1. Ask

Ask only what you can't find out yourself:

1. **Where will the server run?** This computer, another computer in the house (a NAS, a Raspberry Pi, a home server), or a VPS.
   If it's another machine, you need a terminal on it (SSH); run every command below there.
2. **Which devices will connect?** If any of them is the **web app** or the **Windows desktop app**, the server needs HTTPS:
   they only connect to `https://` addresses. (Android, macOS and Linux also accept `http://`, after a warning.)
3. **How should the devices reach it?** Recommend in this order:
   - **Tailscale** (easiest): a private network with HTTPS, no domain, nothing open to the internet, and it works away from home
     too. Every device installs the Tailscale app and signs in to the same account. On a NAS, or wherever Tailscale can't be
     installed, it runs in a container instead. If one device can't run Tailscale (the web app on a computer that isn't theirs),
     Funnel makes the address public: only when they ask for it.
   - **Their own domain, with Caddy**: they have a domain, and can point it to the server and open ports 80 and 443.
   - **Their own domain, with Cloudflare Tunnel**: the domain is on Cloudflare, and they can't or won't open ports (CGNAT, a
     router they don't control). Tell them first that Cloudflare can see the traffic (titles and device credentials, not the
     notes' content).
   - **Coolify**: they already run Coolify.
   - **The same Wi-Fi, to try it**: plain `http://` on the home network, for Android, macOS and Linux only. A phone that leaves
     the house keeps using that address on other networks, unencrypted: fine to try it, Tailscale for every day. Never on a VPS.
   - **Only this computer**: the desktop app on the same machine. A phone can't use this one.

Use SQLite (the default). Choose PostgreSQL only if they ask for it: see [DEPLOYMENT.md](DEPLOYMENT.md#postgresql).

## 2. Check the machine

```sh
docker compose version                          # Docker with Compose v2. Missing: see below
uname -m                                        # x86_64 or aarch64 (arm64). armv7l: a 32-bit OS, not supported
docker ps -a --format '{{.Names}}\t{{.Ports}}'  # is a FastMemo server already here? is port 8787 taken?
```

- **No Docker:** on Linux (Raspberry Pi included), `curl -fsSL https://get.docker.com | sh` then
  `sudo usermod -aG docker $USER`, and the person logs out and back in. On Windows and macOS, they install
  [Docker Desktop](https://docs.docker.com/get-docker/) and start it.
- **`armv7l` on a Raspberry Pi:** the image needs the 64-bit Raspberry Pi OS. Tell them; it means reinstalling the OS.
- **A container named `fastmemo-server` already exists:** FastMemo Server is already installed here. Stop and ask: they probably
  want to update it ([Updating](#6-hand-over)) or connect a device to it, not a second server.
- **Port 8787 already in use** (by Docker, or `lsof -iTCP:8787 -sTCP:LISTEN` on macOS and Linux shows a program): choose another
  port, e.g. 8788. Below, `<port>` is the one you chose.

## 3. Get the code and the settings

```sh
git clone https://github.com/ontech7/fastmemo-server.git
cd fastmemo-server
cp .env.example .env
```

Then edit `.env`:

- `FASTMEMO_ACCESS_KEY` (required: the server doesn't start without it): a random key, the output of `openssl rand -hex 24`, or
  with no `openssl`: `docker run --rm node:24-alpine node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.
  Tell the person to keep it in a password manager: the server never shows it.
- `TZ`: the person's time zone (e.g. `Europe/Rome`, `America/New_York`). On Linux, `timedatectl show -p Timezone --value`; on
  macOS, `readlink /etc/localtime | sed 's|.*zoneinfo/||'`.
- `PORT`: `<port>` if 8787 was taken. With Tailscale, on a VPS, or for "only this computer": `127.0.0.1:<port>`, so the server
  isn't reachable from the network on its own.
- Behind Tailscale or Caddy: `TRUST_PROXY=true`.

Leave the rest as it is.

## 4. Start it and give it HTTPS

The first start downloads the image `ghcr.io/ontech7/fastmemo-server`. If the download fails, Compose builds it from the cloned
folder instead: that's expected. It takes a few minutes and prints a lot, npm warnings included; only the last lines matter.

### Tailscale

1. Install Tailscale on the server: `curl -fsSL https://tailscale.com/install.sh | sh` (Linux), or the app from
   [tailscale.com/download](https://tailscale.com/download).
2. `sudo tailscale up`. It prints a login link: **the person opens it** and signs in.
3. `docker compose up -d`
4. `sudo tailscale serve --bg <port>`. It prints the address, like `https://raspberrypi.tail1234.ts.net`. If it asks to enable
   HTTPS certificates or MagicDNS, it prints a link: **the person opens it** and enables them, then run the command again.
5. The person installs Tailscale on every device that will use FastMemo, signed in to the same account.
6. Tell the person to turn off key expiry for the server (admin, **Machines**, the server's menu, **Disable key expiry**):
   otherwise Tailscale signs it out after 180 days.

### Tailscale in a container (a NAS, or no Tailscale on the machine)

1. The person turns on **HTTPS Certificates** and MagicDNS on the **DNS** page of the Tailscale admin
   ([login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns)).
2. `docker compose -f docker-compose.tailscale.yml up -d`
3. `docker compose -f docker-compose.tailscale.yml logs tailscale` shows a link after `To authenticate, visit:`. **The person
   opens it** and signs in. (Or, if they gave you an auth key, set `TS_AUTHKEY` in `.env` before step 2.)
4. The address is `https://fastmemo.<their-tailnet>.ts.net`: the **Machines** page of the admin shows the full name, and
   `docker compose -f docker-compose.tailscale.yml exec tailscale tailscale status` lists it.
5. As above: Tailscale on every device, and key expiry off for the server.

With this compose file, add `-f docker-compose.tailscale.yml` to every `docker compose` command below.

### Tailscale Funnel (only when they ask)

On top of Tailscale: `sudo tailscale funnel --bg <port>` (in a container: `AllowFunnel` to `true` in `tailscale/serve.json`).
The first time, it prints a link to allow Funnel: **the person opens it**. The address stays the same, now public. Make sure
`FASTMEMO_ACCESS_KEY` is long (`openssl rand -hex 24`).

### Caddy (their own domain)

1. Check that the domain points to this server: the address from `dig +short notes.example.com` (or `nslookup`) must be the
   server's public address. If not, the person fixes the DNS record first (it can take a while to update).
2. Ports 80 and 443 must reach the server: open them in the VPS firewall or forward them on the home router.
3. Set `DOMAIN=notes.example.com` in `.env`, then `docker compose -f docker-compose.caddy.yml up -d`.
4. The address is `https://notes.example.com`. The first start takes a minute while Caddy gets the certificate.

With this compose file, add `-f docker-compose.caddy.yml` to every `docker compose` command below.

### Cloudflare Tunnel (their own domain, no open ports)

1. **The person** creates the tunnel in the Cloudflare dashboard: **Networking → Tunnels → Create a tunnel**, any name, then
   Docker. They give you the long text after `--token` in the command it shows. It's a secret: it goes in `.env` only.
2. Set `CLOUDFLARE_TUNNEL_TOKEN=<that text>` in `.env`, then `docker compose -f docker-compose.cloudflare.yml up -d`.
3. `docker compose -f docker-compose.cloudflare.yml logs cloudflared` should show `Registered tunnel connection`. The dashboard
   now shows the tunnel as connected.
4. **The person** adds the route in the tunnel: **Routes → Add route → Published application**, a subdomain (e.g. `notes`),
   their domain, and the service URL `http://fastmemo:8787` (exactly this: `fastmemo` is the server's name inside Docker).
5. The address is `https://notes.example.com`.

With this compose file, add `-f docker-compose.cloudflare.yml` to every `docker compose` command below.

### Coolify

Coolify is set up in its web interface: guide the person through [DEPLOYMENT.md](DEPLOYMENT.md#coolify). Coolify generates the
keys; the access key is `SERVICE_PASSWORD_64_ACCESSKEY` under Environment Variables. Then go to step 5 with their domain.

### The same Wi-Fi

1. `docker compose up -d`
2. The computer's address on the home network: `ipconfig getifaddr en0` on macOS, `hostname -I` on Linux, `ipconfig` on Windows
   (the IPv4 address). The server's address is `http://<that address>:<port>`.
3. Tell the person: the router may give the computer a new address one day (then the app needs the new one), and the first time
   a phone connects, the computer's firewall may ask to allow incoming connections: allow them.

### Only this computer

`docker compose up -d`. The address is `http://localhost:<port>`.

### After a reboot

The container starts again on its own (`restart: unless-stopped`), once Docker runs. On macOS and Windows, that means Docker
Desktop: turn on **Settings → General → Start Docker Desktop when you sign in**.

## 5. Check that it works

Run these on the server, with the key from `.env` (or from the logs):

```sh
docker compose ps                                   # fastmemo: "Up ... (healthy)", within about 30 seconds
curl -fsS http://127.0.0.1:<port>/v1/health         # {"ok":true}
curl -fsS -H "X-Access-Key: <the key>" http://127.0.0.1:<port>/v1/info   # ..."protocol":1...
```

With Caddy, Coolify, Cloudflare Tunnel or Tailscale in a container, port 8787 isn't published: skip the two `curl` lines above.
Then, with the address from step 4:

```sh
curl -fsS -H "X-Access-Key: <the key>" <address>/v1/info    # ..."protocol":1...
```

For Tailscale, run that one from another device on the tailnet (or on the server itself). The logs always say `"port":8787`:
it's the port inside the container, whatever `<port>` is. If they show `Configuration error: ...`, a value in `.env` is wrong:
the message says which one.

## 6. Hand over

Tell the person, in plain words:

1. **The address** (e.g. `https://raspberrypi.tail1234.ts.net`) and **the access key**. They should keep the key in a password
   manager: every device needs it to connect, and anyone who has it can join the server.
2. **The dashboard**: the same address in a browser. It opens with the access key (or with `FASTMEMO_ADMIN_KEY`, if you set
   one). It shows devices, space used and warnings, and makes backups.
3. **In the app**, on each device: **Settings → Cloud Sync**, turn on **Enable Cloud sync**, choose **FastMemo Server** in
   **Sync with**, enter the address and the access key, then **Save settings**. With `http://`, the app warns first: they
   accept. The first device asks for an **encryption password** and shows a **recovery key**: they write the recovery key down.
   Without the password or the recovery key, nobody can read the notes, not even them.
4. **The server runs while this machine is on** (and, on a Mac or PC, while Docker Desktop runs).
5. **Backups**: the dashboard's **Download a backup** button, or the script in the [README](../README.md#backups-and-restore). A
   backup holds the titles and the device list: keep it private.
6. **Updating**, in the `fastmemo-server` folder: `git pull`, then `docker compose pull` and `docker compose up -d`. If
   `docker compose pull` fails (`denied`, `not found`), run `docker compose up -d --build` instead: it builds the new version
   from the folder.

## If something fails

| What you see                                                 | What to do                                                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `Configuration error: ...` in `docker compose logs fastmemo` | Fix that value in `.env` (keys need 16+ characters), then `docker compose up -d`.                                                 |
| `port is already allocated`                                  | Another program uses the port: set another `PORT` in `.env`, then `docker compose up -d`.                                         |
| `container name "/fastmemo-server" is already in use`        | FastMemo Server is already installed on this machine (see [step 2](#2-check-the-machine)): ask before going on.                   |
| `permission denied` on the Docker socket                     | The user isn't in the `docker` group yet: `sudo usermod -aG docker $USER`, then log out and back in.                              |
| `/v1/health` works on the server but not from outside        | The HTTPS step: Tailscale not serving (`tailscale serve status`), DNS not pointing to the server, or ports 80/443 closed.         |
| `required variable CLOUDFLARE_TUNNEL_TOKEN is missing`       | Set the token in `.env`, then run the command again.                                                                              |
| `Provided Tunnel token is not valid` (logs of `cloudflared`) | The token was copied wrong: copy it again from the tunnel in the Cloudflare dashboard, then `up -d` again.                        |
| Cloudflare: the page shows a 502 or "Bad gateway"            | The route's service URL is wrong: it must be `http://fastmemo:8787`.                                                              |
| Tailscale container: the address doesn't answer              | Not signed in (the link in its logs), or HTTPS Certificates off on the admin's DNS page.                                          |
| The app says the key is wrong                                | Compare it with `.env` (or the logs). After 20 wrong tries in 15 minutes, the address is refused for a while: wait a few minutes. |
| The web app or the Windows app can't connect to `http://`    | They need HTTPS: set up Tailscale or Caddy.                                                                                       |

Anything else: [DEPLOYMENT.md → Troubleshooting](DEPLOYMENT.md#troubleshooting), then the logs
(`docker compose logs --tail 100 fastmemo`). If it's still stuck, stop and tell the person what you saw; don't change the code.
