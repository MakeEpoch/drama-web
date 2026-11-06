import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, stat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PlaybackManager } from '../server/playback.js'
import { fail } from '../server/errors.js'
import { fixtureUpstream, temporary, fakeEncode, until } from './helpers.js'

async function setup(t, options = {}) {
  const dataDir = await temporary(t)
  const manager = new PlaybackManager({ upstream: fixtureUpstream(), dataDir, encode: fakeEncode, ...options })
  await manager.init()
  t.after(() => manager.close())
  return manager
}

test('rolling playlist retains overlap and stable URL; progress extends exactly one ahead', async t => {
  const m = await setup(t, { base: '/drama' })
  const created = await m.create('show', 'e2')
  assert.match(created.playlistUrl, /^\/drama\/api\/playback\//)
  await m.get(created.id).pending
  await until(() => m.status(created.id).episodes.every(e => e.ready))
  let status = m.status(created.id)
  assert.deepEqual(status.episodes.map(e => e.id), ['e2', 'e3'])
  assert.deepEqual(status.episodes.map(e => e.start), [0, 2])
  const first = m.playlist(created.id)
  assert.doesNotMatch(first, /#EXT-X-PLAYLIST-TYPE/)
  assert.match(first, /#EXT-X-MEDIA-SEQUENCE:0/)
  assert.match(first, /#EXT-X-DISCONTINUITY-SEQUENCE:0/)
  assert.match(first, /#EXT-X-DISCONTINUITY/)
  assert.doesNotMatch(first, /#EXT-X-ENDLIST/)
  assert.doesNotMatch(first, /\.tmp|source\.mp4|https?:/)
  for (let i = 0; i < 10; i++) m.status(created.id)
  assert.equal(m.jobs.size, 2, 'polling does not preheat the whole series')
  assert.throws(() => m.progress(created.id, 10000), /尚不可用/)
  m.progress(created.id, 2.1)
  await m.get(created.id).pending
  await until(() => m.status(created.id).episodes.length === 3 && m.status(created.id).episodes.at(-1).ready)
  assert.deepEqual(m.status(created.id).episodes.map(e => e.id), ['e2', 'e3', 'e4'])
  assert.equal(m.status(created.id).playlistUrl, created.playlistUrl)
  assert.match(m.playlist(created.id), new RegExp(first.split('\n').filter(x => x.startsWith('/'))[0]))
  assert.equal(m.jobs.size, 3)
  m.progress(created.id, 4.1)
  await m.get(created.id).pending
  await until(() => m.status(created.id).episodes.at(-1).ready)
  m.progress(created.id, 6.1)
  await m.get(created.id).pending
  await until(() => m.status(created.id).finished)
  status = m.status(created.id)
  assert.deepEqual(status.episodes.map(e => e.start), [4, 6, 8])
  assert.match(m.playlist(created.id), /#EXT-X-MEDIA-SEQUENCE:2/)
  assert.match(m.playlist(created.id), /#EXT-X-DISCONTINUITY-SEQUENCE:2/)
  assert.match(m.playlist(created.id), /#EXT-X-ENDLIST\n$/)
  assert.equal(status.state, 'ready')
  assert.equal(m.progress(created.id, 10).state, 'ended')
})

test('shared jobs, bounded concurrency and request/session cancellation do not cancel a shared transcode', async t => {
  let active = 0; let peak = 0
  const gates = []
  const m = await setup(t, { concurrency: 1, encode: async job => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => { gates.push(resolve); job.controller.signal.addEventListener('abort', resolve, { once: true }) })
    await fakeEncode(job)
    active--
  } })
  const a = await m.create('show', 'e1')
  const b = await m.create('show', 'e1')
  await Promise.all([m.get(a.id).pending, m.get(b.id).pending])
  await until(() => gates.length === 1)
  assert.equal(m.jobs.size, 2)
  assert.equal(m.running, 1)
  await m.release(a.id)
  assert.equal([...m.jobs.values()][0].controller.signal.aborted, false)
  gates.shift()()
  await until(() => gates.length === 1)
  gates.shift()()
  await until(() => !m.running)
  assert.equal(peak, 1)
  assert.equal(m.status(b.id).episodes.length, 2)
  assert.equal([...m.jobs.values()][0].refs.size, 1)
})

test('preparing playlists return 425 and failures are explicit with sensitive text removed', async t => {
  let unblock
  const m = await setup(t, { encode: async () => {
    await new Promise(resolve => { unblock = resolve })
    throw new Error('https://cdn.example/private?signature=secret key=deadbeef')
  }, concurrency: 1 })
  const { id } = await m.create('show', 'e6')
  await until(() => unblock)
  assert.equal(m.status(id).state, 'preparing')
  assert.throws(() => m.playlist(id), error => error.status === 425)
  unblock()
  await until(() => m.status(id).state === 'error')
  assert.deepEqual(m.status(id).error, { code: 'UPSTREAM_FAILED', message: '上游或媒体处理失败，请稍后重试' })
  assert.throws(() => m.playlist(id), /上游或媒体处理失败/)
})

test('failed preheat preserves current playlist and explicit retry repairs next without changing session', async t => {
  let attempts = 0
  const m = await setup(t, { encode: async job => {
    if (job.episode.id === 'e2' && ++attempts === 1) throw fail('SOURCE_TIMEOUT', '来源读取超时', 504)
    await fakeEncode(job)
  } })
  const { id } = await m.create('show', 'e1')
  await until(() => m.status(id).nextError)
  const before = m.playlist(id)
  const first = m.get(id).entries[0].job
  assert.equal(m.status(id).state, 'ready')
  assert.equal(m.status(id).nextError.episodeId, 'e2')
  assert.equal(m.status(id).finished, false)
  for (let i = 0; i < 5; i++) m.progress(id, 1)
  await m.get(id).pending
  assert.equal(attempts, 1, 'progress does not automatically retry the failed source')
  await m.retryNext(id)
  await until(() => m.status(id).episodes[1]?.ready)
  assert.equal(attempts, 2)
  assert.equal(m.status(id).nextError, undefined)
  assert.equal(m.get(id).entries[0].job, first)
  assert.ok(m.playlist(id).includes(before.split('\n').find(row => row.startsWith('/'))))
})

test('current transcode failure keeps its already published buffer until it is exhausted', async t => {
  const m = await setup(t, { encode: async job => {
    await fakeEncode(job)
    throw fail('TRANSCODE_FAILED', '媒体转码失败')
  } })
  const { id } = await m.create('show', 'e6')
  await until(() => m.status(id).nextError)
  assert.equal(m.status(id).state, 'ready')
  assert.match(m.playlist(id), /#EXTINF:2/)
  assert.equal(m.progress(id, 2).state, 'error')
})

test('failed current transcode is not reported as finished and typed resource errors remain visible', async t => {
  const m = await setup(t, { encode: async job => {
    if (job.episode.id === 'e2') throw fail('SOURCE_TIMEOUT', '来源读取超时', 504)
    await fakeEncode(job)
  } })
  const { id } = await m.create('show', 'e2')
  await until(() => m.status(id).state === 'error')
  assert.equal(m.status(id).finished, false)
  assert.equal(m.status(id).error.code, 'SOURCE_TIMEOUT')
})

test('disk budget rejects extra work instead of evicting active files; release enables age cleanup', async t => {
  const m = await setup(t, { maxBytes: 256, jobBudget: 256, concurrency: 1, cacheAgeMs: 1,
    encode: async job => { await fakeEncode(job); await writeFile(join(job.dir, 'large.bin'), Buffer.alloc(240)) } })
  const a = await m.create('show', 'e6')
  await m.get(a.id).pending
  await until(() => !m.running)
  const job = [...m.jobs.values()][0]
  assert.equal(job.refs.size, 1)
  const b = await m.create('show', 'e4')
  await m.get(b.id).pending
  assert.equal(m.status(b.id).state, 'error')
  assert.equal(m.status(b.id).error.code, 'CACHE_FULL')
  assert.ok(await stat(join(job.dir, 's000000.ts')))
  job.usedAt = 0
  await m.cleanup()
  assert.ok(m.jobs.has(job.key), 'active data protected even past age limit')
  await m.release(a.id)
  job.usedAt = 0
  await m.cleanup()
  assert.equal(m.jobs.has(job.key), false)
  await assert.rejects(stat(job.dir), { code: 'ENOENT' })
})

test('idle sessions expire, max session admission is race-safe, IDs/segments are validated', async t => {
  const m = await setup(t, { maxSessions: 1 })
  const results = await Promise.allSettled([m.create('show', 'e1'), m.create('show', 'e1')])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  const id = results.find(row => row.status === 'fulfilled').value.id
  await assert.rejects(m.create('show', 'other'), error => error.status === 503)
  for (const value of [NaN, Infinity, -1, '1']) assert.throws(() => m.progress(id, value), error => error.status === 400)
  assert.throws(() => m.status('../secret'), error => error.status === 400)
  assert.throws(() => m.segment(id, '../x', 's000000.ts'), error => error.status === 404)
  assert.throws(() => m.segment(id, 'a'.repeat(64), 's000000.ts'), error => error.status === 404)
  await m.get(id).pending
  m.get(id).usedAt = 0
  await m.cleanup()
  assert.throws(() => m.status(id), error => error.status === 404)
})

test('small cache supports many episode advances with bounded refs, stable absolute times and reader protection', async t => {
  const upstream = fixtureUpstream(6)
  const m = await setup(t, { upstream, maxBytes: 200, jobBudget: 100 })
  const { id } = await m.create('show', 'e1')
  await m.get(id).pending
  await until(() => !m.running)
  const oldJob = m.get(id).entries[0].job
  const lease = m.leaseSegment(id, oldJob.key, oldJob.segments[0].name)
  let previousURL
  for (let index = 1; index <= 5; index++) {
    m.progress(id, index * 2 + 0.05)
    await m.get(id).pending
    await until(() => !m.running)
    const status = m.status(id)
    assert.equal(status.nextError, undefined)
    assert.notEqual(status.state, 'error')
    assert.ok(status.episodes.length <= 3)
    assert.ok(m.jobs.size <= (index < 2 ? 3 : 4), 'only window plus in-flight old reader remains')
    assert.ok(status.episodes.some(row => row.start === index * 2))
    const manifest = m.playlist(id)
    assert.doesNotMatch(manifest, /PLAYLIST-TYPE/)
    const uri = manifest.split('\n').find(row => row.startsWith('/'))
    if (previousURL && index === 2) assert.ok(manifest.includes(previousURL), 'overlap episode segment URI survives rolling')
    previousURL = status.episodes.length > 1 ? manifest.split('\n').filter(row => row.startsWith('/'))[1] : uri
  }
  assert.ok(await stat(lease.path), 'reader pins file after historical session refs are released')
  lease.release()
  await until(() => !m.jobs.has(oldJob.key))
  await assert.rejects(stat(lease.path), { code: 'ENOENT' })
  assert.throws(() => m.progress(id, 0), /移出窗口/)
  assert.match(m.playlist(id), /#EXT-X-ENDLIST/)
})

test('rapid selection cancels exclusive running/queued jobs but not shared jobs', async t => {
  const started = []
  const m = await setup(t, { concurrency: 1, encode: async job => {
    started.push(job)
    await new Promise(resolve => job.controller.signal.addEventListener('abort', resolve, { once: true }))
    throw fail('TRANSCODE_CANCELLED', '媒体处理已取消')
  } })
  const a = await m.create('show', 'e1')
  const b = await m.create('show', 'e1')
  await Promise.all([m.get(a.id).pending, m.get(b.id).pending])
  await until(() => started.length === 1)
  await m.release(a.id)
  assert.equal(started[0].controller.signal.aborted, false)
  assert.equal(m.queue.length, 1)
  await m.release(b.id)
  await until(() => m.jobs.size === 0 && !m.running)
  assert.equal(started[0].controller.signal.aborted, true)
  assert.equal(m.queue.length, 0)
  assert.equal(started.length, 1, 'orphan queued next was never started')
  for (let i = 0; i < 5; i++) {
    const created = await m.create('show', 'e3')
    await m.get(created.id).pending
    await until(() => m.running === 1)
    await m.release(created.id)
    await until(() => !m.running && !m.jobs.size)
  }
})

test('startup cleanup is scoped to application HLS dirs and preserves unrelated DATA_DIR files', async t => {
  const dataDir = await temporary(t)
  const generated = join(dataDir, 'hls-v1', 'a'.repeat(64))
  await mkdir(generated, { recursive: true })
  await writeFile(join(generated, 'stale.ts'), 'stale')
  await writeFile(join(dataDir, 'do-not-touch.json'), 'unrelated')
  await mkdir(join(dataDir, 'hls-v1', 'unrelated'))
  const m = new PlaybackManager({ dataDir, upstream: fixtureUpstream(), encode: fakeEncode })
  await m.init()
  t.after(() => m.close())
  await assert.rejects(stat(generated), { code: 'ENOENT' })
  assert.equal(await readFile(join(dataDir, 'do-not-touch.json'), 'utf8'), 'unrelated')
  assert.ok(await stat(join(dataDir, 'hls-v1', 'unrelated')))
})
