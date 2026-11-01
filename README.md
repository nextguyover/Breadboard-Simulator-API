# Breadboard Simulator API

A small self-hosted backend for Breadboard Simulator. The web app's **Report a
bug** option posts reports here, they are saved in SQLite, and you can read and
triage them on a built-in admin page. The app's launch ping also feeds an
**Analytics** tab: launches over time, countries, cities, devices and browsers.

- No dependencies: plain Node.js 22.13+ (uses the built-in `node:sqlite`).
- Runs as a normal systemd service, made for a small Debian/Ubuntu LXC on
  Proxmox behind Cloudflare.
- Per-IP rate limits, a honeypot field, size limits, and a CORS allow-list.
- Raw IPs are never stored, only a salted hash.

The full API is in [docs/API.md](docs/API.md).

## Install on an LXC (Debian 12/13 or Ubuntu 24.04)

```sh
# 1. Node.js 22 (skip if `node -v` already shows 22.13 or newer)
apt-get update && apt-get install -y curl git ca-certificates openssh-client
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

# 2. A read-only deploy key, because the repo is private
ssh-keygen -t ed25519 -N "" -f /root/.ssh/bsim_api_deploy -C bsim-api-lxc
cat /root/.ssh/bsim_api_deploy.pub
#    Paste it in GitHub: repo Settings > Deploy keys > Add deploy key
#    (leave "Allow write access" unticked).
cat >> /root/.ssh/config <<'CFG'
Host github-bsim-api
  HostName github.com
  User git
  IdentityFile /root/.ssh/bsim_api_deploy
  IdentitiesOnly yes
CFG
ssh-keyscan github.com >> /root/.ssh/known_hosts

# 3. Clone and install
git clone github-bsim-api:nextguyover/Breadboard-Simulator-API.git /opt/breadboard-simulator-api-src
/opt/breadboard-simulator-api-src/deploy/install.sh
```

`install.sh` copies the app to `/opt/breadboard-simulator-api`, creates a
`bsimapi` system user, writes `/etc/breadboard-simulator-api.env` with a fresh
admin token (printed once), installs the systemd unit, starts it on
`127.0.0.1:8787`, and links the `bsim-api-update` command.

## Updating

Updates are automatic. Every minute a systemd timer checks the `prod` branch
(set `DEPLOY_BRANCH` in the env file to change it). When there is a new
commit it runs the tests, installs it and restarts the service, and rolls
back if the service doesn't come up healthy. A version that fails is not
retried until something newer lands. So releasing is just:

```sh
git push origin main:prod
```

To update by hand right away: `bsim-api-update`. To see what the updater did:
`journalctl -u breadboard-simulator-api-update`. To turn auto-updates off for
good: `touch /etc/breadboard-simulator-api.no-auto-update && systemctl disable --now breadboard-simulator-api-update.timer`.

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

## Analytics

The **Analytics** tab on `/admin` counts app launches (one ping per app load)
and shows them over time and by country, city, device, OS, browser and hour.
Countries work out of the box behind Cloudflare. For cities, turn on
**Add visitor location headers** in the Cloudflare dashboard under Rules,
Settings (Managed Transforms). To leave out bots and see which networks
launches come from, add the small header rule described in
[docs/API.md](docs/API.md#launch-analytics).

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
