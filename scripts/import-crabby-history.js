#!/usr/bin/env node
// One-time backfill of historical CrabbyMC concurrent player counts into Xiri Track.
//
// Source: CrabbyDashboard's Supabase table public.server_heartbeats. Every CrabbyMC backend server
// (lobby, economy, lifesteal, events, dev) reports its own online player count about every 3 seconds.
// Only concurrent player counts are used; unique player metrics are never read or imported.
//
// Commands, see docs/IMPORT-CRABBY-HISTORY.md:
//
//   export  Fetch heartbeats older than the start of live tracking and aggregate them into one
//           concurrent player count per UTC minute. Writes a reviewable CSV, does not touch the database.
//   import  Validate that CSV and insert it into the pings table for play.crabbymc.fun.
//           Dry-run unless --apply is given. Safe to run twice: existing timestamps are skipped.
//   prune   Remove previously imported minutes that the validation now rejects and recompute the record.
//           Dry-run unless --apply is given.
//
// Aggregation rule (per UTC minute):
//   At each 10 second instant of the minute (:00, :10, ..., :50) sum, over all servers, the lowest
//   online_players value each server reported in the preceding 7 seconds. A server without a report in
//   that window counts as offline. The minute's value is the highest of those sums. Minutes in which no
//   instant has a recent report are omitted, so outages stay gaps; nothing is interpolated.
//   Taking each server's lowest recent value avoids counting a player twice while they move between
//   servers or while a restarting server's last report is still recent.
//
// Validation, besides format checks: minutes that belong to a transient surge are rejected (see detectSurges).
//
// Usage (inside the Xiri Track container, see the doc for the exact docker compose commands):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-crabby-history.js export --out /data/import/crabbymc-history.csv
//   node scripts/import-crabby-history.js import --in /data/import/crabbymc-history.csv [--apply]
//   node scripts/import-crabby-history.js prune --in /data/import/crabbymc-history.csv [--apply]

'use strict'

const fs = require('fs')
const path = require('path')
const readline = require('readline')

const SERVER_KEY = 'play.crabbymc.fun'
const SOURCE_SERVERS = ['lobby', 'economy', 'lifesteal', 'events', 'dev']
const INSTANT_MS = 10 * 1000
const FRESH_MS = 7 * 1000
const MINUTE_MS = 60 * 1000
const MAX_PLAYER_COUNT = 250000 // same cap as lib/ping.js
const EARLIEST_ALLOWED_MS = Date.UTC(2026, 0, 1)
const PAGE_SIZE = 1000

// Wait longer than one ping interval when checking that Minetrack is stopped
const TRACKER_CHECK_MS = Math.max(15 * 1000, Math.round(require(path.join(__dirname, '..', 'config.json')).rates.pingAll * 1.5))

// Transient surge detection, see detectSurges
const SURGE_BASELINE_MINUTES = 60
const SURGE_MIN_BASELINE_MINUTES = 30
const SURGE_FACTOR = 2
const SURGE_MIN_INCREASE = 30
const SURGE_RETURN_FACTOR = 1.5
const SURGE_ELEVATED_FACTOR = 1.25
const SURGE_MAX_MINUTES = 30

const DATABASE_FILE = process.env.MINETRACK_DATABASE_FILE || path.join(__dirname, '..', 'database.sql')

function fail (message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

function parseArgs (argv) {
  const [command, ...rest] = argv
  const options = { command }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--apply') {
      options.apply = true
    } else if (['--out', '--in', '--before', '--heartbeats-csv'].includes(arg)) {
      options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = rest[++i]
    } else {
      fail(`Unknown argument: ${arg}`)
    }
  }
  return options
}

const iso = (ms) => new Date(ms).toISOString()

function median (values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// --- SQLite helpers ---------------------------------------------------------

function openDatabase (readOnly) {
  const sqlite3 = require('sqlite3')
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DATABASE_FILE, readOnly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE, (err) => {
      if (err) reject(err)
      else resolve(db)
    })
  })
}

