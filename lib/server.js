const http = require('http')
const format = require('util').format

const WebSocket = require('ws')
const finalHttpHandler = require('finalhandler')
const serveStatic = require('serve-static')

const logger = require('./logger')

const HASHED_FAVICON_URL_REGEX = /hashedfavicon_([a-z0-9]{32}).png/g

function getRemoteAddr (req) {
  return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress
}

class Server {
  static getHashedFaviconUrl (hash) {
    // Format must be compatible with HASHED_FAVICON_URL_REGEX
    return format('/hashedfavicon_%s.png', hash)
  }

  constructor (app) {
    this._app = app

    this.createHttpServer()
    this.createWebSocketServer()
  }

  createHttpServer () {
    const distServeStatic = serveStatic('dist/')
    const faviconsServeStatic = serveStatic('favicons/')

    this._http = http.createServer((req, res) => {
      // Health checks are polled frequently, answer them before request logging
      if (req.url === '/healthz') {
        this.handleHealthRequest(res)
        return
      }

      logger.log('info', '%s requested: %s', getRemoteAddr(req), req.url)

      // Test the URL against a regex for hashed favicon URLs
      // Require only 1 match ([0]) and test its first captured group ([1])
      // Any invalid value or hit miss will pass into static handlers below
      const faviconHash = [...req.url.matchAll(HASHED_FAVICON_URL_REGEX)]

      if (faviconHash.length === 1 && this.handleFaviconRequest(res, faviconHash[0][1])) {
        return
      }

      // Attempt to handle req using distServeStatic, otherwise fail over to faviconServeStatic
      // If faviconServeStatic fails, pass to finalHttpHandler to terminate
      // finalhandler is forced into production mode so error responses never include stack traces
      distServeStatic(req, res, () => {
        faviconsServeStatic(req, res, finalHttpHandler(req, res, { env: 'production' }))
      })
    })
  }

  handleHealthRequest (res) {
    // Only reports whether ping rounds are still completing, no configuration or server details
    const isHealthy = this._app.pingController.isHealthy()

    res.writeHead(isHealthy ? 200 : 503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }).end(JSON.stringify({ status: isHealthy ? 'ok' : 'unavailable' }))
  }

  handleFaviconRequest = (res, faviconHash) => {
    for (const serverRegistration of this._app.serverRegistrations) {
      if (serverRegistration.faviconHash && serverRegistration.faviconHash === faviconHash) {
        const buf = Buffer.from(serverRegistration.lastFavicon.split(',')[1], 'base64')

        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=604800', // Cache hashed favicon for 7 days
          'X-Content-Type-Options': 'nosniff' // Favicon bytes come from the pinged server
        }).end(buf)

        return true
      }
    }

    return false
  }

  createWebSocketServer () {
    this._wss = new WebSocket.Server({
      server: this._http,
      // Clients only ever send the short "requestHistoryGraph" message
      // Without a limit ws would buffer incoming messages of up to 100 MiB
      maxPayload: 1024
    })

    this._wss.on('connection', (client, req) => {
      logger.log('info', '%s connected, total clients: %d', getRemoteAddr(req), this.getConnectedClients())

      // ws emits an error for protocol violations (invalid frames, oversized messages) before closing the connection
      // Without a listener the error is thrown and a single malformed frame would crash the whole process
      client.on('error', (err) => {
        logger.log('warn', '%s sent an invalid WebSocket message: %s', getRemoteAddr(req), err.message)
      })

      // Bind disconnect event for logging
      client.on('close', () => {
        logger.log('info', '%s disconnected, total clients: %d', getRemoteAddr(req), this.getConnectedClients())
      })

      // Pass client off to proxy handler
      this._app.handleClientConnection(client)
    })
  }

  listen (host, port) {
    this._http.listen(port, host)

    logger.log('info', 'Started on %s:%d', host, port)
  }

  close () {
    // Stop accepting connections and tell connected browsers the server is going away
    // The frontend automatically reconnects once Minetrack is back
    for (const client of this._wss.clients) {
      client.close(1001)
    }

    this._wss.close()
    this._http.close()
  }

  broadcast (payload) {
    this._wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      }
    })
  }

  getConnectedClients () {
    let count = 0
    this._wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        count++
      }
    })
    return count
  }
}

module.exports = Server
