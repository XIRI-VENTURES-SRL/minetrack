# CrabbyMC history import

Xiri Track started tracking both networks on **2026-09-15 08:45:40 UTC**. To show CrabbyMC's history from its launch period, the concurrent player counts from before that moment were imported once from CrabbyDashboard.

## Provenance

| Period (UTC) | CrabbyMC (`play.crabbymc.fun`) | AshSMP (`play.ashsmp.in`) |
|---|---|---|
| 2026-08-11 09:07 to 2026-09-15 08:45 | **Imported from CrabbyDashboard**, one value per minute | no data (not backfilled) |
| from 2026-09-15 08:45:40 | **Collected by Xiri Track**, a ping every 10 seconds | **Collected by Xiri Track**, a ping every 10 seconds |

Imported rows can be recognised in the `pings` table: they belong to `play.crabbymc.fun`, lie before `1789461940315` (the first live ping) and their timestamps are whole minutes. Unique player counts were not imported; they are a separate metric in CrabbyDashboard. The 11 minutes of a bot join flood on 2026-08-27 16:01 to 16:11 UTC were removed afterwards and are a gap, see "Correction" below.

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

- **Maximum per minute** keeps real peaks, which matters for the 24h peak and the all-time record. A single sample per minute understated volatile minutes badly.
- **The lowest recent report per server** prevents counting players twice. Server heartbeats are not synchronised: when a server restarts or players move between servers, one server may already report the players while another still reports them. Summing the latest reports produced false spikes (e.g. 68 instead of 47 when the economy server restarted on 2026-09-06 12:00).
- **7 seconds** is a little over two heartbeat intervals, so a server that stops reporting is treated as offline almost immediately.

Validation:

- Against **Xiri Track's own live pings** in the overlap period 2026-09-15 08:46 to 09:30 UTC: the rule matched Xiri Track's per-minute maximum exactly in 37 of 45 minutes and within 1 player in 44 of 45 (tendency to read 1 low when players join).
- Against **CrabbyDashboard session concurrency** (distinct players online) during the 2026-08-27 15:59 to 16:12 UTC surge: within 0 to 3 players. Both sources counted the same connections, which turned out to be a bot join flood (see "Rejected minutes" below), so this only confirms the aggregation, not that the players were real.
- Remaining known deviation: 56 against 50 session players for one minute during the 2026-09-06 12:02 event start.

## Rejected minutes: transient surges

`import` and `prune` reject minutes that belong to a transient surge. A minute is part of one when

1. its count is at least **twice**, and at least **30 players above**, the median of the preceding 60 minutes (at least 30 minutes of history are required; minutes already rejected are left out), and
2. the count is back at or below **1.5 times** that median within **30 minutes**.

Elevated minutes directly before the jump (above 1.25 times the median) belong to the same surge. Rejected minutes are not imported and do not count for the record. They stay a gap; nothing is estimated in their place. Real growth, events and launches build up or stay up and are not rejected: across all 50,286 exported minutes the rule rejects only the 11 minutes below. The thresholds are constants at the top of `scripts/import-crabby-history.js`.

### 2026-08-27 16:01 to 16:11 UTC: bot join flood

| UTC | 15:59 | 16:00 | 16:01 | 16:02 | 16:03 | 16:04 | 16:05 | 16:06 | 16:07 | 16:08 | 16:09 | 16:10 | 16:11 | 16:12 | 16:13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Exported players | 30 | 28 | **54** | **82** | **80** | **123** | **107** | **137** | **137** | **136** | **137** | **137** | **138** | 26 | 27 |

These minutes produced the imported record of 138 and were removed on 2026-09-15 (see "Correction" below). They are not an aggregation or import error: the values match CrabbyDashboard's raw heartbeats and its session data. The connections were not real players:

- **Heartbeats**: no duplicate or malformed rows, normal reporting cadence, and `online_players` is a concurrent count per server. Before 16:01 the lobby reported 0 to 3 players and economy 25 to 34. From 16:01 the lobby alone climbed to 112 (at 16:05 from 14 to 70 within 27 seconds) and dropped to 0 at 16:11; economy rose to a flat 49 from 16:07 to 16:10.
- **`player_sessions`** joined 15:55 to 16:12: 486 sessions from 132 identities, 410 of them shorter than 2 minutes. Joins rose to 41 to 90 per minute, with 113 (16:04) and 131 (16:11) disconnects within one minute. The busiest minute from 13:30 to 15:50 had 32 disconnects.
- **Names** look random (`jbf3su3eoc5`, `ppaz77fgdf`, `7qdv6b`, `n2aib`, `caajs0g3mc5r`), and only 9 of the 125 flood identities (7%) ever appeared again, against 89 of 164 (54%) of the players of the same afternoon.
- Session flags (no UUID, non-premium, country `XX`) are the same for normal players of that period, a limitation of the older session telemetry, so they were not used as evidence.

Some real players were online during the flood as well, but their number cannot be separated reliably, so the 11 minutes are rejected entirely instead of being replaced with an estimate.

The highest accepted minute is **76 players at 2026-08-27 13:47 UTC**: the economy server reported 74 to 76 players after a rise from 59 at 13:44, the count stayed at 70 to 73 afterwards, and there was no lobby spike or join flood.

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

