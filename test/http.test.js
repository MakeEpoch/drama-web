import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createApp, normalizeBase } from '../server/app.js'
import { fixtureUpstream, temporary, fakeEncode, until } from './helpers.js'

async function setup(t, upstream = fixtureUpstream(), options = {}) {
  const dataDir = await temporary(t)
  const app = await createApp({ dataDir, base: '/drama', upstream, managerOptions: { encode: fakeEncode, ...options } })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(() => app.close())
  const origin = `http://127.0.0.1:${app.server.address().port}`
  return { ...app, origin, get: path => fetch(origin + path) }
}

test('HTTP API uses exact shape/base URLs, JSON errors, vendor and scoped complete segments', async t => {
  const app = await setup(t)
  for (const prefix of ['', '/drama']) {
    const response = await app.get(`${prefix}/api/health`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ok, true)
  }
  const feed = await (await app.get('/api/feed')).json()
  assert.equal(feed.items[0].id, 'show')
  const detail = await (await app.get('/api/series?id=show')).json()
  assert.equal(detail.series.title, '合成测试')
  assert.equal(detail.episodes.length, 6)
  const response = await fetch(app.origin + '/drama/api/playback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seriesId: 'show', episodeId: 'e1' }) })
  assert.equal(response.status, 202)
  const created = await response.json()
  await app.manager.get(created.id).pending
  await until(() => app.manager.status(created.id).episodes.every(e => e.ready))
  const playlistResponse = await app.get(created.playlistUrl)
  assert.equal(playlistResponse.headers.get('cache-control'), 'no-store')
  const playlist = await playlistResponse.text()
  const segment = playlist.split('\n').find(row => row.startsWith('/'))
  const data = await app.get(segment)
  assert.equal(data.status, 200)
  assert.equal(data.headers.get('content-type'), 'video/mp2t')
  assert.equal(await data.text(), 'synthetic transport stream')
  const partial = await fetch(app.origin + segment, { headers: { range: 'bytes=0-8' } })
  assert.equal(partial.status, 206)
  assert.equal(await partial.text(), 'synthetic')
  const invalidRange = await fetch(app.origin + segment, { headers: { range: 'bytes=999999-' } })
  assert.equal(invalidRange.status, 416)
  const vendor = await app.get('/vendor/hls.min.js')
  assert.equal(vendor.status, 200)
  assert.match(await vendor.text(), /1\.6\.13/)
  const deleted = await fetch(app.origin + created.statusUrl, { method: 'DELETE' })
  assert.deepEqual(await deleted.json(), { ok: true })
  assert.equal((await app.get(created.statusUrl)).status, 404)
})

test('invalid body, cross-origin, unknown route and credential-bearing exception never leak private text', async t => {
  const upstream = fixtureUpstream()
  upstream.feed = async () => { throw new Error('https://secret.cdn/?token=SECRET KEY=PRIVATE') }
  const app = await setup(t, upstream)
  let res = await app.get('/api/feed')
  assert.equal(res.status, 502)
  assert.doesNotMatch(await res.text(), /SECRET|PRIVATE|https:/)
  for (const [body, contentType, expected] of [['{', 'application/json', 400], ['[]', 'application/json', 400], ['{}', 'text/plain', 415], ['x'.repeat(9000), 'application/json', 413]]) {
    res = await fetch(app.origin + '/api/playback', { method: 'POST', headers: { 'content-type': contentType }, body })
    assert.equal(res.status, expected)
    assert.equal((await res.json()).ok, false)
  }
  res = await fetch(app.origin + '/api/playback', { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(res.status, 403)
  res = await fetch(app.origin + '/api/health', { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(res.status, 403)
  for (const path of ['/api/nope', '/.git/config', '/server/index.js', '/api/playback/no-such-id', '/vendor/../../package.json']) {
    res = await app.get(path)
    assert.equal(res.status, 404)
    assert.equal((await res.json()).ok, false)
  }
  assert.equal((await app.get('/api/cover?u=https://127.0.0.1')).status, 400)
  assert.equal((await app.get('/api/playback/../foo')).status, 404)
})

test('HTTP retry-next is explicit and keeps the current playlist available', async t => {
  let failed = false
  const app = await setup(t, fixtureUpstream(), { encode: async job => {
    if (job.episode.id === 'e2' && !failed) { failed = true; throw new Error('signed sensitive URL') }
    await fakeEncode(job)
  } })
  const session = await app.manager.create('show', 'e1')
  await until(() => app.manager.status(session.id).nextError)
  assert.equal((await app.get(session.playlistUrl)).status, 200)
  const response = await fetch(app.origin + `/drama/api/playback/${session.id}/retry-next`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).id, session.id)
  await until(() => app.manager.status(session.id).episodes[1]?.ready)
  assert.equal(app.manager.status(session.id).nextError, undefined)
  assert.equal((await app.get(session.playlistUrl)).status, 200)
})

test('PUBLIC_BASE is path-only and removes trailing slash', () => {
  assert.equal(normalizeBase('/drama/'), '/drama')
  assert.equal(normalizeBase('/'), '')
  for (const bad of ['//host', '/x?token=foo', '/x/../secret', 'https://host', '/x#foo']) assert.throws(() => normalizeBase(bad))
})
