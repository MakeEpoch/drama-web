// Best-effort HTTP-cache warming of ONE ready next-file prefix, never a Blob or
// second playing video. Safari may not reuse a fetch's partial cache for <video>.
export class NextMedia {
  constructor({ changed = () => {}, fetcher = (...args) => fetch(...args), limit = 1024 * 1024 } = {}) {
    Object.assign(this, { changed, fetcher, limit }); this.epoch = 0;
  }
  reset() {
    this.epoch++; this.controller?.abort(); clearTimeout(this.timer);
    this.controller = null; this.timer = null; this.inflight = false;
    this.row = null; this.done = false; this.error = null; this.retries = 0; this.enabled = false;
    this.changed(null);
  }
  update(row, enabled) {
    if (row?.id !== this.row?.id || row?.mediaUrl !== this.row?.mediaUrl) { this.reset(); this.row = row || null; }
    this.enabled = Boolean(enabled && this.row);
    if (!this.enabled) {
      this.controller?.abort(); clearTimeout(this.timer); this.timer = null;
      return;
    }
    if (!this.done && !this.inflight && !this.timer && !this.error) void this.run();
  }
  retry() {
    if (!this.row) return;
    const row = this.row, enabled = this.enabled;
    this.reset(); this.row = row; this.enabled = enabled;
    if (enabled) void this.run();
  }
  async run() {
    const epoch = this.epoch, row = this.row;
    if (!row || !this.enabled) return;
    const controller = new AbortController(); this.controller = controller; this.inflight = true;
    let retryDelay, timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 8000);
    try {
      const response = await this.fetcher(row.mediaUrl, { headers: { Range: `bytes=0-${this.limit - 1}` }, credentials: 'same-origin', cache: 'default', priority: 'low', signal: controller.signal });
      if (response.status !== 206) {
        await response.body?.cancel();
        throw Object.assign(new Error('下一集预加载请求失败'), { retryable: response.status === 408 || response.status === 429 || response.status >= 500 });
      }
      const length = Number(response.headers.get('content-length'));
      if (length > this.limit) { await response.body?.cancel(); throw Object.assign(new Error('预加载响应超过大小限制'), { retryable: false }); }
      const reader = response.body.getReader();
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.limit) throw Object.assign(new Error('预加载响应超过大小限制'), { retryable: false });
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (!size) throw new Error('下一集返回空内容');
      if (epoch === this.epoch && !controller.signal.aborted) { this.done = true; this.error = null; this.changed(null); }
    } catch (error) {
      if (epoch !== this.epoch || controller.signal.aborted && !timedOut) return;
      if (error.retryable !== false && this.retries < 3) retryDelay = [1000, 2000, 4000][this.retries++];
      else {
        this.error = { episodeId: row.id, kind: 'preload', code: 'NEXT_PRELOAD_FAILED', message: '下一集预加载失败，可点重试；当前视频不受影响。' };
        this.changed(this.error);
      }
    } finally {
      clearTimeout(timeout);
      if (epoch === this.epoch) {
        this.controller = null; this.inflight = false;
        if (retryDelay && this.enabled) this.timer = setTimeout(() => { this.timer = null; void this.run(); }, retryDelay);
        if (controller.signal.aborted && !timedOut && !retryDelay && this.enabled && !this.done && !this.error) queueMicrotask(() => { if (epoch === this.epoch && this.enabled && !this.inflight) void this.run(); });
        // Cancellation for current-playback priority is not a failed attempt.
      }
    }
  }
}