const dbAll = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)))
const dbGet = (db, sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)))
const dbRun = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) { return err ? reject(err) : resolve(this) }))
const dbClose = (db) => new Promise((resolve, reject) => db.close((err) => err ? reject(err) : resolve()))

async function integrityCheck (db) {
  const row = await dbGet(db, 'PRAGMA integrity_check')
  return Object.values(row)[0]
}

async function verifySchema (db) {
  const columns = async (table) => (await dbAll(db, `PRAGMA table_info(${table})`)).map((c) => c.name).join(',')
  const pings = await columns('pings')
  const records = await columns('players_record')
  if (pings !== 'timestamp,ip,playerCount') fail(`Unexpected pings schema: ${pings}`)
  if (records !== 'timestamp,ip,playerCount') fail(`Unexpected players_record schema: ${records}`)
}

async function serverSnapshot (db, ip) {
  return dbGet(db, 'SELECT COUNT(*) AS rows, MIN(timestamp) AS earliest, MAX(timestamp) AS latest, TOTAL(timestamp) AS timestampSum, TOTAL(playerCount) AS countSum, SUM(playerCount IS NULL) AS failed FROM pings WHERE ip = ?', [ip])
}

function otherServerIps () {
  const servers = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'servers.json'), 'utf8'))
  if (!servers.some((server) => server.ip === SERVER_KEY)) fail(`${SERVER_KEY} is not configured in servers.json`)
  return servers.map((server) => server.ip).filter((ip) => ip !== SERVER_KEY)
}

// Minetrack writes pings every rates.pingAll milliseconds while it runs. It must be stopped: it keeps the
// record in memory and would overwrite a changed record. A stopped tracker writes nothing new while we wait.
async function ensureTrackerStopped (db) {
  const latestPing = async () => (await dbGet(db, 'SELECT MAX(timestamp) AS latest FROM pings')).latest
  const latestBeforeWait = await latestPing()
  console.log(`checking for ${TRACKER_CHECK_MS / 1000}s that Minetrack is not writing pings...`)
  await new Promise((resolve) => setTimeout(resolve, TRACKER_CHECK_MS))
  if (await latestPing() !== latestBeforeWait) {
    fail('New pings were written while waiting, Minetrack is still running. Stop the container first (it keeps the record in memory and would overwrite it).')
  }
}

// --- Validation ------------------------------------------------------------------

// Flags minutes that belong to a transient surge: the count jumps to at least twice, and at least 30 players above,
// the median of the preceding hour, and falls back to at most 1.5 times that median within 30 minutes. Minutes
// directly before the jump that are already above 1.25 times the median belong to the same surge.
//
// This is what the bot join flood on 2026-08-27 16:01-16:11 UTC looked like (28 -> 138 -> 26 players within
// 12 minutes, 41-90 joins per minute of random-looking names that were almost never seen again, 131 disconnects
// in one minute). Real growth, events and launches build up gradually or stay up and are not flagged. Minutes without a
// full half hour of history before them are never flagged. Returns a Map of timestamp -> reason.
function detectSurges (rows) {
  const flagged = new Map()
  let windowStart = 0

  for (let i = 0; i < rows.length; i++) {
    const [timestamp, count] = rows[i]
    if (flagged.has(timestamp)) continue

    while (rows[windowStart][0] < timestamp - SURGE_BASELINE_MINUTES * MINUTE_MS) windowStart++
    const history = []
    for (let k = windowStart; k < i; k++) {
      if (!flagged.has(rows[k][0])) history.push(rows[k][1])
    }
    if (history.length < SURGE_MIN_BASELINE_MINUTES) continue

    const baseline = median(history)
    if (count < Math.max(baseline * SURGE_FACTOR, baseline + SURGE_MIN_INCREASE)) continue

    // The surge has to end within SURGE_MAX_MINUTES, otherwise the higher level is real
    let end = i
    while (end < rows.length && rows[end][0] - timestamp < SURGE_MAX_MINUTES * MINUTE_MS && rows[end][1] > baseline * SURGE_RETURN_FACTOR) end++
    const returned = end < rows.length && rows[end][1] <= baseline * SURGE_RETURN_FACTOR && rows[end][0] - timestamp <= (SURGE_MAX_MINUTES + 1) * MINUTE_MS
    if (!returned) continue

    let start = i
    while (start > 0 && rows[start - 1][0] === rows[start][0] - MINUTE_MS && rows[start - 1][1] > baseline * SURGE_ELEVATED_FACTOR && !flagged.has(rows[start - 1][0])) start--

    const peak = Math.max(...rows.slice(start, end).map((row) => row[1]))
    const reason = `transient surge ${iso(rows[start][0]).slice(0, 16)}Z-${iso(rows[end - 1][0]).slice(11, 16)}Z: up to ${peak} players against a median of ${baseline} in the preceding hour, back to ${rows[end][1]} at ${iso(rows[end][0]).slice(11, 16)}Z`
    for (let k = start; k < end; k++) flagged.set(rows[k][0], reason)
    i = end - 1
  }

  return flagged
}

