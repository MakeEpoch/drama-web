/* Standalone adaptation of frostming/dsh-hongguo (a914be7).
 * Upstream: https://github.com/frostming/dsh-hongguo
 * Content belongs to its respective rights holders. No upstream license is asserted.
 */
export const BASE = new URL('./', location.href);
export const HISTORY_KEY = `drama-web.history.v1:${BASE.pathname}`;
export const PREF_KEY = `drama-web.preferences.v1:${BASE.pathname}`;

export function localURL(path) {
  const url = new URL(path, BASE);
  if (url.origin !== location.origin || !url.pathname.startsWith(BASE.pathname)) {
    throw new Error('服务器返回了非本站资源地址');
  }
  return url;
}

export async function request(path, { method = 'GET', body, signal, keepalive = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时，请重试', 'TimeoutError')), 20000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetch(localURL(path), {
      method, signal: combined, keepalive, credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) throw new Error(data?.error?.message || `请求失败（${response.status}）`);
    if (!data) throw new Error('服务器返回了无效数据');
    return data;
  } finally { clearTimeout(timer); }
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function timeLabel(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const secondsText = String(value % 60).padStart(2, '0');
  const minutes = Math.floor(value / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${secondsText}` : `${minutes}:${secondsText}`;
}

export function videoAspect(width, height) {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : 16 / 9;
}

export function episodeLabel(episode) {
  const number = String(episode?.number ?? '');
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const title = String(episode?.title || '').trim().replace(new RegExp(`^第\\s*${escaped}\\s*集\\s*[·:：-]?\\s*`), '').trim();
  return `第 ${number} 集${title ? ` · ${title}` : ''}`;
}

export function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
export function writeStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
export function historyItems() {
  const data = readStored(HISTORY_KEY, []);
  return (Array.isArray(data) ? data : []).filter(item => item && typeof item.seriesId === 'string' && typeof item.episodeId === 'string')
    .sort((a, b) => b.at - a.at).slice(0, 30);
}
export function storeProgress(series, episode, position, duration) {
  if (!series?.id || !episode?.id) return false;
  const record = {
    seriesId: String(series.id), title: String(series.title || '未命名短剧'), cover: series.cover || '',
    episodeId: String(episode.id), number: episode.number, position: Math.max(0, Number(position) || 0),
    duration: Math.max(0, Number(duration) || 0), at: Date.now(),
  };
  return writeStored(HISTORY_KEY, [record, ...historyItems().filter(item => item.seriesId !== record.seriesId)].slice(0, 30));
}
export function removeHistory(id) { return writeStored(HISTORY_KEY, historyItems().filter(item => item.seriesId !== id)); }

export function episodeAt(timeline, time) {
  const t = Math.max(0, Number(time) || 0);
  return [...timeline].reverse().find(item => item.ready && Number.isFinite(item.start) && item.start <= t && item.duration > 0) || null;
}
export function relativeProgress(timeline, time) {
  const episode = episodeAt(timeline, time);
  if (!episode) return null;
  return { episode, position: Math.min(episode.duration, Math.max(0, time - episode.start)), duration: episode.duration };
}

export function poster(item, className = '') {
  const frame = el('div', { class: `poster ${className}`, 'aria-hidden': 'true' }, el('span', { class: 'poster-fallback', text: '剧' }));
  if (item?.cover) {
    try {
      const img = el('img', { src: localURL(item.cover).href, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'same-origin' });
      img.addEventListener('error', () => img.remove(), { once: true });
      frame.append(img);
    } catch { /* An invalid cover is a placeholder, never an external request. */ }
  }
  return frame;
}
