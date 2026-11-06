/* Independent short-drama website, derived from the browsing/player concepts in
 * frostming/dsh-hongguo, commit a914be7599b99abf713ff7134511910396377f22.
 * https://github.com/frostming/dsh-hongguo
 * No DSH runtime, host state, or conversation integration. No upstream license asserted.
 */
import { el, request, poster, historyItems, removeHistory, timeLabel, episodeLabel } from './core.js';
import { DramaPlayer } from './player.js';

const main = document.getElementById('main');
const searchForm = document.getElementById('search-form');
const siteHeader = document.querySelector('.site-header');
const searchInput = document.getElementById('search-input');
const historyDialog = document.getElementById('history-dialog');
const PAGE_SIZE = 12;
const EPISODE_CHUNK = 50;
const state = { keyword: '', pages: [], page: 0, view: 'list', loading: false, series: null, episodes: [], chunk: 0, selected: null, listController: null, detailController: null, navigation: 0 };
let episodeGrid;
let chunkSelect;
let nowPlaying;
let detailPlay;
let toastTimer;

function setView(view) {
  state.view = view;
  searchForm.hidden = view !== 'list';
  siteHeader.classList.toggle('detail-header', view !== 'list');
}

function notify(text) {
  const node = document.getElementById('toast');
  clearTimeout(toastTimer);
  node.textContent = text; node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 4500);
}
function refreshHistoryCount() {
  const node = document.getElementById('history-count');
  const count = historyItems().length;
  node.textContent = String(count); node.hidden = count === 0;
}
const player = new DramaPlayer({
  onEpisode(episode) {
    state.selected = String(episode.id);
    if (nowPlaying) nowPlaying.textContent = `正在播放 · ${episodeLabel(episode)}`;
    const index = state.episodes.findIndex(item => String(item.id) === state.selected);
    if (index >= 0 && Math.floor(index / EPISODE_CHUNK) !== state.chunk) {
      state.chunk = Math.floor(index / EPISODE_CHUNK);
      if (chunkSelect) chunkSelect.value = String(state.chunk);
      renderEpisodes();
    } else {
      episodeGrid?.querySelectorAll('button[data-episode]').forEach(button => {
        const selected = button.dataset.episode === state.selected;
        button.classList.toggle('active', selected);
        if (selected) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
      });
    }
    if (detailPlay) detailPlay.hidden = true;
  },
  onManualEpisode(episode) { startEpisode(episode); },
  onHistory: refreshHistoryCount,
});