// --- Aggregation --------------------------------------------------------------

// Consumes heartbeats in ascending reported_at order and produces minute values.
class MinuteAggregator {
  constructor (beforeMs) {
    // Only minutes that end at or before the start of live tracking are produced
    this.lastMinuteStart = Math.floor(beforeMs / MINUTE_MS) * MINUTE_MS - MINUTE_MS
    this.recent = new Map(SOURCE_SERVERS.map((server) => [server, []]))
    this.nextInstant = undefined
    this.minuteStart = undefined
    this.minuteMax = undefined
    this.minutes = []
    this.stats = { heartbeats: 0, rejectedHeartbeats: 0, validInstants: 0, emptyInstants: 0 }
  }

  add (serverId, onlinePlayers, reportedAtMs) {
    if (!this.recent.has(serverId) || !Number.isInteger(onlinePlayers) || onlinePlayers < 0 || onlinePlayers > MAX_PLAYER_COUNT || !Number.isFinite(reportedAtMs)) {
      this.stats.rejectedHeartbeats++
      return
    }
    this.stats.heartbeats++

    if (this.nextInstant === undefined) {
      this.nextInstant = Math.ceil(reportedAtMs / INSTANT_MS) * INSTANT_MS
    }

    // Evaluate every instant before this heartbeat, all earlier heartbeats have been seen
    this.advanceTo(reportedAtMs)
    this.recent.get(serverId).push({ at: reportedAtMs, value: onlinePlayers })
  }

  advanceTo (untilMs) {
    while (this.nextInstant < untilMs && this.nextInstant < this.lastMinuteStart + MINUTE_MS) {
      const anyRecent = [...this.recent.values()].some((list) => list.length > 0 && list[list.length - 1].at > this.nextInstant - FRESH_MS)
      if (!anyRecent) {
        // Nothing reported recently: skip ahead to the last instant before the next heartbeat
        const skipTo = Math.ceil((untilMs - FRESH_MS) / INSTANT_MS) * INSTANT_MS
        if (skipTo > this.nextInstant) {
          this.stats.emptyInstants += (skipTo - this.nextInstant) / INSTANT_MS
          this.nextInstant = skipTo
          continue
        }
      }
      this.evaluateInstant(this.nextInstant)
      this.nextInstant += INSTANT_MS
    }
  }

  evaluateInstant (instant) {
    let sum = 0
    let freshServers = 0
    for (const list of this.recent.values()) {
      while (list.length > 0 && list[0].at <= instant - FRESH_MS) list.shift()
      if (list.length > 0) {
        freshServers++
        sum += Math.min(...list.map((entry) => entry.value))
      }
    }

    const minuteStart = Math.floor(instant / MINUTE_MS) * MINUTE_MS
    if (minuteStart !== this.minuteStart) {
      this.flushMinute()
      this.minuteStart = minuteStart
    }

    if (freshServers === 0) {
      this.stats.emptyInstants++
      return
    }

    this.stats.validInstants++
    this.minuteMax = this.minuteMax === undefined ? sum : Math.max(this.minuteMax, sum)
  }

