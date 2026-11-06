import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { join } from 'node:path'
import { createApp } from '../server/app.js'
import { runProcess } from '../server/media.js'
import { temporary, fixtureUpstream, until } from './helpers.js'

test('default original-file path decrypts CENC without encoding and serves complete MP4 with Safari ranges', async t => {
  const dataDir = await temporary(t)
  const raw = join(dataDir, 'raw.mp4'), encrypted = join(dataDir, 'encrypted.mp4')
  const key = randomBytes(16).toString('hex')
  await runProcess('/usr/bin/ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '2.12', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', raw])
  await runProcess('/usr/bin/ffmpeg', ['-v', 'error', '-y', '-i', raw, '-c', 'copy', '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', key, '-encryption_kid', randomBytes(16).toString('hex'), encrypted])
  const hevc = join(dataDir, 'hevc.mp4')
  await runProcess('/usr/bin/ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '0.52', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=1:frame-threads=1:log-level=error', '-tag:v', 'hvc1', hevc])
  const upstream = fixtureUpstream(3)
  let sources = 0
  upstream.source = async (id, path) => { sources++; await copyFile(id === 'e1' ? encrypted : id === 'e3' ? hevc : raw, path); return { path, ...(id === 'e1' ? { key } : {}) } }
  const app = await createApp({ dataDir, upstream })
  t.after(() => app.close())
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening')
  const origin = `http://127.0.0.1:${app.server.address().port}`
  const created = await app.manager.create('show', 'e1')
  assert.equal(created.mode, 'file')
  assert.equal(created.playlistUrl, undefined)
  await until(() => {
    const status = app.manager.status(created.id)
    assert.notEqual(status.state, 'error', JSON.stringify(status.error))
    return status.episodes.length === 2 && status.episodes.every(e => e.ready) && !app.manager.running
  })
  let status = app.manager.status(created.id)
  assert.equal(sources, 2, 'only current+next prepared')
  assert.doesNotMatch(JSON.stringify(status), new RegExp(key))
  assert.doesNotMatch(JSON.stringify(status), /https?:/)
  const url = origin + status.episodes[0].mediaUrl
  for (const range of ['bytes=0-1', 'bytes=100-', 'bytes=-20']) {
    const response = await fetch(url, { headers: { range } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.ok((await response.arrayBuffer()).byteLength > 0)
  }
  const head = await fetch(url, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('accept-ranges'), 'bytes')
  const probe = JSON.parse(await runProcess('/usr/bin/ffprobe', ['-v', 'quiet', '-i', url, '-show_entries', 'stream=codec_name,width,height', '-of', 'json'], { capture: true }))
  assert.equal(probe.streams[0].codec_name, 'h264')
  assert.equal(probe.streams[0].width, 320)
  assert.equal(probe.streams[0].height, 180, 'no portrait padding or video re-encode')
  await runProcess('/usr/bin/ffmpeg', ['-v', 'error', '-i', url, '-f', 'null', '-'])
  app.manager.progress(created.id, status.episodes[1].start)
  await app.manager.get(created.id).pending
  await until(() => app.manager.status(created.id).finished && !app.manager.running)
  status = app.manager.status(created.id)
  assert.equal(sources, 3)
  assert.equal(status.episodes.length, 3)
  const lastURL = origin + status.episodes[2].mediaUrl
  const hevcProbe = JSON.parse(await runProcess('/usr/bin/ffprobe', ['-v', 'quiet', '-i', lastURL, '-show_entries', 'stream=codec_name,codec_tag_string,width,height', '-of', 'json'], { capture: true }))
  assert.equal(hevcProbe.streams[0].codec_name, 'hevc')
  assert.equal(hevcProbe.streams[0].codec_tag_string, 'hvc1')
  await runProcess('/usr/bin/ffmpeg', ['-v', 'error', '-i', lastURL, '-f', 'null', '-'])
  for (const { job } of app.manager.get(created.id).entries) await assert.rejects(stat(join(job.dir, 'source.mp4')), { code: 'ENOENT' })
  await app.manager.release(created.id)
  assert.equal((await fetch(url)).status, 404)
})
