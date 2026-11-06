import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PlayerControls } from '../public/player-controls.js'

function node() {
  const n = new EventTarget(), classes = new Set()
  n.classList = { contains: x => classes.has(x), toggle(x, on) { if (on) classes.add(x); else classes.delete(x) } }
  n.children = new Set(); n.contains = child => n.children.has(child)
  return n
}
function event(name, data = {}) { const e = new Event(name, { cancelable: true, bubbles: true }); Object.assign(e, data); return e }
function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const root = node(), chrome = node(), stage = node(), video = node(), doc = node()
  const state = { blocked: false }; let cancelled = 0
  const ui = new PlayerControls({ root, chrome, stage, video, doc, blocked: () => state.blocked, cancelDrag: () => cancelled++ })
  t.after(() => ui.destroy())
  return { ui, root, chrome, stage, video, doc, state, cancelled: () => cancelled }
}
test('cinema controls fade after three idle seconds, pointer/tap/keyboard wake them without toggling media', t => {
  const f = fixture(t)
  f.ui.setCinema(true)
  t.mock.timers.tick(2999); assert.equal(f.root.classList.contains('controls-hidden'), false)
  t.mock.timers.tick(1); assert.equal(f.root.classList.contains('controls-hidden'), true)
  for (const [target, name] of [[f.root, 'pointermove'], [f.stage, 'pointerdown'], [f.root, 'keydown']]) {
    target.dispatchEvent(event(name))
    assert.equal(f.root.classList.contains('controls-hidden'), false)
    t.mock.timers.tick(3000); assert.equal(f.root.classList.contains('controls-hidden'), true)
  }
})
test('pause, preparation/error and ongoing interaction keep controls visible; steady refresh does not postpone timeout', t => {
  const f = fixture(t)
  f.ui.setCinema(true)
  t.mock.timers.tick(2000); f.ui.refresh(); t.mock.timers.tick(1000)
  assert.equal(f.root.classList.contains('controls-hidden'), true, 'poll refresh does not keep waking healthy playback')
  f.state.blocked = true; f.video.dispatchEvent(event('pause'))
  t.mock.timers.tick(10000); assert.equal(f.root.classList.contains('controls-hidden'), false)
  assert.equal(f.ui.timer, null)
  f.state.blocked = false; f.video.dispatchEvent(event('playing'))
  t.mock.timers.tick(3000); assert.equal(f.root.classList.contains('controls-hidden'), true)
})
test('drag/pointer cancellation, control focus and speed selection cannot disappear mid-interaction', t => {
  const f = fixture(t); f.ui.setCinema(true)
  f.chrome.dispatchEvent(event('pointerdown', { pointerId: 1 }))
  f.chrome.dispatchEvent(event('input'))
  t.mock.timers.tick(10000); assert.equal(f.root.classList.contains('controls-hidden'), false)
  f.doc.dispatchEvent(event('pointercancel', { pointerId: 1 }))
  assert.equal(f.cancelled(), 1)
  f.chrome.dispatchEvent(event('focusin'))
  t.mock.timers.tick(10000); assert.equal(f.root.classList.contains('controls-hidden'), false)
  f.chrome.dispatchEvent(event('change'))
  f.chrome.dispatchEvent(event('focusout', { relatedTarget: f.stage }))
  t.mock.timers.tick(3000); assert.equal(f.root.classList.contains('controls-hidden'), true)
})
test('pointer button release can idle-hide, while keyboard button focus stays visible', t => {
  const f = fixture(t); f.ui.setCinema(true)
  const button = { closest: () => button, blur: () => { f.doc.activeElement = null } }
  f.chrome.children.add(button); f.doc.activeElement = button
  f.chrome.dispatchEvent(event('focusin'))
  const pointer = event('click', { detail: 1 }); pointer.composedPath = () => [button, f.chrome]
  f.chrome.dispatchEvent(pointer)
  t.mock.timers.tick(3000); assert.equal(f.root.classList.contains('controls-hidden'), true)
  f.doc.activeElement = button; f.chrome.dispatchEvent(event('focusin'))
  const keyboard = event('click', { detail: 0 }); keyboard.composedPath = () => [button, f.chrome]
  f.chrome.dispatchEvent(keyboard)
  t.mock.timers.tick(10000); assert.equal(f.root.classList.contains('controls-hidden'), false)
})
test('control clicks stop propagation; exit, new episode reset, stop/pagehide leave no hide timer', t => {
  const f = fixture(t); f.ui.setCinema(true)
  const click = event('click'); let stopped = false
  click.stopPropagation = () => { stopped = true }
  f.chrome.dispatchEvent(click); assert.equal(stopped, true)
  f.ui.setCinema(false); assert.equal(f.ui.timer, null)
  t.mock.timers.tick(10000); assert.equal(f.root.classList.contains('controls-hidden'), false)
  f.ui.setCinema(true); f.ui.reset(); assert.equal(f.ui.timer, null)
  f.root.dispatchEvent(event('pointermove')); assert.equal(f.ui.timer, null)
  f.ui.start(); assert.notEqual(f.ui.timer, null)
  f.ui.destroy(); assert.equal(f.ui.timer, null)
  f.root.dispatchEvent(event('pointermove')); assert.equal(f.ui.timer, null)
})
test('cinema controls are a gradient overlay with non-intercepting hidden state, while ordinary mode remains static', async () => {
  const css = await readFile(new URL('../public/app.css', import.meta.url), 'utf8')
  assert.match(css, /\.page-cinema-player \.player-chrome\{position:absolute/)
  assert.match(css, /background:linear-gradient\(transparent,rgba\(0,0,0/)
  assert.match(css, /\.controls-hidden \.player-chrome\{opacity:0;pointer-events:none/)
  assert.match(css, /safe-area-inset-bottom/)
  assert.doesNotMatch(css, /(^|\n)\.player-chrome\{position:absolute/)
})