function navigateSeries(id, resume = false) {
  historyDialog.close();
  const params = new URLSearchParams({ series: String(id) });
  if (resume) params.set('resume', '1');
  const hash = `#${params}`;
  if (location.hash === hash) route(); else location.hash = hash;
}
function home() {
  if (!location.hash || location.hash === '#') route(); else location.hash = '';
}
function uniqueItems(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter(item => {
    if (!item || item.id == null || seen.has(String(item.id))) return false;
    seen.add(String(item.id)); return true;
  }).map(item => ({ ...item, id: String(item.id), title: String(item.title || '未命名短剧') }));
}
function empty(title, description, action, label = '重试') {
  return el('div', { class: 'empty-state' }, el('span', { class: 'empty-symbol', 'aria-hidden': 'true', text: '◌' }), el('h2', { text: title }), el('p', { text: description }), action && el('button', { type: 'button', class: 'button primary', onclick: action }, label));
}
function skeleton() {
  return el('div', { class: 'drama-grid', 'aria-label': '正在加载短剧', 'aria-busy': 'true' }, ...Array.from({ length: 12 }, () => el('div', { class: 'card-skeleton' }, el('div', { class: 'skeleton skeleton-poster' }), el('div', { class: 'skeleton skeleton-title' }), el('div', { class: 'skeleton skeleton-meta' }))));
}
function episodeCount(item) {
  const count = Number(item.episodes);
  return Number.isFinite(count) && count > 0 ? `${count} 集` : '查看分集';
}
function heatLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  return number >= 10000 ? `${(number / 10000).toFixed(1).replace(/\.0$/, '')}万热度` : `${number} 热度`;
}
function card(item, index) {
  const cover = poster(item);
  cover.append(el('span', { class: 'poster-count', text: episodeCount(item) }), el('span', { class: 'poster-play', 'aria-hidden': 'true', text: '▶' }));
  const record = historyItems().find(h => h.seriesId === item.id);
  return el('button', { type: 'button', class: 'drama-card', onclick: () => navigateSeries(item.id), 'aria-label': `${item.title}，${episodeCount(item)}，查看详情` },
    cover,
    el('div', { class: 'card-title' }, el('span', { class: 'card-rank', text: String(index + 1).padStart(2, '0') }), el('h3', { text: item.title })),
    el('p', { class: 'card-meta', text: record ? `上次看到第 ${record.number} 集 · ${timeLabel(record.position)}` : heatLabel(item.heat) || '短篇故事 · 即刻开看' }));
}
function hero(item) {
  return el('section', { class: 'hero', 'aria-label': '推荐短剧' },
    el('div', { class: 'hero-copy' }, el('p', { class: 'eyebrow', text: 'A LITTLE BREAK. A NEW STORY.' }),
      el('span', { class: 'hero-kicker', text: '今日放映' }), el('h1', { text: item.title }),
      el('p', { class: 'hero-description', text: item.description || '把片刻闲暇，留给一个好故事。选一集，随时入戏。' }),
      el('div', { class: 'hero-actions' }, el('button', { type: 'button', class: 'button primary', onclick: () => navigateSeries(item.id) }, '▶  进入放映室'), el('span', { class: 'muted small', text: `${episodeCount(item)} · 支持连续播放` }))),
    el('div', { class: 'hero-art' }, el('span', { class: 'hero-orbit', 'aria-hidden': 'true' }), poster(item, 'hero-poster'), el('span', { class: 'hero-caption', text: 'STORIES, ONE EPISODE AT A TIME' })));
}
function listHeading() {
  return el('div', { class: 'section-heading' },
    el('div', {}, el('p', { class: 'eyebrow', text: state.keyword ? 'SEARCH RESULTS' : 'DISCOVER YOUR NEXT STORY' }), el('h2', { text: state.keyword ? `“${state.keyword}”的搜索结果` : '发现好剧' })),
    el('button', { type: 'button', class: 'button subtle', onclick: () => loadList(state.keyword, true), disabled: state.loading }, state.keyword ? '重新搜索' : '↻ 刷新推荐'));
}
function renderList() {
  if (state.view !== 'list') return;
  const page = state.pages[state.page];
  main.replaceChildren();
  if (!state.keyword && page?.items[0]) main.append(hero(page.items[0]));
  main.append(listHeading());
  if (state.loading && !page) { main.append(skeleton()); return; }
  if (!page || !page.items.length) {
    main.append(empty(page?.hasMore ? '这一页暂无新结果' : state.keyword ? '暂时没有找到这部剧' : '暂时没有推荐内容', page?.hasMore ? '可以继续向后查找，或返回前一页。' : state.keyword ? '换个标题或更短的关键词试试。' : '可以刷新推荐，或直接搜索想看的标题。', page?.hasMore ? nextPage : state.keyword ? () => { searchInput.value = ''; loadList(''); } : () => loadList('', true), page?.hasMore ? '继续查找下一页' : state.keyword ? '返回推荐' : '刷新推荐'));
    if (state.page > 0) main.append(el('button', { type: 'button', class: 'button', disabled: state.loading, onclick: () => { state.page--; renderList(); } }, '← 上一页'));
    return;
  }
  const grid = el('div', { class: 'drama-grid', 'aria-busy': String(state.loading) }, ...page.items.map((item, index) => card(item, state.page * PAGE_SIZE + index)));
  const previous = el('button', { type: 'button', class: 'button', disabled: state.page === 0 || state.loading, onclick: () => { state.page--; renderList(); scrollToSection(); } }, '← 上一页');
  const next = el('button', { type: 'button', class: 'button', disabled: state.loading || (state.page >= state.pages.length - 1 && !page.hasMore), onclick: nextPage }, state.loading ? '加载中…' : '下一页 →');
  main.append(grid, el('nav', { class: 'pagination', 'aria-label': '短剧列表翻页' }, previous, el('span', { class: 'muted small', text: `第 ${state.page + 1} 页${!state.keyword ? ` / ${state.pages.length}` : ''}` }), next));
}
function scrollToSection() { main.querySelector('.section-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

async function loadList(keyword = '', force = false) {
  const query = keyword.trim();
  if (state.view !== 'list') {
    // Search is a navigation, never an overlay on a still-running player.
    state.navigation++; state.detailController?.abort(); player.stop();
  }
  setView('list');
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  state.listController?.abort();
  const controller = new AbortController(); state.listController = controller;
  const cached = !force && query === state.keyword && state.pages.length;
  state.keyword = query; searchInput.value = query;
  if (cached) { state.loading = false; renderList(); return; }
  state.pages = []; state.page = 0; state.loading = true; renderList();
  try {
    const data = await request(query ? `api/search?${new URLSearchParams({ q: query, cursor: '' })}` : 'api/feed', { signal: controller.signal });
    if (controller.signal.aborted || state.view !== 'list') return;
    const items = uniqueItems(data.items);
    if (query) {
      const cursor = data.nextCursor ?? data.cursor ?? '';
      state.pages = [{ items, cursor: String(cursor), hasMore: Boolean(data.hasMore && cursor !== '') }];
    } else {
      state.pages = Array.from({ length: Math.max(1, Math.ceil(items.length / PAGE_SIZE)) }, (_, index) => ({ items: items.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE), hasMore: false }));
    }
    state.loading = false; renderList();
  } catch (error) {
    if (controller.signal.aborted || state.view !== 'list') return;
    state.loading = false;
    main.replaceChildren(listHeading(), empty('内容加载失败', error.message, () => loadList(query, true)));
  }
}
async function nextPage() {
  if (state.loading) return;
  if (state.page < state.pages.length - 1) { state.page++; renderList(); scrollToSection(); return; }
  const current = state.pages[state.page];
  if (!current?.hasMore || !state.keyword) return;
  const controller = state.listController;
  state.loading = true; renderList();
  try {
    const data = await request(`api/search?${new URLSearchParams({ q: state.keyword, cursor: current.cursor })}`, { signal: controller.signal });
    if (controller.signal.aborted || state.view !== 'list') return;
    const seen = new Set(state.pages.flatMap(page => page.items.map(item => item.id)));
    const items = uniqueItems(data.items).filter(item => !seen.has(item.id));
    const cursor = String(data.nextCursor ?? data.cursor ?? '');
    const hasMore = Boolean(data.hasMore && cursor && cursor !== current.cursor);
    if (items.length || hasMore) {
      state.pages.push({ items, cursor, hasMore }); state.page++;
    } else { current.hasMore = false; notify('已到达当前搜索结果末尾'); }
    state.loading = false; renderList(); scrollToSection();
  } catch (error) {
    if (controller.signal.aborted || state.view !== 'list') return;
    state.loading = false; renderList();
    const warning = el('div', { class: 'inline-error', role: 'alert' }, el('span', { text: `下一页加载失败：${error.message}` }), el('button', { type: 'button', class: 'button subtle', onclick: nextPage }, '重试'));
    main.append(warning);
  }
}

async function showDetail(id, resume) {
  state.listController?.abort(); state.detailController?.abort(); player.stop();
  const generation = ++state.navigation;
  const controller = new AbortController(); state.detailController = controller;
  setView('detail'); state.series = null; state.episodes = []; state.selected = null;
  episodeGrid = null; nowPlaying = null; detailPlay = null; chunkSelect = null;
  main.replaceChildren(el('button', { class: 'button back-button', type: 'button', onclick: home }, '← 返回浏览'), el('div', { class: 'detail-skeleton', role: 'status', text: '正在加载剧集详情…' }));
  window.scrollTo({ top: 0, behavior: 'instant' });
  try {
    const data = await request(`api/series?${new URLSearchParams({ id })}`, { signal: controller.signal });
    if (generation !== state.navigation || controller.signal.aborted) return;
    if (!data.series?.id || !Array.isArray(data.episodes)) throw new Error('剧集详情数据不完整');
    state.series = { ...data.series, id: String(data.series.id) };
    state.episodes = data.episodes.filter(ep => ep && ep.id != null).map(ep => ({ ...ep, id: String(ep.id) }));
    const record = historyItems().find(item => item.seriesId === state.series.id);
    const lastIndex = record ? state.episodes.findIndex(item => item.id === record.episodeId) : -1;
    state.chunk = lastIndex >= 0 ? Math.floor(lastIndex / EPISODE_CHUNK) : 0;
    renderDetail(record);
    document.title = `${state.series.title} · 短剧放映室`;
    if (resume) {
      const episode = state.episodes[lastIndex >= 0 ? lastIndex : 0];
      if (episode) startEpisode(episode, lastIndex >= 0 ? record.position : 0);
    }
  } catch (error) {
    if (controller.signal.aborted || generation !== state.navigation) return;
    main.replaceChildren(el('button', { class: 'button back-button', type: 'button', onclick: home }, '← 返回浏览'), empty('剧集详情加载失败', error.message, () => showDetail(id, resume)));
  }
}
function renderDetail(record) {
  const series = state.series;
  // A freshly opened detail page is idle, never bound to the previously viewed series.
  player.series = series; player.episodes = state.episodes; player.current = null;
  player.failed = false; player.timeline = []; player.lastPosition = null;
  const resumeEpisode = record && state.episodes.find(ep => ep.id === record.episodeId);
  detailPlay = el('button', { type: 'button', class: 'button primary', disabled: !state.episodes.length, onclick: () => startEpisode(resumeEpisode || state.episodes[0], resumeEpisode ? record.position : 0) }, resumeEpisode ? `▶ 续播第 ${resumeEpisode.number} 集 · ${timeLabel(record.position)}` : '▶ 从第一集开始');
  const meta = el('section', { class: 'series-intro' }, poster(series, 'detail-poster'),
    el('div', { class: 'series-copy' }, el('p', { class: 'eyebrow', text: 'NOW SHOWING / 正在放映' }), el('h1', { text: series.title }),
      el('p', { class: 'series-meta', text: `共 ${state.episodes.length} 集` }),
      series.description && el('p', { class: 'series-description', text: series.description }), detailPlay));
  nowPlaying = el('h2', { class: 'now-playing', text: '播放' });
  const viewing = el('div', { class: 'viewing-column' }, el('div', { class: 'player-heading' }, nowPlaying), player.root);
  chunkSelect = el('select', { class: 'chunk-select', 'aria-label': '选择集数范围' }, ...Array.from({ length: Math.ceil(state.episodes.length / EPISODE_CHUNK) }, (_, index) => el('option', { value: index }, `第 ${index * EPISODE_CHUNK + 1}–${Math.min((index + 1) * EPISODE_CHUNK, state.episodes.length)} 集`)));
  chunkSelect.value = String(state.chunk);
  chunkSelect.addEventListener('change', () => { state.chunk = Number(chunkSelect.value); renderEpisodes(); });
  episodeGrid = el('div', { class: 'episode-grid' });
  const aside = el('aside', { class: 'episode-panel', 'aria-label': '选集' },
    el('div', { class: 'episode-header' }, el('h2', { text: '选集' }), el('span', { class: 'muted small', text: `共 ${state.episodes.length} 集` })),
    chunkSelect, episodeGrid,
    el('p', { class: 'episode-hint', text: '播放中会自动进入下一集；手动选集将重新准备该集。' }));
  main.replaceChildren(el('nav', { class: 'detail-navigation' }, el('button', { class: 'button back-button', type: 'button', onclick: home }, '← 返回浏览')), meta, el('div', { class: 'watch-layout' }, viewing, aside));
  renderEpisodes();
  player.showOverlay(true, '点击上方播放按钮，或选择分集开始观看');
  player.notice('播放记录仅保存在当前浏览器。首次播放与手动换集需要准备片段。');
}
function renderEpisodes() {
  if (!episodeGrid) return;
  if (!state.episodes.length) { episodeGrid.replaceChildren(el('p', { class: 'muted', text: '暂时没有可播放的分集' })); chunkSelect.disabled = true; return; }
  const episodes = state.episodes.slice(state.chunk * EPISODE_CHUNK, (state.chunk + 1) * EPISODE_CHUNK);
  episodeGrid.replaceChildren(...episodes.map(episode => el('button', {
    type: 'button', class: `episode-button${state.selected === episode.id ? ' active' : ''}`,
    'data-episode': episode.id, 'aria-current': state.selected === episode.id ? 'true' : null,
    'aria-label': `播放${episodeLabel(episode)}`, title: episodeLabel(episode),
    onclick: () => startEpisode(episode),
  }, episode.number)));
}
function startEpisode(episode, resumeAt = 0) {
  if (!episode || !state.series) return;
  player.begin(state.series, state.episodes, episode, resumeAt);
}
function showHistory() {
  const list = document.getElementById('history-list');
  const items = historyItems();
  if (!items.length) list.replaceChildren(empty('还没有观看记录', '开始看一部短剧，下次就能从这里继续。'));
  else list.replaceChildren(...items.map(record => {
    const resume = el('button', { type: 'button', class: 'history-resume', onclick: () => navigateSeries(record.seriesId, true) },
      poster(record, 'history-poster'), el('div', { class: 'history-copy' }, el('h3', { text: record.title }),
        el('p', { class: 'muted small', text: `第 ${record.number} 集 · ${timeLabel(record.position)}${record.duration > 0 ? ` / ${timeLabel(record.duration)}` : ''}` }),
        el('span', { class: 'history-continue', text: '继续观看 →' })));
    return el('div', { class: 'history-row' }, resume, el('button', { type: 'button', class: 'icon-button history-remove', 'aria-label': `移除${record.title}的观看记录`, title: '移除记录', onclick: () => {
      if (!removeHistory(record.seriesId)) { notify('浏览器未允许修改本地观看记录'); return; }
      refreshHistoryCount(); showHistory();
    } }, '×'));
  }));
  if (!historyDialog.open) historyDialog.showModal();
}
async function route() {
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get('series');
  if (id) await showDetail(id, params.get('resume') === '1');
  else {
    state.navigation++; state.detailController?.abort();
    if (state.view !== 'list') player.stop();
    setView('list'); document.title = '短剧放映室 · Drama';
    await loadList(state.keyword);
  }
}
searchForm.addEventListener('submit', event => { event.preventDefault(); loadList(searchInput.value); });
searchInput.addEventListener('search', () => { if (!searchInput.value) loadList(''); });
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); home(); });
document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); main.focus(); });
document.getElementById('history-button').addEventListener('click', showHistory);
document.getElementById('close-history').addEventListener('click', () => historyDialog.close());
historyDialog.addEventListener('click', event => { if (event.target === historyDialog) { const rect = historyDialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) historyDialog.close(); } });
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => player.stop());
window.addEventListener('pageshow', event => {
  if (event.persisted && state.view === 'detail' && player.series?.id === state.series?.id && player.current) {
    player.failed = true;
    player.showOverlay(true, '页面已恢复，点击重新准备播放', true);
  }
});
window.addEventListener('storage', refreshHistoryCount);
refreshHistoryCount();
route();
