# CrabbyMC history import

Xiri Track started tracking both networks on **2026-09-15 08:45:40 UTC**. To show CrabbyMC's history from its launch period, the concurrent player counts from before that moment were imported once from CrabbyDashboard.

## Provenance

| Period (UTC) | CrabbyMC (`play.crabbymc.fun`) | AshSMP (`play.ashsmp.in`) |
|---|---|---|
| 2026-08-11 09:07 to 2026-09-15 08:45 | **Imported from CrabbyDashboard**, one value per minute | no data (not backfilled) |
| from 2026-09-15 08:45:40 | **Collected by Xiri Track**, a ping every 10 seconds | **Collected by Xiri Track**, a ping every 10 seconds |

Imported rows can be recognised in the `pings` table: they belong to `play.crabbymc.fun`, lie before `1789461940315` (the first live ping) and their timestamps are whole minutes. Unique player counts were not imported; they are a separate metric in CrabbyDashboard.

## Source

- **CrabbyDashboard Supabase project** `CrabbyMC` (`pfqwboochpmudpwgbsnf`), table `public.server_heartbeats`, columns `server_id`, `online_players`, `reported_at` (`timestamptz`, UTC).
- The CrabbyStats plugin on every backend server of the network reports its own online player count about every **3 seconds** (ingested through CrabbyLanding `POST /api/heartbeat`).
- Servers used: `lobby`, `economy`, `lifesteal`, `events`, `dev`. These are the realms behind `play.crabbymc.fun` (`servers` table: "Java Network"). Test IDs (`cra348-probe`, `cutover_pre_release_20260825`) are excluded. No player ever had overlapping sessions on `dev`/`events` and another realm, consistent with one network proxy.
- First heartbeat: 2026-08-11 09:07:09 UTC. CrabbyDashboard's `server_checks` show `play.crabbymc.fun` offline in every check before 2026-08-11 08:06 UTC, when it was first seen online, so the heartbeats cover the network from its first day.

Sources that were considered and not used:

