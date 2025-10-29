const express = require('express')
const http = require('http')
const bodyParser = require('body-parser')
const cors = require('cors')
const path = require('path')
const cluster = require('cluster')
const __db = require('./lib/db')
const __config = require('./config')
const __constants = require('./config/constants')
const helmet = require('helmet')
const authMiddleware = require('./middlewares/auth/authentication')
const numCPUs = __config.clusterNumber || 0
const fs = require('fs')
const axios = require('axios')

class httpApiWorker {
  constructor() {
    this.app = {}
  }

  async startServer() {
    console.debug('inside ~function=startServer. STARTING http_api WORKER')
    const vm = this
    await __db
      .init()
      .then((result) => {
        vm.runExpressServer()
      })
      .catch((error) => {
        console.log('Error while server start :: ', error)
        process.exit(1)
      })
  }

  runExpressServer() {
    console.debug('info inside ~function=runExpressServer.')
    const vm = this
    vm.app = express()
    vm.app.use(
      helmet({
        noCache: true
      })
    )

    const sixtyDaysInSeconds = 5184000
    vm.app.use(
      helmet.hsts({
        maxAge: sixtyDaysInSeconds
      })
    )
    vm.app.use(
      helmet.frameguard({
        action: 'deny'
      })
    )
    vm.app.set('views', path.join(process.env.PWD, 'views'))
    vm.app.set('view engine', 'hbs')
    vm.app.use((req, res, next) => {
      if (!req.timedout) {
        next()
      } else {
        res.sendJson({
          type: __constants.RESPONSE_MESSAGES.SERVER_TIMEOUT,
          data: {
            message: 'request from client timedout'
          }
        })
      }
      req.on('timeout', (time, next) => {
        console.log(
          'error :: inside ~function=runExpressServer. haltOnTimedout, server response timedout'
        )
        res.sendJson({
          type: __constants.RESPONSE_MESSAGES.SERVER_TIMEOUT,
          data: {
            message: 'server timed out after ' + time + ' milliseconds'
          }
        })
      })
    })
    vm.app.use(
      bodyParser.json({
        limit: '100mb'
      })
    ) // to support JSON-encoded bodies
    vm.app.use(
      bodyParser.urlencoded({
        // to support URL-encoded bodies
        extended: true,
        limit: '100mb'
      })
    )
    vm.app.use((err, req, res, next) => {
      // This check makes sure this is a JSON parsing issue, but it might be
      // coming from any middleware, not just body-parser:
      if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.log('Error while sending request (JSON invalid)', err)
        return res.sendJson({
          type: __constants.RESPONSE_MESSAGES.INVALID_REQUEST,
          err: ['invalid request']
        })
      }
      next()
    })
    vm.app.use(
      cors({
        exposedHeaders: ['Content-disposition']
      })
    )
    authMiddleware.initialize(vm.app)
    require('./routes')(vm.app)

    vm.app.use((req, res, next) => {
      const err = new Error('Not Found')
      res.sendJson({
        type: __constants.RESPONSE_MESSAGES.NOT_FOUND,
        data: {
          message: 'not found'
        },
        err: err
      })
    })
    if (cluster.isMaster && numCPUs > 0) {
      for (let i = 0; i < numCPUs; i++) {
        cluster.fork()
      }
    } else {
      vm.app.server = http.createServer(vm.app)
      vm.app.server.listen(__config.port)
      vm.app.server.timeout = __constants.SERVER_TIMEOUT
    }
    const apiPrefix =
      __config.addBaseUrlPrefix === true ? '/' + __config.api_prefix : ''
    console.log(
      'Application listening on Port :',
      __config.port,
      '\nApplication Test URL : ',
      __config.base_url + apiPrefix + '/api/healthCheck/getping'
    )

    const stopGraceFully = () => {
      vm.app.server.close(async (error) => {
        console.log('inside ~function=runExpressServerserver is closed', error)
        await __db.close()
        console.debug('server is closed')
        process.exit(error ? 1 : 0)
      })
    }

    process.on('SIGINT', () => {
      console.log('SIGINT received')
      stopGraceFully()
    })
    process.on('SIGTERM', () => {
      console.log('SIGTERM received')
      stopGraceFully()
    })
    process.on('uncaughtException', (err) => {
      console.log(
        'error :: inside ~function=runExpressServer. ##### SERVER CRASH ##### \n',
        err,
        '\n ########## END ##########'
      )
    })

    // to avoid issue of monggose schema register which comes if any schema is used in populate before being required anywhere
    const normalizedPath = path.join(__dirname, 'mongooseSchema')
    fs.readdirSync(normalizedPath).forEach((file) => {
      if (file.endsWith('.js')) require(path.join(normalizedPath, file))
    })
  }

  // Function to simulate an internal health check
  async internalHealthCheck() {
    const response = await axios.get(
      `http://localhost:${__config.port}/api/healthCheck/getPing`
    )
    // Log the response from the internal API
    console.log('Health check response:', response.data)
  }
}

class Worker extends httpApiWorker {
  start() {
    console.debug(
      new Date().toLocaleString() + '   >> Worker PID:',
      process.pid
    )
    // call initialization function of extended worker class
    super.startServer()

    // Polling function that runs every 10 seconds to check the internal health
    const POLL_INTERVAL = 10000 // 10 seconds
    const pollingDuration = 5 * 60 * 1000 // 5 minutes in milliseconds

    // Bind the method to preserve 'this' context or use arrow function
    const interval = setInterval(() => {
      super.internalHealthCheck().catch((err) => {
        console.error('Health check failed:', err)
      })
    }, POLL_INTERVAL)

    // Stop polling after 5 minutes (not 2 minutes as the comment said)
    setTimeout(() => {
      clearInterval(interval)
      console.log('Stopped polling after 5 minutes.')
    }, pollingDuration)
  }
}

module.exports.worker = new Worker()
