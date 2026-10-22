# Security policy

FastMemo Server holds your devices' encrypted notes and, optionally, can restart itself on a newer release. If you find a way
around that, please tell us privately before telling anyone else.

## Reporting

Use GitHub's **Report a vulnerability** button on the Security tab of this repository. Include the version (the dashboard shows
it, and so does `/v1/info`), what an attacker needs (the access key, a device token, network access, a local account) and the
steps to reproduce. Please don't open a public issue for it.

You will get an answer within 7 days. Fixes ship with a regression test in `test/hardening.test.ts` and a `### Security` entry
in `CHANGELOG.md` (the dashboard flags a release with that section as a security update), and are credited in the release notes
unless you prefer otherwise.

## Scope

In scope: the sync API (`/v1`), the dashboard and its API (`/admin`), the host updater (`contrib/updater`), the container image
and the compose files. Out of scope: attacks that need root on the host (the updater itself runs as root, and the Docker socket
is root anyway), and the proxy or tunnel provider (Tailscale, Cloudflare, Caddy's host) reading or delaying the traffic it
carries.

## Supported versions

The latest minor version gets security fixes. Update with the dashboard's **Install** button or the commands in the
[README](README.md#updates).
