import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { copyFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createApp } from '../server/app.js'
import { runProcess, parsePlaylist, encodeEpisode } from '../server/media.js'
import { fixtureUpstream, temporary, until } from './helpers.js'

async function synth(path, seconds, audio = true) {
  await runProcess('/usr/bin/ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=25',
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []),
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
    ...(audio ? ['-c:a', 'aac'] : []), '-movflags', '+faststart', path], { timeoutMs: 30_000 })
}

test('real FFmpeg encodes progressively; continuous H264/AAC TS timeline decodes across episode discontinuities', { timeout: 60_000 }, async t => {
  const dataDir = await temporary(t)
  const a = join(dataDir, 'with-audio.mp4')
  const b = join(dataDir, 'no-audio.mp4')
  await synth(a, 32.12)
  await synth(b, 4.12, false)
  const upstream = fixtureUpstream(3)
  let sources = 0
  upstream.source = async (id, target) => { sources++; await copyFile(id === 'e1' ? a : b, target); return { path: target } }
  const app = await createApp({ dataDir, base: '/drama', upstream, managerOptions: { mode: 'hls', encoding: { width: 320, height: 568 } } })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(() => app.close())
  const origin = `http://127.0.0.1:${app.server.address().port}`
  const created = await app.manager.create('show', 'e1')
  let progressive = false
  await until(async () => {
    const status = app.manager.status(created.id)
    assert.notEqual(status.state, 'error', JSON.stringify(status.error))
    const firstJob = app.manager.get(created.id).entries[0]?.job
    if (status.episodes[0]?.ready && firstJob && !firstJob.done) {
      progressive = true
      const early = await fetch(origin + created.playlistUrl)
      assert.equal(early.status, 200)
      const text = await early.text()
      assert.doesNotMatch(text, /ENDLIST|\.tmp/)
      const segment = text.split('\n').find(row => row.startsWith('/'))
      assert.equal((await fetch(origin + segment)).status, 200)
    }
    return firstJob?.done && status.episodes[1]?.ready
  }, 30_000)
  assert.equal(progressive, true, 'first segment was available before full episode encode finished')
  const initial = app.manager.status(created.id)
  assert.equal(initial.episodes.length, 2)
  assert.equal(sources, 2)
  assert.equal(initial.finished, false)
  assert.ok(Math.abs(initial.episodes[0].duration - 32.12) < 0.2)
  assert.ok(Math.abs(initial.episodes[1].start - initial.episodes[0].duration) < 0.001)
  const before = await (await fetch(origin + created.playlistUrl)).text()
  assert.equal((before.match(/#EXT-X-DISCONTINUITY\n/g) ?? []).length, 1)
  assert.doesNotMatch(before, /ENDLIST/)
  app.manager.progress(created.id, initial.episodes[1].start + 0.1)
  await until(() => {
    const s = app.manager.status(created.id)
    assert.notEqual(s.state, 'error', JSON.stringify(s.error))
    return s.finished && !app.manager.running
  }, 15_000)
  const final = app.manager.status(created.id)
  assert.equal(sources, 3)
  assert.equal(final.playlistUrl, created.playlistUrl)
  assert.equal(final.episodes.length, 3)
  const text = await (await fetch(origin + created.playlistUrl)).text()
  assert.equal((text.match(/#EXT-X-DISCONTINUITY\n/g) ?? []).length, 2)
  assert.match(text, /#EXT-X-ENDLIST\n$/)
  assert.match(text, /#EXT-X-TARGETDURATION:3/)
  // Every published segment is complete and each boundary has identical codecs,
  // dimensions, pixel format, sample rate and stereo layout, including silence.
  const streams = []
  for (const entry of app.manager.get(created.id).entries) {
    const path = app.manager.segment(created.id, entry.job.key, entry.job.segments[0].name)
    streams.push(JSON.parse(await runProcess('/usr/bin/ffprobe', ['-v', 'quiet', '-i', path, '-show_entries', 'stream=codec_name,width,height,pix_fmt,sample_rate,channels', '-of', 'json'], { capture: true })).streams)
    await assert.rejects(stat(join(entry.job.dir, 'source.mp4')), { code: 'ENOENT' })
  }
  assert.deepEqual(streams[0], streams[1])
  assert.deepEqual(streams[1], streams[2])
  assert.equal(streams[0][0].codec_name, 'h264')
  assert.equal(streams[0][1].codec_name, 'aac')
  assert.equal(streams[0][1].channels, 2)
  // HTTP HLS decoder reads the exact stable session manifest, not a handcrafted
  // concatenation. This is media/HTTP verification, not a browser test.
  await runProcess('/usr/bin/ffmpeg', ['-v', 'error', '-i', origin + created.playlistUrl, '-f', 'null', '-'], { timeoutMs: 30_000 })
  const firstCount = app.manager.get(created.id).entries[0].job.segments.length
  app.manager.progress(created.id, final.episodes[2].start + 0.1)
  await app.manager.maintenance
  const rolled = await (await fetch(origin + created.playlistUrl)).text()
  assert.match(rolled, new RegExp(`#EXT-X-MEDIA-SEQUENCE:${firstCount}\\n`))
  assert.match(rolled, /#EXT-X-DISCONTINUITY-SEQUENCE:1/)
  assert.equal(app.manager.status(created.id).episodes[0].start, final.episodes[1].start)
  await runProcess('/usr/bin/ffmpeg', ['-v', 'error', '-i', origin + created.playlistUrl, '-f', 'null', '-'], { timeoutMs: 30_000 })
  const total = final.episodes.reduce((sum, row) => sum + row.duration, 0)
  assert.equal(app.manager.progress(created.id, total).state, 'ended')
  t.diagnostic(`progressive=${progressive}; sources=${sources}; timeline=${final.episodes.map(e => `${e.id}@${e.start.toFixed(3)}+${e.duration.toFixed(3)}`).join(', ')}; HTTP HLS decode=ok`)
})

test('real transcode rejects corrupt source and cleans temporary input without exposing diagnostic secrets', async t => {
  const dataDir = await temporary(t)
  const dir = join(dataDir, 'job')
  await mkdir(dir)
  const job = { dir, episode: { id: 'bad' }, controller: new AbortController(), segments: [] }
  await assert.rejects(encodeEpisode(job, { source: async (_, path) => { await writeFile(path, 'not a video secret_key=123'); return { path } } }), error => error.code === 'TRANSCODE_FAILED' && !error.message.includes('secret'))
  await assert.rejects(stat(join(dir, 'source.mp4')), { code: 'ENOENT' })
})

test('local synthetic CENC decrypts to HLS and output-limit failures do not leave downloaded input', async t => {
  const dir = await temporary(t)
  const plain = join(dir, 'plain.mp4')
  const encrypted = join(dir, 'encrypted.mp4')
  const key = randomBytes(16).toString('hex')
  await synth(plain, 4.12)
  await runProcess('/usr/bin/ffmpeg', ['-v', 'error', '-y', '-i', plain, '-c', 'copy', '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', key, '-encryption_kid', randomBytes(16).toString('hex'), encrypted])
  const output = join(dir, 'output')
  await mkdir(output)
  const source = async (_, path) => { await copyFile(encrypted, path); return { path, key } }
  const job = { dir: output, episode: { id: 'local-encrypted' }, controller: new AbortController(), segments: [] }
  await encodeEpisode(job, { source, width: 160, height: 288 })
  assert.equal(job.done, true)
  assert.ok(job.segments.length >= 2)
  assert.doesNotMatch(JSON.stringify(job.segments), new RegExp(key))
  await assert.rejects(stat(join(output, 'source.mp4')), { code: 'ENOENT' })
  const limited = join(dir, 'limited')
  await mkdir(limited)
  const small = { dir: limited, episode: { id: 'limited' }, controller: new AbortController(), segments: [] }
  await assert.rejects(encodeEpisode(small, { source, width: 160, height: 288, outputLimit: 1 }), error => error.code === 'OUTPUT_TOO_LARGE')
  await assert.rejects(stat(join(limited, 'source.mp4')), { code: 'ENOENT' })
})

test('process missing binary, timeout, abort and parser path injection are explicit errors', async () => {
  await assert.rejects(runProcess('/does-not-exist', []), error => error.code === 'TRANSCODE_UNAVAILABLE')
  await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 30 }), error => error.code === 'TRANSCODE_TIMEOUT')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal: controller.signal }), error => error.code === 'TRANSCODE_CANCELLED')
  assert.throws(() => parsePlaylist('#EXTINF:2,\n../../private.ts\n'), /无效/)
  assert.throws(() => parsePlaylist('#EXTINF:4,\ns000000.ts\n'), /无效/)
  assert.deepEqual(parsePlaylist('#EXTINF:2,\ns000000.ts\n#EXTINF:1,\n'), [{ name: 's000000.ts', duration: 2 }])
})
