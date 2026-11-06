// Retained original 13 frontend checks plus continuous-playback/UI regressions.
// Run: node --test test/frontend.test.js
// Uses real frontend modules with method-level media/Hls stubs, not a DOM,
// browser, network, or real-media integration test. No external dependencies.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const originalGlobals = new Map(['location', 'localStorage', 'window', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const baseLocation = { href: 'http://localhost/drama/', origin: 'http://localhost' };
const storage = new Map();
globalThis.location = baseLocation;
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
const core = await import('../public/core.js');
const { DramaPlayer } = await import('../public/player.js');
const rows = [
  { id: 'e1', number: 1, start: 0, duration: 60, ready: true },
  { id: 'e2', number: 2, start: 60, duration: 40, ready: true },
  { id: 'e3', number: 3, start: 100, duration: 0, ready: false },
];

function playerStub() {
  const player = Object.create(DramaPlayer.prototype);
  Object.assign(player, {
    generation: 1, timeline: [], loaded: false, failed: false, resumeAt: 0,
    session: { id: 'x', statusUrl: '/drama/api/playback/x', playlistUrl: '/drama/api/playback/x/index.m3u8' },
    episodes: rows.slice(0, 2), current: rows[0],
    seek: { setAttribute() {} }, clock: {}, previous: {}, next: {},
    video: { currentTime: 0, canPlayType: () => '', load() {}, play: async () => {} },
    note: { textContent: '' }, nextWarning: { hidden: true }, nextMessage: { textContent: '' }, retryNextButton: {},
    root: {
      style: { values: new Map(), setProperty(name, value) { this.values.set(name, value); } },
      classList: { values: new Map(), toggle(name, value) { this.values.set(name, value); } },
    },
    save() {}, showOverlay() {}, reportProgress() {},
  });
  return player;
}

// Await each check to preserve the same sequential global-stub lifecycle as the
// original stdin run. None of these tests depends on production API access.
await test('root and /drama/ bases resolve correctly', async () => {
  assert.equal(core.localURL('api/feed').pathname, '/drama/api/feed');
  globalThis.location = { href: 'http://localhost/', origin: 'http://localhost' };
  try {
    const root = await import('../public/core.js?root2');
    assert.equal(root.localURL('api/feed').pathname, '/api/feed');
  } finally { globalThis.location = baseLocation; }
});

await test('external, parent and wrong-base resources rejected', () => {
  for (const path of ['https://external.test/a', '//external.test/a', '/api/feed', '../secrets', '/drama-evil/a']) {
    assert.throws(() => core.localURL(path));
  }
});

await test('boundaries map to per-episode positions', () => {
  assert.equal(core.relativeProgress(rows, 0).episode.id, 'e1');
  assert.equal(core.relativeProgress(rows, 59.99).episode.id, 'e1');
  assert.deepEqual(core.relativeProgress(rows, 65), { episode: rows[1], position: 5, duration: 40 });
  assert.equal(core.relativeProgress(rows, 60).position, 0);
  assert.equal(core.relativeProgress(rows, 105).position, 40);
  assert.equal(core.relativeProgress([], 10), null);
});

await test('history bounded to 30 and unavailable storage safe', () => {
  for (let index = 0; index < 35; index++) {
    core.storeProgress({ id: `s${index}` }, { id: 'e2', number: 2 }, 5, 40);
  }
  assert.equal(core.historyItems().length, 30);
  assert.equal(core.historyItems()[0].position, 5);
  const id = core.historyItems()[0].seriesId;
  core.removeHistory(id);
  assert.equal(core.historyItems().some(row => row.seriesId === id), false);
  storage.set(core.HISTORY_KEY, '{bad');
  assert.deepEqual(core.historyItems(), []);
  const save = localStorage.setItem;
  localStorage.setItem = () => { throw Error('denied'); };
  try { assert.equal(core.storeProgress({ id: 's' }, { id: 'e' }, 3, 4), false); }
  finally { localStorage.setItem = save; }
});

await test('time labels safe and hour-aware', () => {
  assert.equal(core.timeLabel(3665), '1:01:05');
  assert.equal(core.timeLabel(NaN), '0:00');
  assert.equal(core.timeLabel(-5), '0:00');
});