  flushMinute () {
    if (this.minuteStart !== undefined && this.minuteMax !== undefined) {
      this.minutes.push([this.minuteStart, this.minuteMax])
    }
    this.minuteMax = undefined
  }

  finish () {
    this.advanceTo(this.lastMinuteStart + MINUTE_MS)
    this.flushMinute()
    return this.minutes
  }
}

// --- Export -------------------------------------------------------------------

async function fetchPage (baseUrl, key, beforeIso, cursor) {
  const params = new URLSearchParams()
  params.set('select', 'id,server_id,online_players,reported_at')
  params.set('server_id', `in.(${SOURCE_SERVERS.join(',')})`)
  params.append('reported_at', `lt.${beforeIso}`)
  if (cursor) params.append('reported_at', `gte.${cursor}`)
  params.set('order', 'reported_at.asc,id.asc')
  params.set('limit', String(PAGE_SIZE))
  const url = `${baseUrl.replace(/\/+$/, '')}/rest/v1/server_heartbeats?${params}`

  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
      return await response.json()
    } catch (err) {
      if (attempt >= 6) throw err
      console.error(`  request failed (${err.message}), retry ${attempt}/5`)
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
    }
  }
}

async function exportHistory (options) {
  if (!options.out) fail('export requires --out <file.csv>')

  let beforeMs = options.before !== undefined ? Number(options.before) : undefined
  if (beforeMs === undefined) {
    const db = await openDatabase(true)
    const row = await dbGet(db, 'SELECT MIN(timestamp) AS earliest FROM pings WHERE ip = ?', [SERVER_KEY])
    await dbClose(db)
    if (!row || row.earliest === null) fail(`No live ${SERVER_KEY} pings found, pass --before <epoch ms>`)
    beforeMs = row.earliest
  }
  if (!Number.isInteger(beforeMs) || beforeMs < EARLIEST_ALLOWED_MS) fail(`Invalid --before value: ${options.before}`)

  const aggregator = new MinuteAggregator(beforeMs)
  let source

  if (options.heartbeatsCsv) {
    // Offline mode for testing: server_id,online_players,reported_at_ms in ascending time order
    source = `file ${options.heartbeatsCsv}`
    const lines = readline.createInterface({ input: fs.createReadStream(options.heartbeatsCsv) })
    for await (const line of lines) {
      if (!line.trim() || line.startsWith('server_id')) continue
      const [serverId, online, reportedAt] = line.split(',')
      aggregator.add(serverId, Number(online), Number(reportedAt))
    }
  } else {
    const baseUrl = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!baseUrl || !key) fail('export requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment')
    source = `CrabbyDashboard Supabase public.server_heartbeats (${new URL(baseUrl).host})`

    const beforeIso = iso(beforeMs)
    let cursor
    let seenAtCursor = new Set()
    let pages = 0
    let lastSeenMs = 0
    for (;;) {
      const rows = await fetchPage(baseUrl, key, beforeIso, cursor)
      pages++
      let added = 0
      for (const row of rows) {
        // gte cursor repeats rows sharing the cursor timestamp, skip the ones already processed
        if (row.reported_at === cursor && seenAtCursor.has(row.id)) continue
        const reportedAtMs = Date.parse(row.reported_at)
        if (!(reportedAtMs >= lastSeenMs)) fail(`Heartbeats are not in ascending order at ${row.reported_at}`)
        lastSeenMs = reportedAtMs
        aggregator.add(row.server_id, row.online_players, reportedAtMs)
        added++
        if (row.reported_at !== cursor) {
          cursor = row.reported_at
          seenAtCursor = new Set()
        }
        seenAtCursor.add(row.id)
      }
      if (pages % 100 === 0) console.log(`  ${pages} pages, ${aggregator.stats.heartbeats} heartbeats, at ${cursor}`)
      if (rows.length < PAGE_SIZE || added === 0) break
    }
  }

  const minutes = aggregator.finish()
  const header = [
    '# Xiri Track history export: CrabbyMC concurrent players per UTC minute',
    `# source: ${source}`,
    `# servers: ${SOURCE_SERVERS.join(',')}`,
    '# rule: max over the :00,:10,...,:50 instants of the sum of each server\'s lowest online_players reported in the preceding 7s; minutes where no instant has a recent report are omitted',
    `# server_key: ${SERVER_KEY}`,
    `# before_ms: ${beforeMs} (${iso(beforeMs)}, start of live tracking)`,
    `# generated_at: ${new Date().toISOString()}`,
    'timestamp_ms,player_count'
  ]
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true })
  const temp = `${options.out}.tmp`
  fs.writeFileSync(temp, header.join('\n') + '\n' + minutes.map(([t, c]) => `${t},${c}`).join('\n') + (minutes.length ? '\n' : ''))
  fs.renameSync(temp, options.out)

  const surges = detectSurges(minutes)
  const peak = minutes.filter(([t]) => !surges.has(t)).reduce((best, m) => (best === undefined || m[1] > best[1] ? m : best), undefined)
  console.log(`source: ${source}`)
  console.log(`heartbeats used: ${aggregator.stats.heartbeats}, rejected: ${aggregator.stats.rejectedHeartbeats}`)
  console.log(`instants with reports: ${aggregator.stats.validInstants}, without: ${aggregator.stats.emptyInstants}`)
  console.log(`minutes written: ${minutes.length}${minutes.length ? `, ${iso(minutes[0][0])} to ${iso(minutes[minutes.length - 1][0])}` : ''}`)
  console.log(`minutes the import will reject as transient surges: ${surges.size}`)
  if (peak) console.log(`highest accepted minute: ${peak[1]} players at ${iso(peak[0])}`)
  console.log(`written to ${options.out}`)
}

