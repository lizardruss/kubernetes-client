'use strict'

const { convertKubeconfig } = require('../config')
const deprecate = require('depd')('kubernetes-client')
const JSONStream = require('json-stream')
const pump = require('pump')
const qs = require('qs')
const WebSocket = require('ws')
const fetch = require('cross-fetch')
const https = require('https')
const AbortController = require('abort-controller')

const execChannels = ['stdin', 'stdout', 'stderr', 'error', 'resize']

class Fetch {
  /**
   * Internal representation of HTTP request object.
   *
   * @param {object} options - Options object
   * @param {string} options.url - Kubernetes API URL
   * @param {object} options.auth - request library auth object
   * @param {string} options.ca - Certificate authority
   * @param {string} options.cert - Client certificate
   * @param {string} options.key - Client key
   * @param {boolean} options.insecureSkipTlsVerify - Skip the validity check
   *   on the server's certificate.
   */
  constructor (options) {
    this.fetchOptions = options.request || {}

    let convertedOptions
    if (!options.kubeconfig) {
      deprecate(
        'Request() without a .kubeconfig option, see ' +
          'https://github.com/godaddy/kubernetes-client/blob/master/merging-with-kubernetes.md'
      )
      convertedOptions = options
    } else {
      convertedOptions = convertKubeconfig(options.kubeconfig)
    }

    this.fetchOptions.qsStringifyOptions = { indices: false }
    this.fetchOptions.baseUrl = convertedOptions.url
    this.fetchOptions.ca = convertedOptions.ca
    this.fetchOptions.cert = convertedOptions.cert
    this.fetchOptions.key = convertedOptions.key
    if ('insecureSkipTlsVerify' in convertedOptions) {
      this.fetchOptions.strictSSL = !convertedOptions.insecureSkipTlsVerify
    }
    if ('timeout' in convertedOptions) {
      this.fetchOptions.timeout = convertedOptions.timeout
    }

    this.authProvider = {
      type: null
    }
    if (convertedOptions.auth) {
      this.fetchOptions.auth = convertedOptions.auth
      if (convertedOptions.auth.provider) {
        this.fetchOptions.auth = convertedOptions.auth.request
        this.authProvider = convertedOptions.auth.provider
      }
    }
  }

  _fetch (uri, options) {
    const auth = this.authProvider
    return fetch(uri, options)
      .then((response) => {
        // Refresh auth if 401 or 403
        if (
          (response.status === 401 || response.status === 403) &&
          auth.type
        ) {
          return refreshAuth(auth.type, auth.config)
            .then((newAuth) => {
              this.fetchOptions.auth = newAuth
              return fetch(uri, options)
            })
        }

        return response
      })
  }

  async getLogByteStream (options) {
    return this.http(Object.assign({ stream: true }, options))
  }

  async getWatchObjectStream (options) {
    return this.http(Object.assign({ stream: true }, options)).then(
      (stream) => {
        const jsonStream = new JSONStream()
        pump(stream, jsonStream)
        return jsonStream
      }
    )
  }

  /**
   * @param {object} options - Options object
   * @param {Stream} options.stdin - optional stdin Readable stream
   * @param {Stream} options.stdout - optional stdout Writeable stream
   * @param {Stream} options.stderr - optional stdout Writeable stream
   * @returns {Promise} Promise resolving to a Kubernetes V1 Status object and a WebSocket
   */
  async getWebSocket (options) {
    throw new Error('Request.getWebSocket not implemented')
  }

  /**
   * @typedef {object} ApiRequestOptions
   * @property {string} method - Request method
   * @property {object} body - Request body
   * @property {object} headers - Headers object
   * @property {string} path - version-less path
   * @property {boolean} stream - stream
   * @property {object} qs - {@link https://www.npmjs.com/package/request#requestoptions-callback|
   *                          request query parameter}
   */

