import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PageCinema } from '../public/cinema.js'

globalThis.location = { href: 'http://localhost/', origin: 'http://localhost' }
const { DramaPlayer } = await import('../public/player.js')
function classes() {
  const values = new Set()
  return { values, toggle(name, on) { if (on) values.add(name); else values.delete(name) }, contains(name) { return values.has(name) } }
}
function environment(matches = false) {
  const media = new EventTarget(); media.matches = matches
  const doc = new EventTarget(); doc.body = { classList: classes() }
  const root = { classList: classes(), video: { src: '/same.mp4', currentTime: 12 } }
  const button = { textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v } }
  let query
  const win = { matchMedia(value) { query = value; return media } }
  const cinema = new PageCinema(root, button, doc, win)
  return { cinema, media, doc, root, button, query }
}
test('phone landscape auto cinema, portrait restores, desktop landscape remains normal and manual toggle preserves video', () => {
  const { cinema, media, doc, root, button, query } = environment()
  assert.match(query, /pointer: coarse/)
  assert.match(query, /max-height: 600px/)
  cinema.setActive(true)
  assert.equal(cinema.enabled, false, 'desktop/non-phone query does not auto hide the detail')
  const video = root.video
  media.matches = true; media.dispatchEvent(new Event('change'))
  assert.equal(cinema.enabled, true)
  assert.ok(doc.body.classList.contains('page-cinema'))
  assert.equal(button.textContent, '退出全屏')
  cinema.toggle()
  assert.equal(cinema.enabled, false, 'explicit exit remains exited while landscape')
  media.dispatchEvent(new Event('change')); assert.equal(cinema.enabled, false)
  media.matches = false; media.dispatchEvent(new Event('change'))
  assert.equal(cinema.enabled, false)
  cinema.toggle(); assert.equal(cinema.enabled, true, 'manual page fullscreen also works in portrait/desktop')
  const escape = new Event('keydown'); escape.key = 'Escape'; doc.dispatchEvent(escape)
  assert.equal(cinema.enabled, false)
  media.matches = true; media.dispatchEvent(new Event('change')); assert.equal(cinema.enabled, true)
  media.matches = false; media.dispatchEvent(new Event('change')); assert.equal(cinema.enabled, false)
  assert.equal(root.video, video); assert.equal(video.src, '/same.mp4'); assert.equal(video.currentTime, 12)
  cinema.destroy()
})
test('leaving detail/pagehide cleanup removes cinema and cannot reenter on a later rotation', () => {
  const { cinema, media, doc } = environment(true)
  cinema.setActive(true); assert.equal(cinema.enabled, true)
  cinema.setActive(false)
  media.dispatchEvent(new Event('change'))
  assert.equal(cinema.enabled, false)
  assert.equal(doc.body.classList.contains('page-cinema'), false)
  cinema.destroy()
  cinema.active = true; media.dispatchEvent(new Event('change'))
  assert.equal(cinema.enabled, false, 'destroy removed the orientation observer')
})

