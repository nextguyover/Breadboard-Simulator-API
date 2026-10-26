# Breadboard Simulator API

A small self-hosted backend for Breadboard Simulator. For now it does one job:
the web app's **Report a bug** option posts reports here, they are saved in
SQLite, and you can read and triage them on a built-in admin page.

- No dependencies: plain Node.js 22.13+ (uses the built-in `node:sqlite`).
- Runs as a normal systemd service, made for a small Debian/Ubuntu LXC on
  Proxmox behind Cloudflare.
- Per-IP rate limits, a honeypot field, size limits, and a CORS allow-list.
- Raw IPs are never stored, only a salted hash.

The full API is in [docs/API.md](docs/API.md).

## Install on an LXC (Debian 12/13 or Ubuntu 24.04)

```sh
# 1. Node.js 22 (skip if `node -v` already shows 22.13 or newer)
apt-get update && apt-get install -y curl git ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

# 2. The service
git clone https://github.com/nextguyover/Breadboard-Simulator-API.git /root/breadboard-simulator-api
cd /root/breadboard-simulator-api
./deploy/install.sh
```

`install.sh` copies the app to `/opt/breadboard-simulator-api`, creates a
`bsimapi` system user, writes `/etc/breadboard-simulator-api.env` with a fresh
admin token (printed once), installs the systemd unit and starts it on
`127.0.0.1:8787`. Run it again after `git pull` to update; your env file and
data are kept.

Settings live in `/etc/breadboard-simulator-api.env` (see
[the example](deploy/breadboard-simulator-api.env.example)). After editing it:
`systemctl restart breadboard-simulator-api`.

If the unit fails with `status=226/NAMESPACE`, turn on **nesting** for the
container in Proxmox (Options, Features) or comment out the hardening lines in
the unit file.

## Put it behind Cloudflare

The simplest setup is a Cloudflare Tunnel from inside the container, so no
port is opened and the `CF-Connecting-IP` header can be trusted:

1. In the Cloudflare dashboard, Zero Trust, Networks, Tunnels: create a tunnel
   and run the install command it gives you inside the LXC.
2. Add a public hostname, e.g. `api.breadboardsimulator.com`, pointing to
   `http://127.0.0.1:8787`.
3. Keep `TRUST_CLOUDFLARE=1` in the env file. If you expose the port any other
   way, only allow Cloudflare's IP ranges to reach it, or set
   `TRUST_CLOUDFLARE=0`.

Then set `ALLOWED_ORIGINS` to the web app's origin(s) and build the app with
`VITE_BUG_REPORT_URL=https://api.breadboardsimulator.com`.

## Reading reports

Open `https://<your api host>/admin` and paste the admin token. You can filter
by status, open a report (description, contact, version, browser, screenshot,
diagnostics), open the attached circuit straight in the app, set a status
(`new`, `triaged`, `fixed`, `wontfix`, `duplicate`, `spam`), add a private
note, or delete it. The same actions are available over the API with
`Authorization: Bearer <token>`.

Lost the token? It is `ADMIN_TOKEN` in `/etc/breadboard-simulator-api.env`.

## Backups

Everything is in `/var/lib/breadboard-simulator-api/reports.db`. Proxmox
backups of the container cover it. For a standalone copy while it runs:

```sh
apt-get install -y sqlite3
sqlite3 /var/lib/breadboard-simulator-api/reports.db ".backup /root/reports-$(date +%F).db"
```

## Development

```sh
ADMIN_TOKEN=dev-token-dev-token-dev-token IP_HASH_SALT=dev-salt-dev-salt \
  ALLOWED_ORIGINS=http://localhost:5173 APP_URL=http://localhost:5173/ \
  DB_PATH=./data/reports.db npm start
npm test
```

Logs: `journalctl -u breadboard-simulator-api -f`.
