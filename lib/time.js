const config = require('../config.json')

// The history graph shows one point per bucket: the median of the valid pings in that bucket.
// Buckets are aligned to the clock (e.g. 10:00, 10:05), so they are identical before and after a restart.
// Raw pings are stored and collected at their normal rate; bucketing only affects the history graph.
const GRAPH_BUCKET_DURATION = 5 * 60 * 1000

class TimeTracker {
  constructor (app) {
    this._app = app
    this._serverGraphPoints = []
    this._graphPoints = []
  }

  // Registers a completed ping round and returns the history graph buckets it completed, oldest first.
  // That is normally nothing, or the previous bucket once a round falls into a new bucket. After a pause longer
  // than a bucket, the buckets without any ping follow as well so the graph keeps a regular time axis with gaps.
  addPingRound (timestamp) {
    TimeTracker.pushAndShift(this._serverGraphPoints, timestamp, TimeTracker.getMaxServerGraphDataLength())

    const completedBuckets = []

    if (config.logToDatabase) {
      const bucket = TimeTracker.getBucketStart(timestamp)

      if (this._currentBucket !== undefined && bucket > this._currentBucket) {
        for (let completed = this._currentBucket; completed < bucket; completed += GRAPH_BUCKET_DURATION) {
          completedBuckets.push(completed)
        }

        // A pause of more than the whole graph duration only needs the most recent buckets
        completedBuckets.splice(0, Math.max(0, completedBuckets.length - TimeTracker.getMaxGraphDataLength()))

        for (const completed of completedBuckets) {
          TimeTracker.pushAndShift(this._graphPoints, completed, TimeTracker.getMaxGraphDataLength())
        }
      }

      if (this._currentBucket === undefined || bucket > this._currentBucket) {
        this._currentBucket = bucket
      }
    }

    return completedBuckets
  }

  loadGraphBuckets (buckets, currentBucket) {
    this._graphPoints = buckets
    this._currentBucket = currentBucket
  }

  getServerGraphPoints () {
    return this._serverGraphPoints.map(TimeTracker.toSeconds)
  }

  getGraphPoints () {
    return this._graphPoints.map(TimeTracker.toSeconds)
  }

  static toSeconds = (timestamp) => {
    return Math.floor(timestamp / 1000)
  }

  static getEpochMillis () {
    return new Date().getTime()
  }

  static getBucketDuration () {
    return GRAPH_BUCKET_DURATION
  }

  static getBucketStart (timestamp) {
    return Math.floor(timestamp / GRAPH_BUCKET_DURATION) * GRAPH_BUCKET_DURATION
  }

  static getMaxServerGraphDataLength () {
    return Math.ceil(config.serverGraphDuration / config.rates.pingAll)
  }

  static getMaxGraphDataLength () {
    return Math.ceil(config.graphDuration / GRAPH_BUCKET_DURATION)
  }

  static pushAndShift (array, value, maxLength) {
    array.push(value)

    if (array.length > maxLength) {
      array.splice(0, array.length - maxLength)
    }
  }
}

module.exports = {
  GRAPH_BUCKET_DURATION,
  TimeTracker
}
