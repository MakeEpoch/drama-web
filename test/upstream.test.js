import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { validateURL, publicAddress, download } from '../server/network.js'
import { createUpstream } from '../server/upstream.js'
import { temporary } from './helpers.js'

test('URL and DNS constraints reject private networks, unsupported protocols, userinfo and suffix spoofing', () => {
  for (const value of ['file:///etc/passwd', 'https://localhost/x', 'https://fqnovelpic.com.evil.test/x', 'http://127.0.0.1', 'https://user:pass@v.qznovelvod.com/x', 'https://v.qznovelvod.com:8080/x', 'not a url']) {
    assert.throws(() => validateURL(value))
  }
  assert.equal(validateURL('https://v.qznovelvod.com/file?signature=secret').hostname, 'v.qznovelvod.com')
  assert.equal(validateURL('https://p3.fqnovelpic.com/img', 'cover').hostname, 'p3.fqnovelpic.com')
  for (const ip of ['127.0.0.1', '10.1.1.1', '172.16.0.3', '192.168.2.2', '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.1.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fd00::1', '2001:db8::1']) assert.equal(publicAddress(ip), false, ip)
  assert.equal(publicAddress('8.8.8.8'), true)
  assert.equal(publicAddress('2606:4700:4700::1111'), true)
})

function fakeRequests(t, handler) {
  const mock = (_url, options, callback) => {
    const req = new EventEmitter()
    let response
    options.signal.addEventListener('abort', () => {
      if (response) response.destroy(new Error('aborted'))
      else req.emit('error', new Error('aborted'))
    }, { once: true })
    queueMicrotask(() => {
      if (options.signal.aborted) return req.emit('error', new Error('aborted'))
      response = new PassThrough()
      response.statusCode = 200
      response.headers = {}
      handler(new URL(_url), response)
      callback(response)
    })
    return req
  }
  t.mock.method(http, 'get', mock)
  t.mock.method(https, 'get', mock)
}

test('source download enforces byte cap, complete-file writes, and redirect allowlist at every hop', async t => {
  const dir = await temporary(t)
  let requests = 0
  fakeRequests(t, (url, response) => {
    requests++
    if (url.pathname === '/redirect') {
      response.statusCode = 302
      response.headers.location = 'http://127.0.0.1/private'
      response.end()
    } else if (url.pathname === '/large') response.end(Buffer.alloc(100))
    else response.end('safe movie')
  })
  await assert.rejects(download('https://v.qznovelvod.com/redirect'), error => error.code === 'SOURCE_URL')
  assert.equal(requests, 1, 'untrusted redirect target is never requested')
  await assert.rejects(download('https://v.qznovelvod.com/large', { maxBytes: 10 }), error => error.code === 'SOURCE_TOO_LARGE')
  const path = join(dir, 'source.mp4')
  const result = await download('https://v.qznovelvod.com/ok', { path })
  assert.equal(result.size, 10)
  assert.equal(await readFile(path, 'utf8'), 'safe movie')
  assert.equal(result.body, undefined)
})

test('source timeout, empty/HTTP errors and redirect loops are bounded and clean partial downloads', async t => {
  const dir = await temporary(t)
  let requests = 0
  fakeRequests(t, (url, response) => {
    requests++
    if (url.pathname === '/timeout') return
    if (url.pathname === '/loop') { response.statusCode = 302; response.headers.location = '/loop' }
    else if (url.pathname === '/http') response.statusCode = 403
    else if (url.pathname === '/length') response.headers['content-length'] = '100000'
    response.end()
  })
  const path = join(dir, 'partial.mp4')
  await assert.rejects(download('https://v.qznovelvod.com/timeout', { path, timeoutMs: 25 }), error => error.code === 'SOURCE_TIMEOUT')
  await assert.rejects(stat(path), { code: 'ENOENT' })
  await assert.rejects(download('https://v.qznovelvod.com/empty'), error => error.code === 'SOURCE_EMPTY')
  await assert.rejects(download('https://v.qznovelvod.com/http'), error => error.code === 'SOURCE_HTTP')
  await assert.rejects(download('https://v.qznovelvod.com/length', { maxBytes: 10 }), error => error.code === 'SOURCE_TOO_LARGE')
  const before = requests
  await assert.rejects(download('https://v.qznovelvod.com/loop'), error => error.code === 'SOURCE_REDIRECT')
  assert.equal(requests - before, 4)
})