await test('ready gate, one Hls/video/source through natural boundary', () => {
  const calls = { created: 0, loads: [], starts: [] };
  class Hls {
    static isSupported() { return true; }
    static Events = { MEDIA_ATTACHED: 'attach', MANIFEST_PARSED: 'parsed', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'network' };
    constructor(config) { calls.created++; calls.config = config; this.listeners = {}; }
    on(event, callback) { this.listeners[event] = callback; }
    loadSource(source) { calls.loads.push(source); }
    startLoad(time) { calls.starts.push(time); }
    attachMedia(video) { calls.video = video; this.listeners.attach(); this.listeners.parsed(); }
  }
  globalThis.window = { Hls };
  const player = playerStub();
  const video = player.video;
  player.acceptStatus({ state: 'preparing', episodes: [{ ...rows[0], ready: false }], finished: false });
  assert.equal(calls.created, 0);
  player.acceptStatus({ state: 'ready', episodes: [rows[0]], finished: false });
  assert.equal(calls.created, 1);
  assert.equal(calls.config.startPosition, 0);
  assert.equal(calls.config.maxLiveSyncPlaybackRate, 1);
  assert.equal(calls.config.liveMaxLatencyDurationCount, Infinity);
  assert.equal(calls.starts[0], 0);
  player.acceptStatus({ state: 'ready', episodes: rows, finished: false });
  player.video.currentTime = 65;
  player.updatePosition();
  assert.equal(calls.created, 1);
  assert.equal(calls.loads.length, 1);
  assert.equal(player.video, video);
  assert.equal(player.current.id, 'e2');
  assert.equal(player.seek.value, '5');
});

await test('native HLS explicitly starts at zero and retains same src', () => {
  globalThis.window = {};
  const player = playerStub();
  let loads = 0;
  player.video.canPlayType = () => 'probably';
  player.video.load = () => loads++;
  player.acceptStatus({ state: 'ready', episodes: [rows[0]], finished: false });
  assert.equal(new URL(player.video.src).hash, '#t=0');
  const source = player.video.src;
  player.acceptStatus({ state: 'ready', episodes: rows, finished: false });
  assert.equal(player.video.src, source);
  assert.equal(loads, 1);
});

await test('resume waits for requested position instead of clamping to first buffer', () => {
  const player = playerStub();
  player.resumeAt = 50;
  let target;
  player.loadPlaylist = () => { target = player.initialTarget; player.loaded = true; };
  player.acceptStatus({ state: 'ready', episodes: [{ ...rows[0], duration: 4 }], finished: false });
  assert.equal(player.loaded, false);
  player.acceptStatus({ state: 'ready', episodes: [{ ...rows[0], duration: 52 }], finished: false });
  assert.equal(target, 50);
});

await test('initial position guard clears only once beginning is available', () => {
  const player = playerStub();
  player.initialTarget = 0;
  player.video.readyState = 3;
  player.alignStart();
  assert.equal(player.initialTarget, null);
  player.initialTarget = 12;
  player.video.currentTime = 40;
  player.alignStart();
  assert.equal(player.video.currentTime, 12);
});

await test('seek converts relative position to session time', () => {
  const player = playerStub();
  player.timeline = rows;
  player.video.currentTime = 65;
  player.seekEpisode(12);
  assert.equal(player.video.currentTime, 72);
  player.seekEpisode(-8);
  assert.equal(player.video.currentTime, 60);
  player.seekEpisode(900);
  assert.ok(player.video.currentTime < 100);
});

await test('stop destroys engine, aborts poll, clears timers, DELETEs session', () => {
  const player = playerStub();
  const calls = [];
  player.loaded = true;
  player.controller = new AbortController();
  const signal = player.controller.signal;
  player.engine = { destroy: () => calls.push('destroy') };
  player.video = { currentTime: 0, pause: () => calls.push('pause'), removeAttribute: name => calls.push(name), load: () => calls.push('load') };
  player.release = id => calls.push(id);
  player.pollTimer = setTimeout(() => assert.fail('poll leaked'), 100);
  player.progressTimer = setInterval(() => assert.fail('progress leaked'), 100);
  try {
    player.stop();
    assert.equal(signal.aborted, true);
    assert.equal(player.session, null);
    assert.equal(player.engine, null);
    assert.equal(player.seek.disabled, true);
    assert.deepEqual(calls, ['destroy', 'pause', 'src', 'load', 'x']);
  } finally {
    clearTimeout(player.pollTimer);
    clearInterval(player.progressTimer);
  }
});