- `player_sessions` (join/leave sessions, used by CrabbyDashboard's `admin_player_activity_series` for `peak_concurrent` and `unique_players`): only starts on 2026-08-25 19:37 UTC and is reconstructed from join/leave events (7,641 legacy rows without a server key, some zero-length or stale-open sessions). It was used to validate the heartbeat rule instead.
- `server_checks`: 70 irregular checks of `play.crabbymc.fun` in two months, too sparse for history.

## Aggregation rule

For each UTC minute:

1. At each 10 second instant of the minute (`:00`, `:10`, ..., `:50`, the same cadence as Xiri Track's own pings), take for every server the **lowest** `online_players` it reported in the preceding 7 seconds. A server without a report in those 7 seconds counts as offline.
2. Sum those values over all servers.
3. The minute's value is the **highest** of the six sums. It is stored as one ping at the start of the minute.

Minutes in which no instant has a recent report are omitted, so outages remain gaps. Nothing is interpolated or estimated.

Why this rule:

- **Maximum per minute** keeps real peaks, which matters for the 24h peak and the all-time record. A single sample per minute understated volatile minutes badly (e.g. 38 instead of 109 players on 2026-08-27 16:05).
- **The lowest recent report per server** prevents counting players twice. Server heartbeats are not synchronised: when a server restarts or players move between servers, one server may already report the players while another still reports them. Summing the latest reports produced false spikes (e.g. 68 instead of 47 when the economy server restarted on 2026-09-06 12:00, and a false 142 record on 2026-08-27 where session data shows 138).
- **7 seconds** is a little over two heartbeat intervals, so a server that stops reporting is treated as offline almost immediately.

Validation:

- Against **Xiri Track's own live pings** in the overlap period 2026-09-15 08:46 to 09:30 UTC: the rule matched Xiri Track's per-minute maximum exactly in 37 of 45 minutes and within 1 player in 44 of 45 (tendency to read 1 low when players join).
- Against **CrabbyDashboard session concurrency** (distinct players online) during the busiest surge (2026-08-27 15:59 to 16:12 UTC): within 0 to 3 players, peak 138 against 138/139.
- Remaining known deviation: 56 against 50 session players for one minute during the 2026-09-06 12:02 event start.

## Procedure

Run on the VPS in `/opt/xiri-track`. `scripts/` is not part of the image, so it is mounted into a one-off container that uses the same image and the same `data/` bind mount.

1. Export (reads CrabbyDashboard and Xiri Track's database, writes only the CSV). The Supabase service key is read from CrabbyLanding's environment at run time and never written anywhere:

   ```bash
   envval() { sed -n "s/^$1=//p" /opt/crabby-landing/.env | head -1 | sed -E "s/\r$//; s/^['\"]//; s/['\"]$//"; }
   SUPABASE_URL="$(envval SUPABASE_URL)" SUPABASE_SERVICE_ROLE_KEY="$(envval SUPABASE_SERVICE_ROLE_KEY)" \
     docker compose run --rm --no-deps -T -e SUPABASE_URL -e SUPABASE_SERVICE_ROLE_KEY \
     -v /opt/xiri-track/scripts:/app/scripts:ro \
     minetrack node scripts/import-crabby-history.js export --out /data/import/crabbymc-history.csv < /dev/null
   ```

   The cutoff defaults to the earliest existing `play.crabbymc.fun` ping (the start of live tracking); only whole minutes ending at or before it are exported.

2. Dry-run (no changes):

   ```bash
   docker compose run --rm --no-deps -T -v /opt/xiri-track/scripts:/app/scripts:ro \
     minetrack node scripts/import-crabby-history.js import --in /data/import/crabbymc-history.csv < /dev/null
   ```

3. Stop Minetrack, take a verified backup, apply, start Minetrack. Minetrack keeps the player record in memory, so it must not run during the import, otherwise it could overwrite the imported record. The script refuses to apply if a ping was written in the last 45 seconds.

   ```bash
   docker compose stop minetrack
   cp -p data/database.sql data/backups/database-pre-crabby-import-$(date -u +%Y%m%dT%H%M%SZ).sql
   docker compose run --rm --no-deps -T -v /opt/xiri-track/scripts:/app/scripts:ro \
     minetrack node scripts/import-crabby-history.js import --in /data/import/crabbymc-history.csv --apply < /dev/null
   docker compose up -d
   ```

The import validates every row (whole-minute timestamps, integer counts between 0 and 250,000, no duplicates, all before the cutoff), refuses existing non-imported rows inside the import range, inserts in a single transaction, and skips rows that already exist, so running it again inserts nothing. Afterwards it checks `PRAGMA integrity_check`, that there are no duplicate CrabbyMC timestamps and that the other servers' rows are unchanged. CrabbyMC's `players_record` is set to the higher of the imported maximum and the existing record; AshSMP's record is not touched.

To undo the import, stop Minetrack and copy the `database-pre-crabby-import-*.sql` backup back to `data/database.sql` (see "Restore" in the README).

## Caveats

- Imported history has one value per minute; live history has a ping every 10 seconds. Graphs show both the same way (one point per minute).
- Imported values count players connected to the network's backend servers. Players still connecting through the proxy but not yet on a server are not included, and a heartbeat outage of a single server undercounts until it reports again.
- During abrupt mass transitions (server restarts, event starts) a minute can still be a few players off, see the validation above.
- The minutes in which Minetrack was stopped for the import are a gap in the live history.

## Import run (2026-09-15)

| | |
|---|---|
| Heartbeats read | 2,808,412 (0 rejected) |
| Minutes exported | 50,286, from 2026-08-11 09:07 to 2026-09-15 08:44 UTC |
| Rows inserted / skipped | 50,286 / 0 |
| Gaps in the imported history | one: 92 minutes on 2026-08-27 12:00 to 13:31 UTC, no server sent heartbeats |
| CrabbyMC earliest ping | before 2026-09-15 08:45:40.315 UTC, after 2026-08-11 09:07:00 UTC |
| CrabbyMC record | before 22 (2026-09-15 10:00:50 UTC), after **138** (2026-08-27 16:11 UTC) |
| AshSMP | rows and record unchanged (fingerprint compared before and after) |
| Highest daily imported peaks | 2026-08-27: 138, 2026-09-06: 61, 2026-09-13: 56, 2026-08-30: 50 |
| Checks | `integrity_check` ok before and after, no duplicate timestamps, 42 minutes compared against values computed directly in CrabbyDashboard's database: all identical |
| Backup before the import | `/opt/xiri-track/data/backups/database-pre-crabby-import-20260915T101219Z.sql` |
| Tracker downtime | 2026-09-15 10:12:19 to 10:12:40 UTC |
| Export file | `/opt/xiri-track/data/import/crabbymc-history.csv` |

A first attempt at 10:03 UTC stopped before writing anything, because the running-tracker check misread a tracker that had been stopped seconds earlier (fixed in the script). Its backup, `database-pre-crabby-import-20260915T100316Z.sql`, is from before any import as well.