const timeline = [
  { id: 'e1', number: 1, start: 0, duration: 60, ready: true, mediaUrl: '/api/e1.mp4' },
  { id: 'e2', number: 2, start: 60, duration: 40, ready: true, mediaUrl: '/api/e2.mp4' },
  { id: 'e3', number: 3, start: 100, duration: 50, ready: true, mediaUrl: '/api/e3.mp4' },
]
function player() {
  const p = Object.create(DramaPlayer.prototype)
  const video = new EventTarget()
  Object.assign(video, { src: '/api/e1.mp4', currentTime: 60, paused: true, ended: true, load() { this.currentTime = 0; this.ended = false }, pause() {}, play: async () => {} })
  Object.assign(p, { video, mode: 'file', fileEpisode: timeline[0], episodes: timeline, timeline, current: timeline[0], loaded: true, generation: 1, initialTarget: null,
    session: { id: 'same' }, status: { mode: 'file', finished: true, episodes: timeline },
    seek: { setAttribute() {} }, clock: {}, previous: {}, next: {}, note: {}, nextWarning: {}, nextMessage: {}, retryNextButton: {},
    save() {}, reportProgress() {}, showOverlay(...args) { this.overlayMessage = args[1] },
  })
  return p
}
test('file ended selects the next prepared episode on the SAME video/session even when all files finished preparing', () => {
  const p = player(), video = p.video, session = p.session
  p.cinema = { enabled: true }
  p.onEnded()
  assert.equal(p.fileEpisode.id, 'e2')
  assert.equal(video.src, 'http://localhost/api/e2.mp4')
  p.initialTarget = null; video.currentTime = 40; video.ended = true
  p.onEnded(); assert.equal(p.fileEpisode.id, 'e3')
  p.initialTarget = null; video.currentTime = 50; video.ended = true
  p.onEnded(); assert.equal(p.overlayMessage, '已播放完当前剧集')
  assert.equal(p.video, video); assert.equal(p.session, session); assert.equal(p.cinema.enabled, true)
})
test('ended waits for unprepared next and status completion advances once, not a new playback session', () => {
  const p = player()
  p.status.finished = false
  p.timeline = [timeline[0], { ...timeline[1], ready: false, mediaUrl: undefined }]
  p.onEnded(); assert.equal(p.continuationWanted, true); assert.equal(p.fileEpisode.id, 'e1')
  p.acceptStatus({ mode: 'file', state: 'ready', finished: false, episodes: timeline.slice(0, 2) })
  assert.equal(p.fileEpisode.id, 'e2'); assert.equal(p.continuationWanted, false)
  const src = p.video.src
  p.acceptStatus({ mode: 'file', state: 'ready', finished: false, episodes: timeline.slice(0, 2) })
  assert.equal(p.video.src, src)
  assert.equal(p.session.id, 'same')
})
test('file progress/seek uses episode-relative media time with absolute server timeline', () => {
  const p = player(); p.fileEpisode = timeline[1]; p.video.currentTime = 5; p.video.ended = false
  assert.equal(p.playbackTime(), 65)
  p.seekEpisode(12)
  assert.equal(p.video.currentTime, 12)
  assert.equal(p.playbackTime(), 72)
})
test('timeupdate drives throttled progress without interval callbacks; webkit/visibility events force a sync', t => {
  const p = player(); let reports = 0; let now = 10000
  p.reportProgress = () => reports++
  const doc = new EventTarget(); doc.hidden = false
  const original = globalThis.document; globalThis.document = doc
  t.after(() => { globalThis.document = original })
  t.mock.method(Date, 'now', () => now)
  p.bindContinuityEvents()
  p.video.dispatchEvent(new Event('timeupdate')); assert.equal(reports, 1)
  p.video.dispatchEvent(new Event('timeupdate')); assert.equal(reports, 1)
  now += 6000; p.video.dispatchEvent(new Event('timeupdate')); assert.equal(reports, 2)
  p.video.dispatchEvent(new Event('webkitendfullscreen')); assert.equal(reports, 3)
  doc.dispatchEvent(new Event('visibilitychange')); assert.equal(reports, 4)
  p.session = null; p.loaded = false; doc.dispatchEvent(new Event('visibilitychange')); assert.equal(reports, 4)
})
test('next preload selects just one ready episode and yields bandwidth when current playback is not buffered', () => {
  const p = player(); const calls = []
  p.prefetch = { update: (...args) => calls.push(args) }
  p.video.readyState = 3; p.video.paused = false; p.video.currentTime = 10; p.video.buffered = { length: 1, start: () => 0, end: () => 11 }
  p.overlay = { hidden: true }
  p.prefetchNext(); assert.equal(calls.at(-1)[0].id, 'e2'); assert.equal(calls.at(-1)[1], false)
  p.video.buffered.end = () => 30
  p.prefetchNext(); assert.equal(calls.at(-1)[1], true); assert.equal(calls.at(-1)[0].id, 'e2')
  p.prefetchNext(false); assert.equal(calls.at(-1)[1], false)
})
test('next-file network error retries at 1/2/4s without rebuilding session/replaying previous file; decode errors do not loop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const p = player(); let loads = 0; let fatal = 0
  p.video.load = () => { loads++; p.video.currentTime = 0 }
  p.loadFile(timeline[1], 0, true)
  p.initialTarget = null; p.video.error = { code: 2 }
  for (const delay of [1000, 2000, 4000]) { p.onVideoError(); t.mock.timers.tick(delay); await Promise.resolve() }
  p.onVideoError()
  assert.equal(loads, 4)
  assert.equal(p.switchLoadError.code, 'NEXT_MEDIA_NETWORK')
  assert.equal(p.failed, undefined); assert.equal(p.session.id, 'same'); assert.equal(p.fileEpisode.id, 'e2')
  await p.retryNext(); assert.equal(loads, 5); assert.equal(p.switchLoadError, null)
  p.fail = () => { fatal++ }
  p.video.error = { code: 4 }; p.onVideoError(); t.mock.timers.tick(30000)
  assert.equal(fatal, 1); assert.equal(loads, 5); assert.equal(p.switchRecovery, null)
})
test('new-file/stop cleanup cancels old prefetch, switch retry and controls timers; stale callbacks cannot reload a newer episode', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const p = player(); let loads = 0, cancels = 0, uiResets = 0
  p.prefetch = { reset: () => cancels++ }
  p.controlsUI = { reset: () => uiResets++, start() {} }
  p.video.load = () => { loads++ }; p.video.removeAttribute = () => {}; p.release = () => {}
  p.loadFile(timeline[1], 0, true); p.video.error = { code: 2 }; p.onVideoError()
  p.loadFile(timeline[2], 0, true)
  t.mock.timers.tick(30000); assert.equal(loads, 2); assert.equal(p.fileEpisode.id, 'e3')
  p.onVideoError(); p.stop(); t.mock.timers.tick(30000)
  assert.equal(loads, 3, 'stop clears video once; no late retry reload')
  assert.equal(p.session, null); assert.equal(p.switchRecovery, null)
  assert.equal(cancels, 3); assert.equal(uiResets, 3)
})
test('cinema CSS covers safe areas/dynamic viewport; button path does not invoke native fullscreen', async () => {
  const css = await readFile(new URL('../public/app.css', import.meta.url), 'utf8')
  const source = await readFile(new URL('../public/player.js', import.meta.url), 'utf8')
  assert.match(css, /height:100dvh/); assert.match(css, /safe-area-inset-bottom/)
  assert.match(css, /\.page-cinema \.site-header/); assert.match(css, /\.page-cinema \.episode-panel/)
  assert.doesNotMatch(source, /webkitEnterFullscreen\(|requestFullscreen\(|exitFullscreen\(/)
})