await test('late created sessions are released after navigation', async () => {
  const player = playerStub();
  const releases = [];
  player.stop = () => player.generation++;
  player.updateNavigation = () => {};
  player.release = id => releases.push(id);
  let resolve;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(callback => { resolve = callback; });
  try {
    const pending = player.begin({ id: 's' }, rows, rows[0]);
    player.stop();
    resolve(new Response(JSON.stringify({ id: 'late', statusUrl: '/drama/api/playback/late', playlistUrl: '/drama/api/playback/late/index.m3u8' })));
    await pending;
    assert.deepEqual(releases, ['late']);
    assert.equal(player.loaded, false);
  } finally { globalThis.fetch = originalFetch; }
});

await test('failed preparation retry preserves requested resume', () => {
  const player = playerStub();
  player.series = { id: 's' };
  player.resumeAt = 50;
  player.timeline = [{ ...rows[0], duration: 4 }];
  player.loaded = false;
  let next;
  player.begin = (_series, _episodes, _episode, time) => { next = time; };
  player.retry();
  assert.equal(next, 50);
});

await test('finished paused sessions keep polling for more than the 120-second idle TTL', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const player = playerStub();
  player.loaded = true;
  player.video.paused = true;
  player.controller = new AbortController();
  const status = { state: 'ready', episodes: rows.slice(0, 2), finished: true };
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.method, 'GET');
    requests++;
    return new Response(JSON.stringify(status));
  });
  try {
    await player.poll(player.generation);
    assert.equal(requests, 1);
    for (let index = 0; index < 21; index++) {
      context.mock.timers.tick(6000);
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(requests, 22);
    assert.equal(player.status.finished, true);
    assert.equal(player.failed, false);
    player.generation++;
    context.mock.timers.tick(6000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 22, 'abandoned generation must not poll again');
  } finally { clearTimeout(player.pollTimer); }
});

const nextError = { episodeId: 'e2', code: 'PREHEAT_FAILED', message: '下一集转码失败' };
function playingStub() {
  const player = playerStub();
  player.loaded = true;
  player.initialTarget = null;
  player.controller = new AbortController();
  player.video.pause = () => assert.fail('future-episode errors must not pause current video');
  player.engine = {
    destroy: () => assert.fail('future-episode retry must not destroy engine'),
    stopLoad: () => assert.fail('future-episode retry must not stop current loading'),
  };
  return player;
}

await test('nextError shows a non-blocking retry without pause, overlay or Hls destruction', () => {
  const player = playingStub();
  player.showOverlay = () => assert.fail('nextError must not obscure current video');
  const video = player.video;
  const engine = player.engine;
  player.acceptStatus({ state: 'ready', episodes: rows, finished: false, nextError });
  assert.equal(player.failed, false);
  assert.equal(player.nextWarning.hidden, false);
  assert.match(player.nextMessage.textContent, /第 2 集预热失败/);
  assert.match(player.nextMessage.textContent, /当前集可以继续观看/);
  assert.equal(player.retryNextButton.disabled, false);
  assert.equal(player.video, video);
  assert.equal(player.engine, engine);
});