// --- Import -------------------------------------------------------------------

async function readExport (file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  let beforeMs
  let headerSeen = false
  const rows = []
  const seen = new Set()

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    if (line === '') return
    if (line.startsWith('#')) {
      const match = line.match(/^# before_ms: (\d+)/)
      if (match) beforeMs = Number(match[1])
      const key = line.match(/^# server_key: (.+)$/)
      if (key && key[1].trim() !== SERVER_KEY) fail(`Export is for ${key[1]}, expected ${SERVER_KEY}`)
      return
    }
    if (!headerSeen) {
      if (line.trim() !== 'timestamp_ms,player_count') fail(`Line ${lineNumber}: expected header timestamp_ms,player_count`)
      headerSeen = true
      return
    }
    if (!/^\d+,\d+$/.test(line.trim())) fail(`Line ${lineNumber}: malformed row "${line}"`)
    const [timestamp, playerCount] = line.trim().split(',').map(Number)
    if (!Number.isSafeInteger(timestamp) || timestamp % MINUTE_MS !== 0 || timestamp < EARLIEST_ALLOWED_MS) fail(`Line ${lineNumber}: invalid timestamp ${timestamp}`)
    if (!Number.isSafeInteger(playerCount) || playerCount < 0 || playerCount > MAX_PLAYER_COUNT) fail(`Line ${lineNumber}: invalid player count ${playerCount}`)
    if (seen.has(timestamp)) fail(`Line ${lineNumber}: duplicate timestamp ${timestamp}`)
    seen.add(timestamp)
    rows.push([timestamp, playerCount])
  })

  if (!Number.isSafeInteger(beforeMs)) fail('Export has no "# before_ms:" header')
  if (!headerSeen) fail('Export has no column header')
  for (const [timestamp] of rows) {
    if (timestamp + MINUTE_MS > beforeMs) fail(`Row ${timestamp} (${iso(timestamp)}) is not strictly before live tracking started at ${iso(beforeMs)}`)
  }
  rows.sort((a, b) => a[0] - b[0])
  return { rows, beforeMs }
}