  /**
   * Invoke a REST request against the Kubernetes API server
   * @param {ApiRequestOptions} options - Options object
   * @returns {Stream} If options.stream is truthy, return a stream
   */
  http (options) {
    const combinedOptions = Object.assign(options, this.fetchOptions)
    const url = toFetchUrl(combinedOptions)
    const controller = new AbortController()
    const fetchOptions = {
      ...toFetchOptions(combinedOptions),
      signal: controller.signal
    }
    const produces = toProduces(combinedOptions)

    return this._fetch(url, fetchOptions)
      .then((response) => {
        if (isUpgradeRequired(response)) {
          return upgradeRequest(url, fetchOptions)
        }

        if (options.stream) {
          const stream = response.body
          stream.on('close', () => {
            controller.abort()
          })
          return stream
        }

        if (!response.ok) {
          const { status } = response
          return response.text().then((body) => {
            const error = new Error(body)
            // .code is backwards compatible with pre-5.0.0 code.
            error.code = status
            error.statusCode = status
            throw error
          })
        }

        if (produces.includes('text/plain')) {
          return response
            .text()
            .then(toResponse(response))
        }

        return response
          .json()
          .then(toResponse(response))
          .catch((error) => {
            if (response.size === 0) {
              return toResponse(response)
            } else {
              throw error
            }
          })
      })
  }
}

function toFetchUrl (options) {
  const { baseUrl } = options
  const { pathname } = options
  const { qs } = options
  const { parameters = qs } = options

  const pathParts = [pathname]
  if (parameters) {
    pathParts.push(qs.stringify(parameters))
  }
  return [baseUrl, pathParts.join('?')].join('')
}

function toFetchOptions (options) {
  const authHeaders = (options.auth)
    ? { authorization: `Bearer ${options.auth.bearer}` }
    : {}

  const isJson = 'json' in options ? Boolean(options.json) : true
  const headers = isJson
    ? Object.assign(
      options.headers || {},
      {
        'content-type': 'application/json'
      },
      authHeaders
    )
    : Object.assign(
      options.headers || {},
      authHeaders
    )

  let uri = [options.pathname]
  const parameters = options.parameters || options.qs
  if (parameters) {
    uri.push(qs.stringify(parameters, options.qsStringifyOptions))
  }
  uri = uri.join('?')

  const { strictSSL } = options

  const agent = options.noAuth
    ? {}
    : {
      agent: new https.Agent({
        ca: options.ca,
        cert: options.cert,
        key: options.key,
        rejectUnauthorized: strictSSL
      })
    }

  const fetchOptions = {
    ...agent,
    method: options.method,
    body: JSON.stringify(options.body),
    headers
  }

  return fetchOptions
}

function toProduces (options) {
  const { pathItemObject = {} } = options
  const { method } = options
  const pathItemKey = method.toLowerCase()
  const { produces = ['application/json'] } = pathItemKey in pathItemObject
    ? pathItemObject[pathItemKey]
    : {}
  return produces
}

function toResponse (response) {
  return (body) => {
    return {
      statusCode: response.status,
      statusMessage: response.statusText,
      headers: response.headers,
      body
    }
  }
}

/**
 * Determine whether a failed Kubernetes API response is asking for an upgrade
 * @param {object} response - response object from Kubernetes
 * @property {string} ok - request status
 * @property {number} status - previous request's response code
 * @property {message} statusText - previous request response message
 * @returns {boolean} Upgrade the request
 */
function isUpgradeRequired (body) {
  return (
    !body.ok &&
    body.status === 400 &&
    body.statusText === 'Upgrade request required'
  )
}

/**
 * Upgrade a request into a Websocket transaction & process the result
 * @param {string} uri - The uri of the request
 * @param {ApiRequestOptions} options - Options object
 */
function upgradeRequest (uri, options) {
  return new Promise((resolve, reject) => {
    const messages = []
    const protocol = 'base64.channel.k8s.io'
    const ws = new WebSocket(uri, protocol, options)

    ws.on('message', (msg) => {
      const channel = execChannels[msg.slice(0, 1)]
      const message = Buffer.from(msg.slice(1), 'base64').toString('ascii')
      messages.push({ channel, message })
    })

    ws.on('error', (err) => {
      err.messages = messages
      reject(err)
    })

    ws.on('close', (code, reason) =>
      resolve({
        messages,
        body: messages.map(({ message }) => message).join(''),
        code,
        reason
      })
    )
  })
}

/**
 * Refresh whatever authentication {type} is.
 * @param {String} type - type of authentication
 * @param {Object} config - auth provider config
 * @returns {Promise} with fetch friendly auth object
 */
function refreshAuth (type, config) {
  const provider = require(`../auth-providers/${type}.js`)
  return provider
    .refresh(config)
    .then((result) => ({ bearer: result }))
}

module.exports = Fetch