await test('retry-next POST updates the same session and clears warning with no reload', async context => {
  const player = playingStub();
  player.acceptStatus({ state: 'ready', episodes: rows, finished: false, nextError });
  const video = player.video;
  const engine = player.engine;
  const session = player.session;
  player.begin = () => assert.fail('retry-next must not create a new session');
  player.loadPlaylist = () => assert.fail('retry-next must not reload source');
  let resolve;
  let calls = 0;
  context.mock.method(globalThis, 'fetch', (url, options) => {
    calls++;
    assert.equal(new URL(url).pathname, '/drama/api/playback/x/retry-next');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {});
    return new Promise(callback => { resolve = callback; });
  });
  const pending = player.retryNext();
  assert.equal(player.retryNextButton.disabled, true);
  assert.equal(player.retryNextButton.textContent, '正在重试…');
  await player.retryNext();
  assert.equal(calls, 1, 'double clicks must not duplicate retry');
  resolve(new Response(JSON.stringify({ state: 'ready', episodes: rows, finished: false })));
  await pending;
  assert.equal(player.nextWarning.hidden, true);
  assert.equal(player.nextRetryBusy, false);
  assert.equal(player.session, session);
  assert.equal(player.video, video);
  assert.equal(player.engine, engine);
});

await test('retry-next HTTP failure leaves current playback intact and retry available', async context => {
  const player = playingStub();
  player.acceptStatus({ state: 'ready', episodes: rows, finished: false, nextError });
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: false, error: { message: '预热服务暂不可用' } }), { status: 503 }));
  await player.retryNext();
  assert.equal(player.failed, false);
  assert.equal(player.nextWarning.hidden, false);
  assert.match(player.nextMessage.textContent, /重试未成功：预热服务暂不可用/);
  assert.equal(player.retryNextButton.disabled, false);
});

await test('late retry-next response cannot update an abandoned session', async context => {
  const player = playingStub();
  player.acceptStatus({ state: 'ready', episodes: rows, finished: false, nextError });
  let resolve;
  context.mock.method(globalThis, 'fetch', () => new Promise(callback => { resolve = callback; }));
  const pending = player.retryNext();
  player.generation++;
  const originalStatus = player.status;
  resolve(new Response(JSON.stringify({ state: 'ready', episodes: rows, finished: true })));
  await pending;
  assert.equal(player.status, originalStatus);
});

await test('rolling window preserves absolute timeline and never re-aligns playback to zero', () => {
  const player = playingStub();
  const video = player.video;
  const session = player.session;
  player.video.currentTime = 65;
  player.loadPlaylist = () => assert.fail('window update must not reload source');
  const windowRows = [rows[1], { ...rows[2], duration: 30, ready: true }];
  player.acceptStatus({ state: 'ready', episodes: windowRows, finished: false });
  player.alignStart();
  assert.equal(player.video.currentTime, 65);
  assert.equal(player.current.id, 'e2');
  assert.equal(player.seek.value, '5');
  player.seekEpisode(12);
  assert.equal(player.video.currentTime, 72);
  assert.equal(player.video, video);
  assert.equal(player.session, session);
});

await test('metadata applies landscape/portrait ratio and resets unknown video to 16:9', () => {
  const player = playerStub();
  player.video.videoWidth = 1920;
  player.video.videoHeight = 1080;
  player.updateAspect();
  assert.equal(Number(player.root.style.values.get('--video-ratio')), 16 / 9);
  assert.equal(player.root.classList.values.get('portrait-video'), false);
  player.video.videoWidth = 1080;
  player.video.videoHeight = 1920;
  player.updateAspect();
  assert.equal(Number(player.root.style.values.get('--video-ratio')), 9 / 16);
  assert.equal(player.root.classList.values.get('portrait-video'), true);
  player.resetAspect();
  assert.equal(Number(player.root.style.values.get('--video-ratio')), 16 / 9);
  assert.equal(player.root.classList.values.get('portrait-video'), false);
  assert.equal(core.videoAspect(0, 0), 16 / 9);
  assert.equal(core.videoAspect(NaN, 960), 16 / 9);
});

await test('episode headings deduplicate generic number titles but preserve actual titles', () => {
  assert.equal(core.episodeLabel({ number: 859, title: '第859集' }), '第 859 集');
  assert.equal(core.episodeLabel({ number: 859, title: '第 859 集' }), '第 859 集');
  assert.equal(core.episodeLabel({ number: 859, title: '第859集：相逢' }), '第 859 集 · 相逢');
  assert.equal(core.episodeLabel({ number: 2, title: '新的故事' }), '第 2 集 · 新的故事');
});