function printSurges (surges, rows) {
  const counts = new Map(rows)
  const reasons = new Map()
  for (const [timestamp, reason] of surges) {
    if (!reasons.has(reason)) reasons.set(reason, [])
    reasons.get(reason).push(timestamp)
  }
  for (const [reason, timestamps] of reasons) {
    console.log(`  ${reason}`)
    console.log(`    minutes: ${timestamps.map((t) => `${iso(t).slice(11, 16)}=${counts.get(t)}`).join(' ')}`)
  }
}

async function importHistory (options) {
  if (!options.in) fail('import requires --in <file.csv>')

  const otherIps = otherServerIps()
  const { rows, beforeMs } = await readExport(options.in)
  if (rows.length === 0) fail('Export contains no rows')

  const surges = detectSurges(rows)
  const accepted = rows.filter(([timestamp]) => !surges.has(timestamp))
  if (accepted.length === 0) fail('Export contains no valid rows')

  const db = await openDatabase(!options.apply)
  try {
    const integrityBefore = await integrityCheck(db)
    if (integrityBefore !== 'ok') fail(`integrity_check failed before import: ${integrityBefore}`)
    await verifySchema(db)

    const before = await serverSnapshot(db, SERVER_KEY)
    const recordBefore = await dbGet(db, 'SELECT playerCount, timestamp FROM players_record WHERE ip = ?', [SERVER_KEY])
    const othersBefore = await Promise.all(otherIps.map((ip) => serverSnapshot(db, ip)))

    // Existing rows inside the import range must be exact duplicates of this export (a previous run)
    const firstMs = rows[0][0]
    const existing = await dbAll(db, 'SELECT timestamp, playerCount FROM pings WHERE ip = ? AND timestamp >= ? AND timestamp < ?', [SERVER_KEY, firstMs, beforeMs])
    const exported = new Map(rows)
    const existingByTimestamp = new Map()
    for (const row of existing) {
      if (!exported.has(row.timestamp)) {
        fail(`Existing ${SERVER_KEY} ping at ${row.timestamp} (${iso(row.timestamp)}) lies inside the import range but is not part of this export; refusing to mix data`)
      }
      existingByTimestamp.set(row.timestamp, row.playerCount)
    }

    const toInsert = accepted.filter(([timestamp]) => !existingByTimestamp.has(timestamp))
    const conflicts = accepted.filter(([timestamp, count]) => existingByTimestamp.has(timestamp) && existingByTimestamp.get(timestamp) !== count)
    const storedSurges = [...surges.keys()].filter((timestamp) => existingByTimestamp.has(timestamp))
    const peak = accepted.reduce((best, row) => (row[1] > best[1] ? row : best), accepted[0])
    const recordAfterCount = Math.max(peak[1], recordBefore && recordBefore.playerCount !== null ? recordBefore.playerCount : -1)
    const recordChanges = !recordBefore || recordBefore.playerCount === null || peak[1] > recordBefore.playerCount

    console.log(`mode: ${options.apply ? 'APPLY' : 'dry-run (no changes)'}`)
    console.log(`database: ${DATABASE_FILE}, integrity_check: ${integrityBefore}`)
    console.log(`export rows: ${rows.length}, ${iso(rows[0][0])} to ${iso(rows[rows.length - 1][0])}, live tracking starts ${iso(beforeMs)}`)
    console.log(`rejected as transient surge: ${surges.size}`)
    printSurges(surges, rows)
    if (storedSurges.length > 0) console.log(`  ${storedSurges.length} of them are already in the database from an earlier import, remove them with the prune command`)
    console.log(`${options.apply ? 'inserting' : 'would insert'}: ${toInsert.length}, skipped (already present): ${accepted.length - toInsert.length}${conflicts.length ? `, of which ${conflicts.length} differ from the export and are left unchanged` : ''}`)
    console.log(`${SERVER_KEY} before: ${before.rows} rows, earliest ${before.earliest === null ? '-' : iso(before.earliest)}, latest ${before.latest === null ? '-' : iso(before.latest)}`)
    console.log(`record before: ${recordBefore ? `${recordBefore.playerCount} at ${recordBefore.timestamp ? iso(recordBefore.timestamp) : '-'}` : 'none'}; highest accepted minute: ${peak[1]} at ${iso(peak[0])}; record ${options.apply ? 'after' : 'would be'}: ${recordAfterCount}`)

    if (!options.apply) return

    await ensureTrackerStopped(db)

    await dbRun(db, 'BEGIN IMMEDIATE')
    try {
      const statement = db.prepare('INSERT INTO pings (timestamp, ip, playerCount) VALUES (?, ?, ?)')
      for (const [timestamp, playerCount] of toInsert) {
        await new Promise((resolve, reject) => statement.run(timestamp, SERVER_KEY, playerCount, (err) => err ? reject(err) : resolve()))
      }
      await new Promise((resolve, reject) => statement.finalize((err) => err ? reject(err) : resolve()))

      if (recordChanges) {
        if (recordBefore) {
          await dbRun(db, 'UPDATE players_record SET playerCount = ?, timestamp = ? WHERE ip = ?', [peak[1], peak[0], SERVER_KEY])
        } else {
          await dbRun(db, 'INSERT INTO players_record (timestamp, ip, playerCount) VALUES (?, ?, ?)', [peak[0], SERVER_KEY, peak[1]])
        }
      }
      await dbRun(db, 'COMMIT')
    } catch (err) {
      await dbRun(db, 'ROLLBACK').catch(() => {})
      throw err
    }

    await verifyAfterChange(db, before, otherIps, othersBefore)
  } finally {
    await dbClose(db)
  }
}