3. Stop Minetrack, take a verified backup, apply, start Minetrack. Minetrack keeps the player record in memory, so it must not run during the import, otherwise it could overwrite the imported record. The script waits 15 seconds and refuses to apply if a new ping is written in that time.

   ```bash
   docker compose stop minetrack
   cp -p data/database.sql data/backups/database-pre-crabby-import-$(date -u +%Y%m%dT%H%M%SZ).sql
   docker compose run --rm --no-deps -T -v /opt/xiri-track/scripts:/app/scripts:ro \
     minetrack node scripts/import-crabby-history.js import --in /data/import/crabbymc-history.csv --apply < /dev/null
   docker compose up -d
   ```

4. To remove minutes of an earlier import that the current validation rejects, use `prune`. Without `--apply` it lists every stored row it would remove with the reason, and the record it would recompute:

   ```bash
   docker compose run --rm --no-deps -T -v /opt/xiri-track/scripts:/app/scripts:ro \
     minetrack node scripts/import-crabby-history.js prune --in /data/import/crabbymc-history.csv < /dev/null
   ```

   To apply, stop Minetrack, take a backup and run it with `--apply`, as in step 3. It deletes only `play.crabbymc.fun` rows before the start of live tracking whose timestamp and value match a rejected minute of the export, in a single transaction, then sets CrabbyMC's record to its highest remaining valid ping (the earliest one on a tie) and runs the same checks as `import`.

The import validates every row (whole-minute timestamps, integer counts between 0 and 250,000, no duplicates, all before the cutoff), skips minutes rejected as transient surges, refuses existing non-imported rows inside the import range, inserts in a single transaction, and skips rows that already exist, so running it again inserts nothing. Afterwards it checks `PRAGMA integrity_check`, that there are no duplicate CrabbyMC timestamps and that the other servers' rows are unchanged. CrabbyMC's `players_record` is set to the higher of the highest accepted minute and the existing record; AshSMP's record is not touched.

To undo the import, stop Minetrack and copy the `database-pre-crabby-import-*.sql` backup back to `data/database.sql` (see "Restore" in the README).

## Caveats

- Imported history has one value per minute; live history has a ping every 10 seconds. The history graph shows both the same way: the median of each 5 minute bucket. For imported history that is the median of up to five minute maxima, for live history the median of up to 30 pings.
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
| CrabbyMC record | before 22 (2026-09-15 10:00:50 UTC), after 138 (2026-08-27 16:11 UTC); corrected to **76** (2026-08-27 13:47 UTC), see "Correction" below |
| AshSMP | rows and record unchanged (fingerprint compared before and after) |
| Highest daily imported peaks | 2026-08-27: 138 (76 after the correction), 2026-09-06: 61, 2026-09-13: 56, 2026-08-30: 50 |
| Checks | `integrity_check` ok before and after, no duplicate timestamps, 42 minutes compared against values computed directly in CrabbyDashboard's database: all identical |
| Backup before the import | `/opt/xiri-track/data/backups/database-pre-crabby-import-20260915T101219Z.sql` |
| Tracker downtime | 2026-09-15 10:12:19 to 10:12:40 UTC |
| Export file | `/opt/xiri-track/data/import/crabbymc-history.csv` |

A first attempt at 10:03 UTC stopped before writing anything, because the running-tracker check misread a tracker that had been stopped seconds earlier (fixed in the script). Its backup, `database-pre-crabby-import-20260915T100316Z.sql`, is from before any import as well.

## Correction (2026-09-15): bot join flood removed

The minutes described in "Rejected minutes" were removed from the database with `prune --apply`, after a dry-run on the stopped database listed exactly the 11 rows below and nothing else. Nothing was interpolated or estimated in their place.

| | |
|---|---|
| Rows removed | 11 `play.crabbymc.fun` rows, 2026-08-27 UTC: 16:01 = 54, 16:02 = 82, 16:03 = 80, 16:04 = 123, 16:05 = 107, 16:06 = 137, 16:07 = 137, 16:08 = 136, 16:09 = 137, 16:10 = 137, 16:11 = 138 |
| Reason | Transient surge caused by a bot join flood: at least twice and 30 players above the preceding hour's median of 37 (16:01: elevated minute directly before the jump), back to 26 at 16:12 |
| Rows changed or added | None. 16:01 to 16:11 is now a gap; 16:00 (28) and 16:12 (26) remain |
| CrabbyMC rows | 51,459 before, 51,448 after; every other CrabbyMC row identical (SHA-256 over all rows outside the 11 minutes) |
| CrabbyMC record | Before **138** (2026-08-27 16:11 UTC), after **76** (2026-08-27 13:47 UTC), recomputed as the highest remaining valid ping |
| AshSMP | 1,173 rows and record 74 (2026-09-15 10:09:07 UTC) unchanged; SHA-256 over every row identical before and after |
| Checks | `integrity_check` ok before and after, no duplicate CrabbyMC timestamps |
| Backups | `data/backups/database-pre-surge-prune-20260915T120117Z.sql` (copy of the stopped database, SHA-256 equal to the original, integrity ok) and `data/backups/database-20260915T120117Z.sql.gz` (online backup taken just before stopping) |
| Tracker downtime | 2026-09-15 12:01:17 to 12:01:37 UTC (clean shutdown on SIGTERM) |

To undo the correction, stop Minetrack and restore `database-pre-surge-prune-20260915T120117Z.sql` (see "Restore" in the README); pings recorded after 12:01:37 UTC would be lost.
