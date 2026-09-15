#!/usr/bin/env node
// One-time backfill of historical CrabbyMC concurrent player counts into Xiri Track.
//
// Source: CrabbyDashboard's Supabase table public.server_heartbeats. Every CrabbyMC backend server
// (lobby, economy, lifesteal, events, dev) reports its own online player count about every 3 seconds.
// Only concurrent player counts are used; unique player metrics are never read or imported.
//
// Two steps, see docs/IMPORT-CRABBY-HISTORY.md:
//
//   export  Fetch heartbeats older than the start of live tracking and aggregate them into one
//           concurrent player count per UTC minute. Writes a reviewable CSV, does not touch the database.
//   import  Validate that CSV and insert it into the pings table for play.crabbymc.fun.
//           Dry-run unless --apply is given. Safe to run twice: existing timestamps are skipped.
//
// Aggregation rule (per UTC minute):
//   At each 10 second instant of the minute (:00, :10, ..., :50) sum, over all servers, the lowest
//   online_players value each server reported in the preceding 7 seconds. A server without a report in
//   that window counts as offline. The minute's value is the highest of those sums. Minutes in which no
//   instant has a recent report are omitted, so outages stay gaps; nothing is interpolated.
//   Taking each server's lowest recent value avoids counting a player twice while they move between
//   servers or while a restarting server's last report is still recent.
//
// Usage (inside the Xiri Track container, see the doc for the exact docker compose commands):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-crabby-history.js export --out /data/import/crabbymc-history.csv
//   node scripts/import-crabby-history.js import --in /data/import/crabbymc-history.csv            (dry-run)
//   node scripts/import-crabby-history.js import --in /data/import/crabbymc-history.csv --apply    (writes)

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

  const peak = minutes.reduce((best, m) => (best === undefined || m[1] > best[1] ? m : best), undefined)
  console.log(`source: ${source}`)
  console.log(`heartbeats used: ${aggregator.stats.heartbeats}, rejected: ${aggregator.stats.rejectedHeartbeats}`)
  console.log(`instants with reports: ${aggregator.stats.validInstants}, without: ${aggregator.stats.emptyInstants}`)
  console.log(`minutes written: ${minutes.length}${minutes.length ? `, ${iso(minutes[0][0])} to ${iso(minutes[minutes.length - 1][0])}` : ''}`)
  if (peak) console.log(`highest minute: ${peak[1]} players at ${iso(peak[0])}`)
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

async function importHistory (options) {
  if (!options.in) fail('import requires --in <file.csv>')

  const servers = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'servers.json'), 'utf8'))
  if (!servers.some((server) => server.ip === SERVER_KEY)) fail(`${SERVER_KEY} is not configured in servers.json`)
  const otherIps = servers.map((server) => server.ip).filter((ip) => ip !== SERVER_KEY)

  const { rows, beforeMs } = await readExport(options.in)
  if (rows.length === 0) fail('Export contains no rows')

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

    const toInsert = rows.filter(([timestamp]) => !existingByTimestamp.has(timestamp))
    const conflicts = rows.filter(([timestamp, count]) => existingByTimestamp.has(timestamp) && existingByTimestamp.get(timestamp) !== count)
    const peak = rows.reduce((best, row) => (row[1] > best[1] ? row : best), rows[0])
    const recordAfterCount = Math.max(peak[1], recordBefore && recordBefore.playerCount !== null ? recordBefore.playerCount : -1)
    const recordChanges = !recordBefore || recordBefore.playerCount === null || peak[1] > recordBefore.playerCount

    console.log(`mode: ${options.apply ? 'APPLY' : 'dry-run (no changes)'}`)
    console.log(`database: ${DATABASE_FILE}, integrity_check: ${integrityBefore}`)
    console.log(`export rows: ${rows.length}, ${iso(rows[0][0])} to ${iso(rows[rows.length - 1][0])}, live tracking starts ${iso(beforeMs)}`)
    console.log(`${options.apply ? 'inserting' : 'would insert'}: ${toInsert.length}, skipped (already present): ${existingByTimestamp.size}${conflicts.length ? `, of which ${conflicts.length} differ from the export and are left unchanged` : ''}`)
    console.log(`${SERVER_KEY} before: ${before.rows} rows, earliest ${before.earliest === null ? '-' : iso(before.earliest)}, latest ${before.latest === null ? '-' : iso(before.latest)}`)
    console.log(`record before: ${recordBefore ? `${recordBefore.playerCount} at ${recordBefore.timestamp ? iso(recordBefore.timestamp) : '-'}` : 'none'}; highest imported minute: ${peak[1]} at ${iso(peak[0])}; record ${options.apply ? 'after' : 'would be'}: ${recordAfterCount}`)

    if (!options.apply) return

    // Minetrack writes pings every rates.pingAll milliseconds while it runs. It must be stopped: it keeps the
    // record in memory and would overwrite the imported record. A stopped tracker writes nothing new while we wait.
    const latestPing = async () => (await dbGet(db, 'SELECT MAX(timestamp) AS latest FROM pings')).latest
    const latestBeforeWait = await latestPing()
    console.log(`checking for ${TRACKER_CHECK_MS / 1000}s that Minetrack is not writing pings...`)
    await new Promise((resolve) => setTimeout(resolve, TRACKER_CHECK_MS))
    if (await latestPing() !== latestBeforeWait) {
      fail('New pings were written while waiting, Minetrack is still running. Stop the container first (it keeps the record in memory and would overwrite it).')
    }

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

    const after = await serverSnapshot(db, SERVER_KEY)
    const recordAfter = await dbGet(db, 'SELECT playerCount, timestamp FROM players_record WHERE ip = ?', [SERVER_KEY])
    const othersAfter = await Promise.all(otherIps.map((ip) => serverSnapshot(db, ip)))
    const duplicates = await dbGet(db, 'SELECT COUNT(*) AS n FROM (SELECT timestamp FROM pings WHERE ip = ? GROUP BY timestamp HAVING COUNT(*) > 1)', [SERVER_KEY])
    const integrityAfter = await integrityCheck(db)

    console.log(`${SERVER_KEY} after: ${after.rows} rows (+${after.rows - before.rows}), earliest ${iso(after.earliest)}, latest ${iso(after.latest)}`)
    console.log(`record after: ${recordAfter.playerCount} at ${iso(recordAfter.timestamp)}`)
    console.log(`duplicate ${SERVER_KEY} timestamps: ${duplicates.n}`)
    otherIps.forEach((ip, i) => console.log(`${ip} unchanged: ${JSON.stringify(othersBefore[i]) === JSON.stringify(othersAfter[i])}`))
    console.log(`integrity_check after: ${integrityAfter}`)
    if (integrityAfter !== 'ok' || duplicates.n !== 0) fail('post-import verification failed, restore the backup')
  } finally {
    await dbClose(db)
  }
}

// --- Main -----------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2))
const commands = { export: exportHistory, import: importHistory }
if (!commands[options.command]) fail('Usage: import-crabby-history.js export --out <file.csv> [--before <ms>] | import --in <file.csv> [--apply]')

commands[options.command](options).catch((err) => fail(err.stack || err.message))