async function verifyAfterChange (db, before, otherIps, othersBefore) {
  const after = await serverSnapshot(db, SERVER_KEY)
  const recordAfter = await dbGet(db, 'SELECT playerCount, timestamp FROM players_record WHERE ip = ?', [SERVER_KEY])
  const othersAfter = await Promise.all(otherIps.map((ip) => serverSnapshot(db, ip)))
  const duplicates = await dbGet(db, 'SELECT COUNT(*) AS n FROM (SELECT timestamp FROM pings WHERE ip = ? GROUP BY timestamp HAVING COUNT(*) > 1)', [SERVER_KEY])
  const integrityAfter = await integrityCheck(db)

  console.log(`${SERVER_KEY} after: ${after.rows} rows (${after.rows - before.rows >= 0 ? '+' : ''}${after.rows - before.rows}), earliest ${iso(after.earliest)}, latest ${iso(after.latest)}`)
  console.log(`record after: ${recordAfter.playerCount} at ${iso(recordAfter.timestamp)}`)
  console.log(`duplicate ${SERVER_KEY} timestamps: ${duplicates.n}`)
  otherIps.forEach((ip, i) => console.log(`${ip} unchanged: ${JSON.stringify(othersBefore[i]) === JSON.stringify(othersAfter[i])}`))
  console.log(`integrity_check after: ${integrityAfter}`)
  if (integrityAfter !== 'ok' || duplicates.n !== 0) fail('post-change verification failed, restore the backup')
}

// --- Prune ----------------------------------------------------------------------

