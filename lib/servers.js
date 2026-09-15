const crypto = require('crypto')

const DNSResolver = require('./dns')
const Server = require('./server')

const { TimeTracker } = require('./time')
const { getPlayerCountOrNull } = require('./util')

const config = require('../config')
const minecraftVersions = require('../minecraft_versions')

class ServerRegistration {
  serverId
  lastFavicon
  versions = []
  recordData

  // History graph: the median of the valid pings of each completed bucket, null when a bucket has none
  graphData = []

  constructor (app, serverId, data) {
    this._app = app
    this.serverId = serverId
    this.data = data
    this._pingHistory = []
    this.dnsResolver = new DNSResolver(this.data.ip, this.data.port)

    // Highest valid ping of each completed bucket, used for the graph duration peak
    this._graphPeaks = []

    // Valid pings of the bucket that is still open
    this._bucketStart = undefined
    this._bucketCounts = []
    this._bucketPeak = undefined
  }

  handlePing (timestamp, resp, err, version, graphBuckets) {
    // Use null to represent a failed ping
    const unsafePlayerCount = getPlayerCountOrNull(resp)

    // Store into in-memory ping data
    TimeTracker.pushAndShift(this._pingHistory, unsafePlayerCount, TimeTracker.getMaxServerGraphDataLength())

    // Close the history graph buckets this round completed before the ping is added to its own bucket
    const graphValues = graphBuckets.map(bucket => this.completeBucket(bucket))

    if (config.logToDatabase) {
      this.addToBucket(timestamp, unsafePlayerCount)
    }

    // Delegate out update payload generation
    return this.getUpdate(timestamp, resp, err, version, graphValues)
  }

  getUpdate (timestamp, resp, err, version, graphValues) {
    const update = {}

    // Always append a playerCount value
    // When resp is undefined (due to an error), playerCount will be null
    update.playerCount = getPlayerCountOrNull(resp)

    if (graphValues.length > 0) {
      update.graphValues = graphValues
    }

    if (resp) {
      if (resp.version && this.updateProtocolVersionCompat(resp.version, version.protocolId, version.protocolIndex)) {
        // Append an updated version listing
        update.versions = this.versions
      }

      if (config.logToDatabase && (!this.recordData || resp.players.online > this.recordData.playerCount)) {
        this.recordData = {
          playerCount: resp.players.online,
          timestamp: TimeTracker.toSeconds(timestamp)
        }

        // Append an updated recordData
        update.recordData = this.recordData

        // Update record in database
        this._app.database.updatePlayerCountRecord(this.data.ip, resp.players.online, timestamp)
      }

      if (this.updateFavicon(resp.favicon)) {
        update.favicon = this.getFaviconUrl()
      }
    } else if (err) {
      // Append a filtered copy of err
      // This ensures any unintended data is not leaked
      update.error = this.filterError(err)
    }

    // The peak can also change without a successful ping, when an old bucket leaves the graph duration
    if (config.logToDatabase && this.findNewGraphPeak()) {
      update.graphPeakData = this.getGraphPeak()
    }

    return update
  }

  getPingHistory () {
    if (this._pingHistory.length > 0) {
      const payload = {
        versions: this.versions,
        recordData: this.recordData,
        favicon: this.getFaviconUrl()
      }

      // Only append graphPeakData if defined
      // The value is lazy computed and conditional that config->logToDatabase == true
      const graphPeakData = this.getGraphPeak()

      if (graphPeakData) {
        payload.graphPeakData = graphPeakData
      }

      // Assume the ping was a success and define result
      // pingHistory does not keep error references, so its impossible to detect if this is an error
      // It is also pointless to store that data since it will be short lived
      payload.playerCount = this._pingHistory[this._pingHistory.length - 1]

      // Send a copy of pingHistory
      // Include the last value even though it is contained within payload
      // The frontend will only push to its graphData from playerCountHistory
      payload.playerCountHistory = this._pingHistory

      return payload
    }

    return {
      error: {
        message: 'Pinging...'
      },
      recordData: this.recordData,
      graphPeakData: this.getGraphPeak(),
      favicon: this.data.favicon
    }
  }

  addToBucket (timestamp, playerCount) {
    const bucket = TimeTracker.getBucketStart(timestamp)

    if (bucket !== this._bucketStart) {
      this._bucketStart = bucket
      this._bucketCounts = []
      this._bucketPeak = undefined
    }

    // Failed pings (null) are not part of the median or the peak
    if (typeof playerCount === 'number') {
      this._bucketCounts.push(playerCount)

      if (!this._bucketPeak || playerCount > this._bucketPeak.playerCount) {
        this._bucketPeak = { playerCount, timestamp }
      }
    }
  }