await test('CSS uses metadata ratio/contain and compact mobile primary controls, not breakpoint framing', async () => {
  const css = await readFile(new URL('../public/app.css', import.meta.url), 'utf8');
  const playerSource = await readFile(new URL('../public/player.js', import.meta.url), 'utf8');
  const stageRules = [...css.matchAll(/\.video-stage\{([^}]+)\}/g)].map(match => match[1]);
  assert.ok(stageRules.length > 0);
  assert.ok(stageRules.some(rule => rule.includes('aspect-ratio:var(--video-ratio')));
  for (const rule of stageRules) {
    const ratio = /aspect-ratio:([^;]+)/.exec(rule)?.[1];
    if (ratio) assert.ok(ratio.startsWith('var(') || ratio === 'auto', `fixed stage ratio: ${ratio}`);
    assert.ok(!rule.includes('min-height:240px'));
  }
  assert.match(css, /\.video-stage video\{[^}]*object-fit:contain/);
  assert.match(css, /\.video-stage\{[^}]*max-height:max\(180px,min\(62dvh/);
  assert.match(css, /\.control-main\{display:grid;grid-template-columns:34px 42px 42px minmax\(0,1fr\) 60px 44px/);
  assert.match(css, /\.control-secondary\[data-pip="false"\]\{display:none\}/);
  assert.match(css, /\.control-secondary \.volume-slider,\.control-secondary \.icon-button\{display:none\}/);
  assert.match(playerSource, /'loadedmetadata', \(\) => \{ this\.updateAspect\(\)/);
  assert.match(playerSource, /'resize', \(\) => this\.updateAspect\(\)/);
  assert.match(playerSource, /class: 'control-main'[\s\S]*this\.speed, fullscreen\)/);
});

await test('detail route hides search and compacts header; returning restores search and cached list state', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/app.css', import.meta.url), 'utf8');
  const setViewSource = source.match(/function setView\(view\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(setViewSource, 'view transitions share the real header visibility function');
  const pages = [{ items: [{ id: 'cached-series' }], cursor: 'next', hasMore: true }];
  const state = { view: 'list', keyword: '原搜索词', pages, page: 2 };
  const searchForm = { hidden: false };
  const classes = new Map();
  const siteHeader = { classList: { toggle: (name, enabled) => classes.set(name, enabled) } };
  // Execute only the real view-transition function, not a hand-written substitute
  // or a claim of full DOM/browser coverage.
  const setView = runInNewContext(`${setViewSource}; setView`, { state, searchForm, siteHeader });
  setView('detail');
  assert.equal(searchForm.hidden, true);
  assert.equal(classes.get('detail-header'), true);
  setView('list');
  assert.equal(searchForm.hidden, false);
  assert.equal(classes.get('detail-header'), false);
  assert.equal(state.keyword, '原搜索词');
  assert.equal(state.pages, pages);
  assert.equal(state.page, 2);
  const detailRoute = source.match(/async function showDetail\([\s\S]*?\n\}/)?.[0];
  const listRoute = source.match(/async function loadList\([\s\S]*?\n\}/)?.[0];
  const router = source.match(/async function route\([\s\S]*?\n\}/)?.[0];
  assert.match(detailRoute, /setView\('detail'\)/);
  assert.match(listRoute, /setView\('list'\)/);
  assert.match(listRoute, /if \(cached\) \{ state\.loading = false; renderList\(\); return; \}/);
  assert.match(router, /setView\('list'\)[\s\S]*await loadList\(state\.keyword\)/);
  const brandHandler = source.match(/document\.querySelector\('\.brand'\)\.addEventListener[^\n]+/)?.[0];
  assert.ok(brandHandler);
  assert.ok(!brandHandler.includes('state.keyword =') && !brandHandler.includes('state.pages ='));
  assert.match(css, /@media\(max-width:640px\)\{\.site-header\.detail-header \.header-inner\{min-height:0;[^}]*flex-wrap:nowrap/);
});

// All top-level tests are awaited; restore only after the last one, rather than
// a root after-hook that can run while the next top-level test is registering.
for (const [key, descriptor] of originalGlobals) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else delete globalThis[key];
}