async function pruneHistory (options) {
  if (!options.in) fail('prune requires --in <file.csv>')

  const otherIps = otherServerIps()
  const { rows, beforeMs } = await readExport(options.in)
  const surges = detectSurges(rows)
  const exported = new Map(rows)

  const db = await openDatabase(!options.apply)
  try {
    const integrityBefore = await integrityCheck(db)
    if (integrityBefore !== 'ok') fail(`integrity_check failed before prune: ${integrityBefore}`)
    await verifySchema(db)

    const before = await serverSnapshot(db, SERVER_KEY)
    const recordBefore = await dbGet(db, 'SELECT playerCount, timestamp FROM players_record WHERE ip = ?', [SERVER_KEY])
    const othersBefore = await Promise.all(otherIps.map((ip) => serverSnapshot(db, ip)))

    // Only rows that were imported from this export: before live tracking, same timestamp and same value
    const stored = await dbAll(db, 'SELECT timestamp, playerCount FROM pings WHERE ip = ? AND timestamp < ?', [SERVER_KEY, beforeMs])
    const toRemove = stored.filter((row) => surges.has(row.timestamp) && exported.get(row.timestamp) === row.playerCount).sort((a, b) => a.timestamp - b.timestamp)
    const removeSet = new Set(toRemove.map((row) => row.timestamp))

    // The record is the highest remaining valid ping of this server, earliest one on a tie
    const candidates = await dbAll(db, 'SELECT timestamp, playerCount FROM pings WHERE ip = ? AND playerCount IS NOT NULL ORDER BY playerCount DESC, timestamp ASC LIMIT ?', [SERVER_KEY, removeSet.size + 1])
    const recordAfter = candidates.find((row) => !removeSet.has(row.timestamp))

    console.log(`mode: ${options.apply ? 'APPLY' : 'dry-run (no changes)'}`)
    console.log(`database: ${DATABASE_FILE}, integrity_check: ${integrityBefore}`)
    console.log(`minutes rejected by validation: ${surges.size}`)
    printSurges(surges, rows)
    console.log(`${options.apply ? 'removing' : 'would remove'} ${toRemove.length} stored ${SERVER_KEY} rows:`)
    for (const row of toRemove) console.log(`  ${iso(row.timestamp)} ${row.playerCount} players: ${surges.get(row.timestamp)}`)
    console.log(`record before: ${recordBefore ? `${recordBefore.playerCount} at ${iso(recordBefore.timestamp)}` : 'none'}; record ${options.apply ? 'after' : 'would be'}: ${recordAfter ? `${recordAfter.playerCount} at ${iso(recordAfter.timestamp)}` : 'none'}`)

    if (!options.apply || (toRemove.length === 0 && recordBefore && recordAfter && recordBefore.playerCount === recordAfter.playerCount && recordBefore.timestamp === recordAfter.timestamp)) {
      if (options.apply) console.log('nothing to change')
      return
    }

    await ensureTrackerStopped(db)

    await dbRun(db, 'BEGIN IMMEDIATE')
    try {
      for (const row of toRemove) {
        const result = await dbRun(db, 'DELETE FROM pings WHERE ip = ? AND timestamp = ? AND playerCount = ?', [SERVER_KEY, row.timestamp, row.playerCount])
        if (result.changes !== 1) throw new Error(`Expected to delete exactly one row at ${row.timestamp}, deleted ${result.changes}`)
      }
      if (recordAfter) {
        if (recordBefore) {
          await dbRun(db, 'UPDATE players_record SET playerCount = ?, timestamp = ? WHERE ip = ?', [recordAfter.playerCount, recordAfter.timestamp, SERVER_KEY])
        } else {
          await dbRun(db, 'INSERT INTO players_record (timestamp, ip, playerCount) VALUES (?, ?, ?)', [recordAfter.timestamp, SERVER_KEY, recordAfter.playerCount])
        }
      }
      await dbRun(db, 'COMMIT')
    } catch (err) {
      await dbRun(db, 'ROLLBACK').catch(() => {})
      throw err
    }

    await verifyAfterChange(db, before, otherIps, othersBefore)
  } finally {
    await dbClose(db)
  }
}

// --- Main -----------------------------------------------------------------------

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2))
  const commands = { export: exportHistory, import: importHistory, prune: pruneHistory }
  if (!commands[options.command]) fail('Usage: import-crabby-history.js export --out <file.csv> [--before <ms>] | import --in <file.csv> [--apply] | prune --in <file.csv> [--apply]')

  commands[options.command](options).catch((err) => fail(err.stack || err.message))
}

module.exports = { detectSurges }