  // Appends a completed bucket to the history graph and returns its value
  completeBucket (bucket) {
    let value = null
    let peak = null

    // A bucket without any valid ping stays a gap instead of being interpolated
    if (bucket === this._bucketStart && this._bucketCounts.length > 0) {
      const counts = [...this._bucketCounts].sort((a, b) => a - b)
      const middle = Math.floor(counts.length / 2)

      value = counts.length % 2 === 1 ? counts[middle] : Math.round((counts[middle - 1] + counts[middle]) / 2)
      peak = this._bucketPeak
    }

    TimeTracker.pushAndShift(this.graphData, value, TimeTracker.getMaxGraphDataLength())
    TimeTracker.pushAndShift(this._graphPeaks, peak, TimeTracker.getMaxGraphDataLength())

    return value
  }

  // Rebuilds the history graph from stored pings: one array of pings per completed bucket, plus the pings of the open bucket
  loadGraphBuckets (bucketPings, openBucketPings, openBucket) {
    this.graphData = []
    this._graphPeaks = []

    for (const pings of bucketPings) {
      this._bucketStart = undefined
      this._bucketCounts = []
      this._bucketPeak = undefined

      for (const ping of pings) {
        this.addToBucket(ping.timestamp, ping.playerCount)
      }

      // An empty bucket leaves _bucketStart undefined with no counts, which completes as a gap
      this.completeBucket(this._bucketStart)
    }

    this._bucketStart = openBucket
    this._bucketCounts = []
    this._bucketPeak = undefined
    for (const ping of openBucketPings) {
      this.addToBucket(ping.timestamp, ping.playerCount)
    }
  }

  // The peak is the highest valid ping within the graph duration, not the highest bucket median
  findNewGraphPeak () {
    let peak

    for (const candidate of [...this._graphPeaks, this._bucketPeak]) {
      if (candidate && (!peak || candidate.playerCount > peak.playerCount)) {
        peak = candidate
      }
    }

    const lastPeak = this._graphPeak
    this._graphPeak = peak

    return !!peak && (!lastPeak || peak.playerCount !== lastPeak.playerCount || peak.timestamp !== lastPeak.timestamp)
  }

  getGraphPeak () {
    if (!this._graphPeak) {
      return
    }
    return {
      playerCount: this._graphPeak.playerCount,
      timestamp: TimeTracker.toSeconds(this._graphPeak.timestamp)
    }
  }

  updateFavicon (favicon) {
    // If data.favicon is defined, then a favicon override is present
    // Disregard the incoming favicon, regardless if it is different
    if (this.data.favicon) {
      return false
    }

    if (favicon && favicon !== this.lastFavicon) {
      this.lastFavicon = favicon

      // Generate an updated hash
      // This is used by #getFaviconUrl
      this.faviconHash = crypto.createHash('md5').update(favicon).digest('hex').toString()

      return true
    }

    return false
  }

  getFaviconUrl () {
    if (this.faviconHash) {
      return Server.getHashedFaviconUrl(this.faviconHash)
    } else if (this.data.favicon) {
      return this.data.favicon
    }
  }

  updateProtocolVersionCompat (incomingId, outgoingId, protocolIndex) {
    // If the result version matches the attempted version, the version is supported
    const isSuccess = incomingId === outgoingId
    const indexOf = this.versions.indexOf(protocolIndex)

    // Test indexOf to avoid inserting previously recorded protocolIndex values
    if (isSuccess && indexOf < 0) {
      this.versions.push(protocolIndex)

      // Sort versions in ascending order
      // This matches protocol ids to Minecraft versions release order
      this.versions.sort((a, b) => a - b)

      return true
    } else if (!isSuccess && indexOf >= 0) {
      this.versions.splice(indexOf, 1)
      return true
    }
    return false
  }

  getNextProtocolVersion () {
    // Minecraft Bedrock Edition does not have protocol versions
    if (this.data.type === 'PE') {
      return {
        protocolId: 0,
        protocolIndex: 0
      }
    }
    const protocolVersions = minecraftVersions[this.data.type]
    if (typeof this._nextProtocolIndex === 'undefined' || this._nextProtocolIndex + 1 >= protocolVersions.length) {
      this._nextProtocolIndex = 0
    } else {
      this._nextProtocolIndex++
    }
    return {
      protocolId: protocolVersions[this._nextProtocolIndex].protocolId,
      protocolIndex: this._nextProtocolIndex
    }
  }

  filterError (err) {
    let message = 'Unknown error'

    // Attempt to match to the first possible value
    for (const key of ['message', 'description', 'errno']) {
      if (err[key]) {
        message = err[key]
        break
      }
    }

    // Trim the message if too long
    if (message.length > 28) {
      message = message.substring(0, 28) + '...'
    }

    return {
      message: message
    }
  }

  getPublicData () {
    // Return a custom object instead of data directly to avoid data leakage
    return {
      name: this.data.name,
      ip: this.data.ip,
      type: this.data.type,
      color: this.data.color
    }
  }
}

module.exports = ServerRegistration
