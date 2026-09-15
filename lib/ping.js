const minecraftJavaPing = require('mcping-js')
const minecraftBedrockPing = require('mcpe-ping-fixed')

const logger = require('./logger')
const MessageOf = require('./message')
const { TimeTracker } = require('./time')

const { getPlayerCountOrNull } = require('./util')

const config = require('../config')

function ping (serverRegistration, timeout, callback, version) {
  switch (serverRegistration.data.type) {
    case 'PC':
      serverRegistration.dnsResolver.resolve((host, port, remainingTimeout) => {
        const server = new minecraftJavaPing.MinecraftServer(host, port || 25565)

        server.ping(remainingTimeout, version, (err, res) => {
          if (err) {
            callback(err)
          } else {
            const playerCount = parsePlayerCount(serverRegistration.data.ip, res.players && res.players.online)

            if (playerCount === null) {
              callback(new Error('Invalid player count'))
              return
            }

            const payload = {
              players: {
                online: playerCount
              },
              version: parseInt(res.version && res.version.protocol)
            }

            // Ensure the returned favicon is a data URI
            if (typeof res.favicon === 'string' && res.favicon.startsWith('data:image/')) {
              payload.favicon = res.favicon
            }

            callback(null, payload)
          }
        })
      })
      break

    case 'PE':
      minecraftBedrockPing(serverRegistration.data.ip, serverRegistration.data.port || 19132, (err, res) => {
        if (err) {
          callback(err)
        } else {
          const playerCount = parsePlayerCount(serverRegistration.data.ip, res.currentPlayers)

          if (playerCount === null) {
            callback(new Error('Invalid player count'))
            return
          }

          callback(null, {
            players: {
              online: playerCount
            }
          })
        }
      }, timeout)
      break

    default:
      throw new Error('Unsupported type: ' + serverRegistration.data.type)
  }
}

// Returns null when the server did not report a numeric player count
// Without this check NaN would be capped to maxPlayerCount and permanently replace the player count record
function parsePlayerCount (host, value) {
  const playerCount = parseInt(value)

  if (!Number.isFinite(playerCount)) {
    logger.log('warn', '%s returned a non-numeric player count, treating the ping as failed.', host)

    return null
  }

  return capPlayerCount(host, playerCount)
}

// player count can be up to 1^32-1, which is a massive scale and destroys browser performance when rendering graphs
// Artificially cap and warn to prevent propogating garbage
function capPlayerCount (host, playerCount) {
  const maxPlayerCount = 250000

  if (playerCount !== Math.min(playerCount, maxPlayerCount)) {
    logger.log('warn', '%s returned a player count of %d, Minetrack has capped it to %d to prevent browser performance issues with graph rendering. If this is in error, please edit maxPlayerCount in ping.js!', host, playerCount, maxPlayerCount)

    return maxPlayerCount
  } else if (playerCount !== Math.max(playerCount, 0)) {
    logger.log('warn', '%s returned an invalid player count of %d, setting to 0.', host, playerCount)

    return 0
  }
  return playerCount
}

class PingController {
  constructor (app) {
    this._app = app
    this._isRunningTasks = false
    this._isStopped = false
  }

  schedule () {
    this._pingInterval = setInterval(this.pingAll, config.rates.pingAll)

    this.pingAll()
  }

  stop () {
    // Stop scheduling rounds and discard the results of a round that is still in flight
    this._isStopped = true

    clearInterval(this._pingInterval)
  }

  isHealthy () {
    // Healthy while ping rounds keep completing, regardless of whether the pinged servers are online
    // A stalled ping loop would silently stop recording history, so it is reported as unhealthy
    const maxRoundAge = Math.max(config.rates.pingAll * 5, 60 * 1000)

    return this._lastRoundCompletedAt !== undefined && TimeTracker.getEpochMillis() - this._lastRoundCompletedAt <= maxRoundAge
  }

  pingAll = () => {
    const timestamp = TimeTracker.getEpochMillis()

    this.startPingTasks(results => {
      if (this._isStopped) {
        return
      }

      this._lastRoundCompletedAt = TimeTracker.getEpochMillis()

      // Registered once the round has results, so a skipped round never leaves a timestamp without data
      // Returns the history graph buckets this round completed (normally none, or one every 5 minutes)
      const graphBuckets = this._app.timeTracker.addPingRound(timestamp)

      const updates = []

      for (const serverRegistration of this._app.serverRegistrations) {
        const result = results[serverRegistration.serverId]

        // Log to database if enabled
        // Use null to represent a failed ping
        if (config.logToDatabase) {
          const unsafePlayerCount = getPlayerCountOrNull(result.resp)

          this._app.database.insertPing(serverRegistration.data.ip, timestamp, unsafePlayerCount)
        }

        // Generate a combined update payload
        // This includes any modified fields and flags used by the frontend
        // This will not be cached and can contain live metadata
        const update = serverRegistration.handlePing(timestamp, result.resp, result.err, result.version, graphBuckets)

        updates[serverRegistration.serverId] = update
      }

      // Send object since updates uses serverIds as keys
      // Send a single timestamp entry since it is shared
      this._app.server.broadcast(MessageOf('updateServers', {
        timestamp: TimeTracker.toSeconds(timestamp),
        graphTimestamps: graphBuckets.map(TimeTracker.toSeconds),
        updates
      }))
    })
  }

  startPingTasks = (callback) => {
    if (this._isRunningTasks) {
      logger.log('warn', 'Started re-pinging servers before the last loop has finished! You may need to increase "rates.pingAll" in config.json')

      return
    }

    this._isRunningTasks = true

    const results = []

    for (const serverRegistration of this._app.serverRegistrations) {
      const version = serverRegistration.getNextProtocolVersion()

      ping(serverRegistration, config.rates.connectTimeout, (err, resp) => {
        // mcping-js catches exceptions thrown while handling a result and invokes the callback again with that error
        // Only accept the first result per server per round so a round is never stored or broadcast twice
        if (results[serverRegistration.serverId]) {
          logger.log('warn', 'Ignoring duplicate ping result for %s: %s', serverRegistration.data.ip, err ? err.message : 'success')

          return
        }

        if (err && config.logFailedPings !== false) {
          logger.log('error', 'Failed to ping %s: %s', serverRegistration.data.ip, err.message)
        }

        results[serverRegistration.serverId] = {
          resp,
          err,
          version
        }

        if (Object.keys(results).length === this._app.serverRegistrations.length) {
          // Loop has completed, release the locking flag
          this._isRunningTasks = false

          callback(results)
        }
      }, version.protocolId)
    }
  }
}

module.exports = PingController
