/* eslint-env mocha */
'use strict'

const { expect } = require('chai')
const nock = require('nock')

const KubeConfig = require('../../lib/config')
const Fetch = require('./client')

const url = 'http://mock.kube.api'
const kubeconfig = new KubeConfig()
kubeconfig.loadFromClusterAndUser(
  { name: 'cluster', server: url },
  { name: 'user' })

describe('lib.backends.fetch', () => {
  describe('Fetch', () => {
    it('handles empty responses', done => {
      nock(url)
        .get('/foo')
        .reply(200)

      const backend = new Fetch({ kubeconfig })
      backend.http({
        method: 'GET',
        pathname: '/foo'
      }).then(res => {
        expect(res.body).to.be.an('undefined')
        done()
      })
    })
  })
})
