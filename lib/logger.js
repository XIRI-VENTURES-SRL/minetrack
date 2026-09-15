const winston = require('winston')

const config = require('../config')

// Defaults to minetrack.log in the working directory
// Set MINETRACK_LOG_FILE (or "logFile" in config.json) to an empty value to only log to the console,
// e.g. in Docker where the container runtime already collects and rotates stdout
const LOG_FILE = process.env.MINETRACK_LOG_FILE ?? config.logFile ?? 'minetrack.log'

winston.remove(winston.transports.Console)

if (LOG_FILE) {
  winston.add(winston.transports.File, {
    filename: LOG_FILE
  })
}

winston.add(winston.transports.Console, {
  timestamp: () => {
    const date = new Date()
    return date.toLocaleTimeString() + ' ' + date.toLocaleDateString()
  },
  colorize: true
})

module.exports = winston
