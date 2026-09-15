<p align="center">
	<img width="96" height="96" src="assets/images/logo.svg">
</p>

# Xiri Track

Xiri Track is a public Minecraft network statistics dashboard, hosted at **https://track.xiri.ventures**.
It shows live player counts, 24 hour peaks, all-time records and a historical graph so networks can be compared over time.

Xiri Track is a small, maintained fork of [Minetrack](https://github.com/Cryptkeeper/Minetrack) by Cryptkeeper, which is archived upstream.
The fork keeps Minetrack's architecture and dashboard, and focuses on a supported runtime, security fixes and a reliable Docker deployment with persistent history.
See [docs/CHANGELOG.md](docs/CHANGELOG.md) for what changed compared to Minetrack 5.6.1.

## Tracked networks

| Order | Name     | Address             | Edition |
|-------|----------|---------------------|---------|
| 1     | CrabbyMC | `play.crabbymc.fun` | Java    |
| 2     | AshSMP   | `play.ashsmp.in`    | Java    |

Each network has its own history, peak and record. A "Total Players" card in the header shows the sum of the current player counts; it is calculated in the browser and is not stored as a separate series.

`play.ashsmp.in` is a CNAME to the GrootShield DDoS protection service (`shield.grootop.in`). Intermittently (around one in five pings during testing) the shield cannot reach the AshSMP backend and, after ~5 seconds, answers with its own "Server Offline or Invalid hostname" status without a player count. Those pings are stored as failed pings (small gaps in the graphs), they do not affect peaks or records. `rates.connectTimeout` is 8 seconds so this fallback is received and logged as an invalid player count instead of a generic socket timeout.

## How it works

A single Node.js process:

- pings every server in `servers.json` every `rates.pingAll` milliseconds (Minecraft status protocol, SRV records supported),
- stores every result in SQLite (`pings` table) and keeps the all-time record per server (`players_record` table),
- serves the dashboard (bundled from `assets/` into `dist/` by Parcel) and pushes live updates to browsers over a WebSocket on the same port,
- rebuilds the last 24 hours of the graph from the database on startup.

Endpoints: `/` and static assets, the WebSocket (same URL), and `GET /healthz` (`200 {"status":"ok"}` while ping rounds complete, `503` otherwise). There is no admin interface.

## Local development

Requirements: Node.js 24 LTS (>= 22.13) and npm.

```bash
npm ci
npm run build      # lint + bundle assets/ into dist/
npm start          # http://localhost:8080
```

- `npm run dev` builds without minification, `npm run lint` only lints.
- Rebuild after changing anything in `assets/`; restart after changing `lib/`, `config.json` or `servers.json`.
- Locally the database is `database.sql` and the log is `minetrack.log` in the repository directory (both ignored by Git).
- `config.json` listens on `0.0.0.0:8080`, which is required inside Docker. For local development on an untrusted network, use `"ip": "127.0.0.1"` without committing it.

## Configuration

No secrets are required. All configuration is committed to this repository.

### servers.json

```json
[
  { "name": "CrabbyMC", "ip": "play.crabbymc.fun", "type": "PC", "color": "#FF7A45" },
  { "name": "AshSMP", "ip": "play.ashsmp.in", "type": "PC", "color": "#5EC8F2" }
]
```

| Field     | Required | Description |
|-----------|----------|-------------|
| `name`    | yes      | Display name. Must be unique, browsers store favorites by name. |
| `ip`      | yes      | Hostname or IP. **Also the database key**: changing it starts a new, empty history for that server. |
| `type`    | yes      | `PC` (Java Edition) or `PE` (Bedrock Edition). |
| `port`    | no       | Defaults to 25565 (`PC`) or 19132 (`PE`). An SRV record takes precedence for `PC`. |
| `color`   | no       | Graph color, generated from the name when omitted. |
| `favicon` | no       | File name inside a `favicons/` directory, overrides the server's own icon. |

The order of the file is the default order of the dashboard ("Sort By: Default"). Visitors can switch to sorting by players, 24h peak or record.

### config.json

| Key | Value | Description |
|-----|-------|-------------|
| `site.ip`, `site.port` | `0.0.0.0`, `8080` | Listen address inside the container. |
| `rates.pingAll` | `10000` | Ping interval in ms. |
| `rates.connectTimeout` | `8000` | Ping timeout in ms (includes DNS). Must be lower than `pingAll`. |
| `logToDatabase` | `true` | Store pings in SQLite. Required for history, peaks and records. |
| `graphDuration` | `86400000` | Time span of the historical graph and the peak (24h). |
| `serverGraphDuration` | `600000` | Time span of the small per-server graphs (10 minutes). |
| `oldPingsCleanup.enabled` | `false` | When `true`, pings older than `graphDuration` are deleted. Records survive, long-term raw history does not. |
| `logFailedPings` | `true` | Log ping failures. |
| `databaseFile` | (unset) | Database path, overridden by `MINETRACK_DATABASE_FILE`. Default `database.sql`. |
| `logFile` | (unset) | Log file path, overridden by `MINETRACK_LOG_FILE`. Empty disables file logging. Default `minetrack.log`. |

Optional upstream keys that still work: `graphDurationLabel`, `skipSrvTimeout`, `createDailyDatabaseCopy`.

## Production deployment (Docker)

```text
Visitor
  -> Cloudflare (proxied DNS record, TLS)
  -> Caddy or nginx on the server (TLS, security headers, WebSocket upgrade)
  -> Minetrack container on 127.0.0.1:8080 (not reachable from the internet)
  -> SQLite database in /opt/xiri-track/data on the host
```

Requirements on the server: Docker Engine with the Compose plugin, Git, and a reverse proxy on the host.

The container runs as the unprivileged `node` user (uid 1000) with a read-only root filesystem, no Linux capabilities and `no-new-privileges`. Only `/data` is writable. Docker logs are rotated (3 x 10 MB).

### First deployment

```bash
sudo git clone https://github.com/XIRI-VENTURES-SRL/minetrack.git /opt/xiri-track
cd /opt/xiri-track
sudo git checkout main

# Persistent data directory, writable by the container user (uid 1000)
sudo mkdir -p data
sudo chown 1000:1000 data

sudo docker compose up -d --build
sudo docker compose ps                     # wait for "(healthy)"
curl -fsS http://127.0.0.1:8080/healthz    # {"status":"ok"}
sudo docker compose logs --tail 50 minetrack
```

`compose.yml` refuses to start when `data/` does not exist, instead of letting Docker create a root-owned directory the container cannot write to.

### Reverse proxy

**Caddy** (already used on the Xiri VPS): add the site block from [deploy/Caddyfile](deploy/Caddyfile) to `/etc/caddy/Caddyfile`, then:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

```caddy
track.xiri.ventures {
	encode zstd gzip
	header {
		# see deploy/Caddyfile for the full set of security headers
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
	reverse_proxy 127.0.0.1:8080
}
```

Caddy forwards WebSocket upgrades automatically. If Caddy itself runs in a container, `127.0.0.1` is the Caddy container: publish Minetrack on the host and use `host.docker.internal:8080` with `extra_hosts: ["host.docker.internal:host-gateway"]`, or attach both containers to one Docker network and proxy to `minetrack:8080`.

**nginx**: use [deploy/nginx/track.xiri.ventures.conf](deploy/nginx/track.xiri.ventures.conf). The important WebSocket parts are `proxy_http_version 1.1`, the `Upgrade`/`Connection` headers and a long `proxy_read_timeout`.

### Cloudflare

- DNS: `track` record for `xiri.ventures` pointing to the server (`A` to its IPv4, and `AAAA` to its IPv6 if the server has one), **proxied** (orange cloud).
- SSL/TLS encryption mode: **Full (strict)**. Caddy obtains a certificate automatically; for nginx use a Cloudflare Origin CA certificate.
- WebSockets are enabled by default on Cloudflare, no setting is needed.
- Keep Rocket Loader and Email Address Obfuscation off for this hostname, they inject inline scripts that the Content Security Policy blocks.
- Optional: only allow ports 80/443 from [Cloudflare IP ranges](https://www.cloudflare.com/ips/) in the server firewall. Note that ports published by Docker bypass ufw, which is why Minetrack is only published on `127.0.0.1`.

## Persistent data

| Host | Container | Contents |
|------|-----------|----------|
| `/opt/xiri-track/data/database.sql` | `/data/database.sql` | SQLite database with all history and records |
| `/opt/xiri-track/data/backups/` | `/data/backups/` | Backups created by `scripts/backup.sh` |

Tables: `pings (timestamp, ip, playerCount)` with one row per server per ping (`playerCount` is `NULL` for failed pings, `timestamp` in milliseconds) and `players_record (ip, playerCount, timestamp)`.

With two servers and a 10 second interval the database grows by roughly 17,000 rows per day, in the order of a few hundred MB per year.

The data directory is a bind mount, so rebuilding the image, recreating the container and `docker compose down` do not touch it. Things that **do** delete history:

- deleting `data/` or `data/database.sql`,
- `git clean -fdx` in `/opt/xiri-track` (`data/` is ignored by Git and would be removed),
- changing a server's `ip` in `servers.json` (the old history stays in the database but is no longer shown).

## Backups

`scripts/backup.sh` takes an online, consistent SQLite backup inside the running container (`sqlite3 .backup`), verifies it with `PRAGMA integrity_check`, compresses it and keeps the 14 most recent copies (`KEEP=30 scripts/backup.sh` to keep more).

```bash
cd /opt/xiri-track
sudo scripts/backup.sh
ls -lh data/backups/
```

Daily at 03:17 via root's crontab (`sudo crontab -e`):

```cron
17 3 * * * cd /opt/xiri-track && scripts/backup.sh >> /var/log/xiri-track-backup.log 2>&1
```

Copy `data/backups/` off the server as well (e.g. `rsync`, `rclone` or a storage box), a backup on the same disk does not survive losing that disk.

Manual one-off backup without the script:

```bash
sudo docker compose exec minetrack sqlite3 /data/database.sql ".backup '/data/manual-backup.sql'"
```

### Restore

```bash
cd /opt/xiri-track
sudo docker compose stop minetrack
sudo cp data/database.sql data/database.sql.before-restore
gunzip -c data/backups/database-YYYYMMDDTHHMMSSZ.sql.gz | sudo tee data/database.sql > /dev/null
sudo rm -f data/database.sql-journal
sudo chown 1000:1000 data/database.sql
sudo docker compose start minetrack
```

## Updating and redeploying

History is kept across updates because it lives in `data/`, outside the image and the container.

```bash
cd /opt/xiri-track
sudo scripts/backup.sh               # recommended before every update
sudo git pull
sudo docker compose up -d --build    # rebuilds and recreates the container, data/ is reused
sudo docker compose ps               # wait for "(healthy)"
```

On stop, Minetrack closes WebSocket connections and the database cleanly; browsers reconnect automatically.

To roll back, check out the previous commit (`sudo git checkout <commit>`) and run `sudo docker compose up -d --build` again.

To refresh the Node.js base image and Debian packages for security updates without code changes:

```bash
sudo docker compose build --pull
sudo docker compose up -d
```

## Upstream

This repository has the original project configured as the `upstream` remote, to inspect future changes:

```bash
git remote add upstream https://github.com/Cryptkeeper/Minetrack.git   # once
git fetch upstream
git log --oneline main..upstream/main
```

## License and attribution

Xiri Track is based on [Minetrack](https://github.com/Cryptkeeper/Minetrack), created by Nick Krecklow (Cryptkeeper) and contributors, released under the [MIT License](LICENSE) (Copyright (c) 2015 Cryptkeeper). The original license applies to this fork. Upstream documentation: [CHANGELOG](docs/CHANGELOG.md), [Migrating to Minetrack 5](docs/MIGRATING.md).
