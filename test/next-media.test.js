import test from 'node:test'
import assert from 'node:assert/strict'
import { NextMedia } from '../public/next-media.js'

const flush = () => new Promise(resolve => setImmediate(resolve))
const first = { id: 'e2', mediaUrl: 'http://localhost/api/e2.mp4' }
const second = { id: 'e3', mediaUrl: 'http://localhost/api/e3.mp4' }
const response = () => new Response('prefix', { status: 206, headers: { 'content-length': '6' } })
test('prefetch reads only a bounded next-file prefix, once, without a second video or retained Blob', async t => {
  const calls = []
  const loader = new NextMedia({ fetcher: async (url, options) => { calls.push({ url, options }); return response() } })
  t.after(() => loader.reset())
  loader.update(first, false); await flush(); assert.equal(calls.length, 0)
  loader.update(first, true); await flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, first.mediaUrl)
  assert.equal(calls[0].options.headers.Range, 'bytes=0-1048575')
  assert.equal(calls[0].options.priority, 'low')
  assert.equal(loader.done, true)
  loader.update(first, true); await flush(); assert.equal(calls.length, 1)
  loader.update(second, true); await flush(); assert.equal(calls.length, 2)
  assert.equal(loader.row.id, 'e3')
})
test('network failure has exactly three backoff retries; exhaustion stays explicit until manual retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0, warning
  const loader = new NextMedia({ changed: error => { warning = error }, fetcher: async () => { calls++; throw new TypeError('temporary connection failure') } })
  t.after(() => loader.reset())
  loader.update(first, true); await flush()
  for (const delay of [1000, 2000, 4000]) { t.mock.timers.tick(delay); await flush() }
  assert.equal(calls, 4)
  assert.equal(warning.code, 'NEXT_PRELOAD_FAILED')
  loader.update(first, true); t.mock.timers.tick(20000); await flush(); assert.equal(calls, 4)
  loader.fetcher = async () => { calls++; return response() }
  loader.retry(); await flush()
  assert.equal(calls, 5); assert.equal(loader.error, null); assert.equal(warning, null); assert.equal(loader.done, true)
})
test('deterministic 404/oversized response do not automatically retry or read an entire file', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const loader = new NextMedia({ fetcher: async () => { calls++; return new Response('', { status: 404 }) } })
  t.after(() => loader.reset())
  loader.update(first, true); await flush(); t.mock.timers.tick(20000); await flush()
  assert.equal(calls, 1); assert.ok(loader.error)
  loader.reset()
  loader.fetcher = async () => { calls++; return new Response('large', { status: 206, headers: { 'content-length': '2000000' } }) }
  loader.update(first, true); await flush(); t.mock.timers.tick(20000); await flush()
  assert.equal(calls, 2); assert.ok(loader.error)
})
test('current-playback priority aborts a prefetch without counting failure and can resume it', async t => {
  let calls = 0, signal
  const loader = new NextMedia({ fetcher: async (_, options) => {
    calls++; signal = options.signal
    if (calls === 1) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }))
    return response()
  } })
  t.after(() => loader.reset())
  loader.update(first, true); await flush()
  loader.update(first, false); await flush()
  assert.equal(signal.aborted, true); assert.equal(loader.retries, 0); assert.equal(loader.error, null)
  loader.update(first, true); await flush()
  assert.equal(calls, 2); assert.equal(loader.done, true)
})
test('leave/episode change cancels requests/backoff, and late old responses cannot overwrite the new next episode', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let resolveOld, oldSignal, calls = 0
  const loader = new NextMedia({ fetcher: (_, options) => {
    calls++
    if (calls === 1) { oldSignal = options.signal; return new Promise(resolve => { resolveOld = resolve }) }
    return Promise.resolve(response())
  } })
  t.after(() => loader.reset())
  loader.update(first, true); await flush()
  loader.update(second, true); await flush()
  assert.equal(oldSignal.aborted, true); assert.equal(loader.row.id, 'e3'); assert.equal(loader.done, true)
  resolveOld(new Response('', { status: 500 })); await flush()
  assert.equal(loader.row.id, 'e3'); assert.equal(loader.done, true); assert.equal(loader.error, null)
  loader.reset(); t.mock.timers.tick(30000); await flush()
  assert.equal(calls, 2); assert.equal(loader.row, null)
})
test('hung network attempts have an eight-second timeout and bounded retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const loader = new NextMedia({ fetcher: (_, options) => { calls++; return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true })) } })
  t.after(() => loader.reset())
  loader.update(first, true); await flush()
  for (const delay of [1000, 2000, 4000]) { t.mock.timers.tick(8000); await flush(); t.mock.timers.tick(delay); await flush() }
  t.mock.timers.tick(8000); await flush()
  assert.equal(calls, 4); assert.ok(loader.error); assert.equal(loader.timer, null)
})