test('SDK data mapping returns no signed CDN URL, real cursor shape and complete ordered episodes', async t => {
  const dataDir = await temporary(t)
  const raw = { id: 's1', title: '测试', cover_url: 'https://p3.fqnovelpic.com/image?secret=signature', episode_count: 2, digg_count: 12 }
  const calls = []
  const sdk = {
    async discover() { return { items: [raw, raw] } },
    async search(q, options) { calls.push([q, options]); return { items: [raw], cursor: 'next', has_more: true } },
    async getSeries() { return raw },
    async listEpisodes() { return { items: [{ id: 'e2', number: 2 }, { id: 'e1', number: 1 }], has_more: false } },
  }
  const api = createUpstream({ dataDir, base: '/drama', sdkFactory: async () => sdk })
  const feed = await api.feed()
  assert.equal(feed.items.length, 1)
  assert.equal(feed.items[0].heat, 12)
  assert.match(feed.items[0].cover, /^\/drama\/api\/cover\?u=[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(feed), /secret|signature|https:/)
  const page = await api.search('测试', 'cursor')
  assert.equal(page.cursor, 'next')
  assert.equal(page.hasMore, true)
  assert.deepEqual(calls, [['测试', { cursor: 'cursor' }]])
  const detail = await api.series('s1')
  assert.deepEqual(detail.episodes.map(e => e.id), ['e1', 'e2'])
  assert.equal(detail.series.episodes, 2)
  await assert.rejects(api.series('../file'), error => error.status === 400)
  await assert.rejects(api.search(''), error => error.status === 400)
})

test('episode paging preserves real order and refuses incomplete/repeating cursors instead of fake finality', async t => {
  const dataDir = await temporary(t)
  const seen = []
  const sdk = {
    async getSeries() { return { id: 'show', episode_count: 3 } },
    async listEpisodes(_, options) {
      seen.push(options)
      return options.cursor
        ? { items: [{ id: 'e3', number: 3 }], has_more: false }
        : { items: [{ id: 'e2', number: 2 }, { id: 'e1', number: 1 }], cursor: 'next', has_more: true }
    },
  }
  const api = createUpstream({ dataDir, sdkFactory: async () => sdk })
  assert.deepEqual((await api.series('show')).episodes.map(e => e.id), ['e1', 'e2', 'e3'])
  assert.equal(seen[1].cursor, 'next')
  sdk.listEpisodes = async () => ({ items: [{ id: 'e1', number: 1 }], cursor: 'same', has_more: true })
  await assert.rejects(api.series('another'), error => error.code === 'EPISODE_LIST_INCOMPLETE')
  sdk.listEpisodes = async () => ({ items: [{ id: 'e1', number: 1 }], has_more: false })
  await assert.rejects(api.series('third'), error => error.code === 'EPISODE_LIST_INCOMPLETE')
})

test('anonymous reset retry is bounded and file-source/key failures are explicit', async t => {
  const dataDir = await temporary(t)
  let resets = 0
  let calls = 0
  const sdk = {
    async resetDevice() { resets++ },
    async resolvePlayback() { calls++; throw Object.assign(new Error('sensitive request URL'), { code: 'ANONYMOUS_LIMITED' }) },
  }
  const api = createUpstream({ dataDir, sdkFactory: async () => sdk })
  await assert.rejects(api.source('e1', join(dataDir, 'x')))
  assert.equal(calls, 2)
  assert.equal(resets, 1)
  sdk.resolvePlayback = async () => ({ playback: { streams: [{ hls: true, url: 'https://v.qznovelvod.com/a.m3u8' }] } })
  await assert.rejects(api.source('e1', join(dataDir, 'x')), error => error.code === 'SOURCE_UNSUPPORTED')
  sdk.resolvePlayback = async () => ({ playback: { protected: true, streams: [{ url: 'https://v.qznovelvod.com/file.mp4' }] } })
  await assert.rejects(api.source('e1', join(dataDir, 'x')), error => error.code === 'CONTENT_KEY_UNAVAILABLE')
})
