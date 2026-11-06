import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createApp } from '../server/app.js'
import { videoProfile, runProcess } from '../server/media.js'
import { fixtureUpstream, temporary, until } from './helpers.js'

async function synth(path, size) {
  await runProcess('/usr/bin/ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25`, '-t', '4.12', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', path])
}
async function dimensions(path) {
  const info = JSON.parse(await runProcess('/usr/bin/ffprobe', ['-v', 'quiet', '-i', path, '-show_entries', 'stream=codec_type,width,height,sample_aspect_ratio', '-of', 'json'], { capture: true }))
  const video = info.streams.find(stream => stream.codec_type === 'video')
  return { width: video.width, height: video.height, sar: video.sample_aspect_ratio }
}
test('display profile respects source dimensions, SAR, rotation and even dimensions', () => {
  assert.deepEqual(videoProfile({ width: 1920, height: 1080 }), { width: 960, height: 540 })
  assert.deepEqual(videoProfile({ width: 1080, height: 1920 }), { width: 540, height: 960 })
  assert.deepEqual(videoProfile({ width: 720, height: 576, sample_aspect_ratio: '16:15' }), { width: 960, height: 720 })
  assert.deepEqual(videoProfile({ width: 1080, height: 1920, side_data_list: [{ rotation: -90 }] }), { width: 960, height: 540 })
  assert.deepEqual(videoProfile({ width: 1920, height: 1080, tags: { rotate: '90' } }), { width: 540, height: 960 })
  const odd = videoProfile({ width: 1333, height: 777 })
  assert.equal(odd.width % 2 + odd.height % 2, 0)
})

test('real landscape/portrait output follows first admitted episode, not faster preheat probe; profile participates in cache key', { timeout: 60_000 }, async t => {
  const dataDir = await temporary(t)
  const landscape = join(dataDir, 'land.mp4')
  const portrait = join(dataDir, 'portrait.mp4')
  await synth(landscape, '320x180')
  await synth(portrait, '180x320')
  const upstream = fixtureUpstream(3)
  upstream.source = async (id, path) => {
    if (id === 'e1') await delay(80) // preheat e2 probes before the chosen leader
    await copyFile(id === 'e1' ? landscape : portrait, path)
    return { path }
  }
  const app = await createApp({ dataDir, upstream })
  t.after(() => app.close())
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const origin = `http://127.0.0.1:${app.server.address().port}`
  const [land, concurrent] = await Promise.all([app.manager.create('land', 'e1'), app.manager.create('land', 'e2')])
  const port = await app.manager.create('portrait', 'e2')
  await until(() => [land, concurrent, port].every(s => {
    const status = app.manager.status(s.id)
    assert.notEqual(status.state, 'error', JSON.stringify(status.error))
    return status.episodes.length === 2 && status.episodes.every(e => e.ready) && !app.manager.running
  }), 30_000)
  const landSession = app.manager.get(land.id)
  const otherSession = app.manager.get(concurrent.id)
  assert.equal(landSession.profile, otherSession.profile)
  assert.match(landSession.profile.id, /^aspect-v2-/)
  for (const { job } of landSession.entries) {
    assert.deepEqual(await dimensions(app.manager.segment(land.id, job.key, job.segments[0].name)), { width: 960, height: 540, sar: '1:1' })
    assert.equal(job.key, createHash('sha256').update(`${landSession.profile.id}:land:${job.episode.id}`).digest('hex'))
  }
  for (const { job } of app.manager.get(port.id).entries) {
    assert.deepEqual(await dimensions(app.manager.segment(port.id, job.key, job.segments[0].name)), { width: 540, height: 960, sar: '1:1' })
  }
  app.manager.progress(land.id, 4.2)
  await until(() => app.manager.status(land.id).finished)
  await runProcess('/usr/bin/ffmpeg', ['-v', 'error', '-i', origin + land.playlistUrl, '-f', 'null', '-'], { timeoutMs: 30_000 })
  t.diagnostic('landscape=960x540, portrait=540x960; concurrent first-episode profile stable; cross-episode HTTP decode=ok')
})
