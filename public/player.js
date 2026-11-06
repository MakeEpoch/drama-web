/* Continuous rolling HLS player. One video and one Hls engine per session.
 * Browsing/history controls adapted from frostming/dsh-hongguo a914be7.
 * https://github.com/frostming/dsh-hongguo — no upstream license is asserted.
 */
import { el, request, localURL, readStored, writeStored, PREF_KEY, timeLabel, relativeProgress, storeProgress, videoAspect } from './core.js';

export class DramaPlayer {
  constructor({ onEpisode, onManualEpisode, onHistory } = {}) {
    this.onEpisode = onEpisode;
    this.onManualEpisode = onManualEpisode;
    this.onHistory = onHistory;
    this.generation = 0;
    this.timeline = [];
    this.episodes = [];
    this.session = null;
    this.engine = null;
    this.loaded = false;
    this.failed = false;
    this.pollTimer = null;
    this.progressTimer = null;
    this.controller = null;
    this.video = el('video', { playsinline: true, preload: 'auto', 'aria-label': '短剧播放器', tabindex: '0' });
    const prefs = readStored(PREF_KEY, {});
    this.video.volume = Number.isFinite(prefs.volume) ? Math.max(0, Math.min(1, prefs.volume)) : 0.8;
    this.video.defaultPlaybackRate = [0.5, 0.75, 1, 1.25, 1.5, 2].includes(prefs.speed) ? prefs.speed : 1;
    this.video.playbackRate = this.video.defaultPlaybackRate;
    this.message = el('p', { class: 'stage-message', role: 'status', text: '选择一集开始观看' });
    this.action = el('button', { class: 'button primary', hidden: true, type: 'button', onclick: () => this.failed ? this.retry() : this.play() }, '播放');
    this.overlay = el('div', { class: 'stage-overlay' }, this.message, this.action);
    this.stage = el('div', { class: 'video-stage' }, this.video, this.overlay);
    this.playButton = el('button', { type: 'button', class: 'icon-button', 'aria-label': '播放', onclick: () => this.toggle() }, '▶');
    this.previous = el('button', { type: 'button', class: 'button subtle', disabled: true, onclick: () => this.manual(-1) }, '上一集');
    this.next = el('button', { type: 'button', class: 'button subtle', disabled: true, onclick: () => this.manual(1) }, '下一集');
    this.clock = el('span', { class: 'play-clock', text: '0:00 / 0:00' });
    this.seek = el('input', { class: 'seek', type: 'range', min: '0', max: '1', value: '0', step: '0.1', disabled: true, 'aria-label': '当前集播放进度' });
    this.seek.addEventListener('input', () => { this.scrubbing = true; this.clock.textContent = `${timeLabel(this.seek.value)} / ${timeLabel(this.seek.max)}`; });
    this.seek.addEventListener('change', () => { this.seekEpisode(Number(this.seek.value)); this.scrubbing = false; });
    this.seek.addEventListener('blur', () => { this.scrubbing = false; });
    this.mute = el('button', { class: 'icon-button', type: 'button', 'aria-label': '静音', onclick: () => { this.video.muted = !this.video.muted; } }, '♪');
    this.volume = el('input', { class: 'volume-slider', type: 'range', min: '0', max: '1', step: '0.05', value: this.video.volume, 'aria-label': '音量' });
    this.volume.addEventListener('input', () => { this.video.volume = Number(this.volume.value); this.video.muted = this.video.volume === 0; });
    this.speed = el('select', { class: 'speed-select', 'aria-label': '播放速度' }, ...[0.5, 0.75, 1, 1.25, 1.5, 2].map(n => el('option', { value: n }, `${n}×`)));
    this.speed.value = String(this.video.playbackRate);
    this.speed.addEventListener('change', () => { this.video.defaultPlaybackRate = Number(this.speed.value); this.video.playbackRate = Number(this.speed.value); this.preferences(); });
    this.pip = el('button', { class: 'button subtle pip-button', type: 'button', onclick: () => this.togglePip(), title: '画中画' }, '画中画');
    this.pip.hidden = !document.pictureInPictureEnabled || typeof this.video.requestPictureInPicture !== 'function';
    const fullscreen = el('button', { class: 'button subtle fullscreen-button', type: 'button', onclick: () => this.fullscreen() }, '全屏');
    this.note = el('div', { class: 'player-note', role: 'status', text: '按需准备下一集，播放过程中自动衔接' });
    this.nextMessage = el('span', { class: 'next-warning-message', role: 'status' });
    this.retryNextButton = el('button', { class: 'button', type: 'button', onclick: () => this.retryNext() }, '重试下一集');
    this.nextWarning = el('div', { class: 'next-warning', hidden: true }, this.nextMessage, this.retryNextButton);
    const mainControls = el('div', { class: 'control-main' }, this.playButton, this.previous, this.next,
      el('div', { class: 'control-spacer' }), this.speed, fullscreen);
    const secondaryControls = el('div', { class: 'control-secondary', 'data-pip': String(!this.pip.hidden) }, this.mute, this.volume, this.pip);
    const controls = el('div', { class: 'player-controls' },
      el('div', { class: 'seek-row' }, this.seek, this.clock),
      el('div', { class: 'control-row' }, mainControls, secondaryControls));
    this.root = el('section', { class: 'player', 'aria-label': '视频播放区域' }, this.stage, controls, this.note, this.nextWarning);
    this.video.addEventListener('timeupdate', () => this.updatePosition());
    this.video.addEventListener('playing', () => {
      if (this.failed) { this.video.pause(); return; }
      if (this.initialTarget != null) this.alignStart();
      this.showOverlay(false); this.playButton.textContent = 'Ⅱ'; this.playButton.setAttribute('aria-label', '暂停');
    });
    this.video.addEventListener('pause', () => { this.playButton.textContent = '▶'; this.playButton.setAttribute('aria-label', '播放'); this.save(); this.reportProgress(); });
    this.video.addEventListener('waiting', () => { if (!this.failed && this.loaded) this.showOverlay(true, '正在缓冲，下一集可能仍在准备…'); });
    this.video.addEventListener('canplay', () => { if (this.initialTarget != null) this.alignStart(); if (!this.failed) this.showOverlay(false); });
    this.video.addEventListener('loadedmetadata', () => { this.updateAspect(); this.alignStart(); this.play(); });
    this.video.addEventListener('resize', () => this.updateAspect());
    this.video.addEventListener('seeked', () => {
      if (this.initialTarget != null && Math.abs(this.video.currentTime - this.initialTarget) < 1.5) this.initialTarget = null;
      this.updatePosition(); this.save(); this.reportProgress();
    });
    this.video.addEventListener('volumechange', () => { this.volume.value = String(this.video.muted ? 0 : this.video.volume); this.mute.textContent = this.video.muted ? '静音' : '♪'; this.mute.setAttribute('aria-label', this.video.muted ? '取消静音' : '静音'); this.preferences(); });
    this.video.addEventListener('ended', () => {
      this.save(); this.reportProgress();
      if (this.status?.finished) this.showOverlay(true, '已播放完当前剧集');
      else if (!this.failed) this.showOverlay(true, '正在等待后续片段…');
    });
    this.video.addEventListener('error', () => { if (this.loaded && !this.failed) this.fail('视频无法播放，请重试。'); });
    this.video.addEventListener('keydown', event => {
      if (event.key === ' ' || event.key === 'k') { event.preventDefault(); this.toggle(); }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const p = this.position(); if (p) this.seekEpisode(p.position + (event.key === 'ArrowLeft' ? -5 : 5)); }
    });
  }

  resetAspect() {
    this.root.style.setProperty('--video-ratio', String(videoAspect(0, 0)));
    this.root.classList.toggle('portrait-video', false);
  }
  updateAspect() {
    const ratio = videoAspect(this.video.videoWidth, this.video.videoHeight);
    this.root.style.setProperty('--video-ratio', String(ratio));
    this.root.classList.toggle('portrait-video', ratio < 1);
  }
  preferences() { writeStored(PREF_KEY, { volume: this.video.volume, speed: this.video.playbackRate }); }
  showOverlay(visible, text, actionable = false) {
    this.overlay.hidden = !visible;
    if (text) this.message.textContent = text;
    this.action.hidden = !actionable;
    this.action.textContent = this.failed ? '重试播放' : '点击播放';
  }
  notice(text) { if (this.note.textContent !== text) this.note.textContent = text; }
  updateNextWarning() {
    const problem = this.status?.nextError;
    this.nextWarning.hidden = !problem;
    if (!problem) { this.nextRetryError = ''; return; }
    const episode = this.episodes.find(item => String(item.id) === String(problem.episodeId));
    const label = episode ? `第 ${episode.number} 集` : '下一集';
    const message = `${label}预热失败：${problem.message || '暂时无法准备片段'}。当前集可以继续观看。${this.nextRetryError ? ` 重试未成功：${this.nextRetryError}` : ''}`;
    if (this.nextMessage.textContent !== message) this.nextMessage.textContent = message;
    this.retryNextButton.disabled = Boolean(this.nextRetryBusy || this.failed || !this.session);
    this.retryNextButton.textContent = this.nextRetryBusy ? '正在重试…' : '重试下一集';
  }
  async retryNext() {
    if (!this.session || !this.status?.nextError || this.failed || this.nextRetryBusy) return;
    const generation = this.generation;
    this.nextRetryBusy = true; this.nextRetryError = ''; this.updateNextWarning();
    try {
      let status = await request(`api/playback/${encodeURIComponent(this.session.id)}/retry-next`, { method: 'POST', body: {}, signal: this.controller.signal });
      if (generation !== this.generation) return;
      if (!Array.isArray(status?.episodes)) status = await request(this.session.statusUrl, { signal: this.controller.signal });
      if (generation === this.generation) this.acceptStatus(status);
    } catch (error) {
      if (generation === this.generation && error.name !== 'AbortError') this.nextRetryError = error.message;
    } finally {
      if (generation === this.generation) { this.nextRetryBusy = false; this.updateNextWarning(); }
    }
  }
  position() { return relativeProgress(this.timeline, this.video.currentTime); }
  save() {
    if (!this.loaded || this.initialTarget != null) return;
    const p = this.position();
    if (p) {
      const saved = storeProgress(this.series, p.episode, p.position, p.duration);
      if (!saved && !this.storageWarning) { this.storageWarning = true; this.notice('浏览器未允许保存记录，本次观看进度可能无法保留。'); }
      this.onHistory?.();
    }
  }
  episodeComplete(episode) {
    const index = this.timeline.findIndex(item => item.id === episode.id);
    return Boolean(this.status?.finished || this.timeline.slice(index + 1).some(item => item.ready));
  }
  updatePosition() {
    if (!this.loaded) return;
    const p = this.position();
    if (!p) return;
    if (!this.scrubbing) {
      const complete = this.episodeComplete(p.episode);
      this.seek.disabled = false;
      this.seek.max = String(p.duration);
      this.seek.value = String(p.position);
      this.seek.setAttribute('aria-valuetext', `${timeLabel(p.position)}，${complete ? '共' : '已准备'} ${timeLabel(p.duration)}`);
      this.clock.textContent = `${timeLabel(p.position)} / ${timeLabel(p.duration)}${complete ? '' : '+'}`;
      this.clock.title = complete ? '本集播放时间 / 总时长' : '本集播放时间 / 已准备时长，仍在增长；可拖动到已准备的片段';
    }
    if (String(this.current?.id) !== String(p.episode.id)) {
      this.current = p.episode;
      this.onEpisode?.(p.episode);
      this.updateNavigation();
    }
    if (Date.now() - (this.lastSaved || 0) >= 5000) { this.lastSaved = Date.now(); this.save(); }
  }
  updateNavigation() {
    const index = this.episodes.findIndex(item => String(item.id) === String(this.current?.id));
    this.previous.disabled = index <= 0;
    this.next.disabled = index < 0 || index >= this.episodes.length - 1;
  }
  manual(delta) {
    const index = this.episodes.findIndex(item => String(item.id) === String(this.current?.id));
    const episode = this.episodes[index + delta];
    if (episode) this.onManualEpisode?.(episode);
  }
  seekEpisode(value) {
    const p = this.position();
    if (!p || this.failed) return;
    this.initialTarget = null;
    this.video.currentTime = p.episode.start + Math.max(0, Math.min(p.duration - 0.05, value));
    this.reportProgress();
  }
  alignStart() {
    if (this.initialTarget == null || this.video.seeking) return;
    try {
      if (Math.abs(this.video.currentTime - this.initialTarget) < 0.2 && this.video.readyState >= 2) {
        this.initialTarget = null;
        this.reportProgress();
      } else this.video.currentTime = this.initialTarget;
      // Keep the guard until the requested beginning is actually seekable.
    } catch { /* Metadata/seekable ranges may not be available yet; retry on canplay. */ }
  }
  async play() {
    if (!this.loaded || this.failed) return;
    try { await this.video.play(); }
    catch (error) { if (error.name !== 'AbortError') this.showOverlay(true, '视频已准备好，点击开始播放', true); }
  }
  toggle() { if (this.failed) this.retry(); else if (this.video.paused) this.play(); else this.video.pause(); }
  async fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (this.root.requestFullscreen) await this.root.requestFullscreen();
      else if (this.video.webkitEnterFullscreen) this.video.webkitEnterFullscreen();
      else this.notice('当前浏览器不支持全屏。');
    } catch { this.notice('无法进入全屏，请检查浏览器权限。'); }
  }
  async togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch { this.notice('画中画暂不可用，请先播放视频或检查浏览器权限。'); }
  }

  async begin(series, episodes, episode, resumeAt = 0) {
    this.stop();
    const generation = this.generation;
    this.series = series; this.episodes = episodes; this.current = episode;
    this.resumeAt = Math.max(0, Number(resumeAt) || 0);
    this.failed = false; this.pollFailures = 0; this.loaded = false; this.lastSaved = 0;
    this.nextRetryBusy = false; this.nextRetryError = '';
    this.resetAspect();
    this.timeline = []; this.initialTarget = null; this.status = null; this.lastPosition = null;
    this.controller = new AbortController();
    this.seek.disabled = true; this.seek.value = '0'; this.clock.textContent = '0:00 / 0:00';
    this.video.poster = '';
    try { if (series.cover) this.video.poster = localURL(series.cover).href; } catch { /* Optional poster. */ }
    this.updateNavigation(); this.onEpisode?.(episode);
    this.showOverlay(true, `正在准备第 ${episode.number} 集…`);
    this.notice('首次播放需要准备片段；就绪后从本集开头或保存的位置播放。');
    try {
      // Do not abort creation: if navigation races the response, delete the returned session.
      const session = await request('api/playback', { method: 'POST', body: { seriesId: String(series.id), episodeId: String(episode.id) } });
      if (generation !== this.generation) { if (session.id) this.release(session.id); return; }
      if (session.id) this.session = session;
      if (!session.id || !session.statusUrl || !session.playlistUrl) throw new Error('播放会话数据不完整');
      localURL(session.statusUrl); localURL(session.playlistUrl);
      this.poll(generation);
      this.progressTimer = setInterval(() => { if (!this.video.paused) this.reportProgress(); }, 5000);
    } catch (error) { if (generation === this.generation) this.fail(error.message); }
  }

  async poll(generation) {
    if (!this.session || this.failed || generation !== this.generation) return;
    try {
      const status = await request(this.session.statusUrl, { signal: this.controller.signal });
      if (generation !== this.generation) return;
      this.pollFailures = 0;
      this.acceptStatus(status);
    } catch (error) {
      if (generation !== this.generation || error.name === 'AbortError') return;
      this.pollFailures++;
      this.notice(`更新播放状态失败（${this.pollFailures}/3）：${error.message}`);
      if (this.pollFailures >= 3) { this.fail(error.message); return; }
    }
    // finished means encoding is complete, not that the user has finished watching.
    // Status GET also keeps paused/ended sessions alive until stop/pagehide releases them.
    if (generation === this.generation && this.session && !this.failed) {
      this.pollTimer = setTimeout(() => this.poll(generation), this.loaded && this.video.paused ? 6000 : 2000);
    }
  }

  acceptStatus(status) {
    if (!status || !Array.isArray(status.episodes)) return;
    this.status = status;
    this.updateNextWarning();
    this.timeline = status.episodes.map(item => ({ ...item, id: String(item.id), start: Number(item.start), duration: Number(item.duration) }));
    if (status.state === 'error') { this.fail(typeof status.error === 'string' ? status.error : status.error?.message || '视频准备失败，请重试'); return; }
    if (!this.loaded && ['ready', 'ended'].includes(status.state) && this.timeline.some(item => item.ready && item.duration > 0)) {
      const first = this.timeline.find(item => item.ready && item.duration > 0);
      // duration is the prepared segment duration, not necessarily the full episode.
      // Never silently clamp a saved 90-second resume point to an initial 4-second buffer.
      if (this.resumeAt > 0 && first.duration < this.resumeAt + 0.5 && !this.episodeComplete(first)) {
        this.showOverlay(true, `正在准备续播位置 ${timeLabel(this.resumeAt)} · 已准备 ${timeLabel(first.duration)}`);
        this.notice('续播位置尚未准备完成，请稍候。不会提前从缓冲区末尾播放。');
        return;
      }
      this.initialTarget = first.start + Math.min(this.resumeAt, Math.max(0, first.duration - 0.25));
      this.loadPlaylist(status.playlistUrl || this.session.playlistUrl);
    }
    if (!this.failed) {
      const pending = this.timeline.find(item => !item.ready);
      this.notice(status.finished ? '所有分集已准备完成 · 自动连续播放' : pending ? `第 ${pending.number} 集正在准备 · 不会为自动换集重建播放器` : '按播放进度准备下一集 · 自动连续播放');
    }
    this.updatePosition();
  }

  loadPlaylist(path) {
    if (this.loaded || this.failed) return;
    let source;
    try { source = localURL(path).href; } catch (error) { this.fail(error.message); return; }
    this.loaded = true;
    const generation = this.generation;
    const Hls = window.Hls;
    if (Hls?.isSupported()) {
      // Rolling playlists are live but this is sequential episode playback, not live TV.
      // A large target latency clamps sync to the current window START, never its edge.
      // Infinite max latency and rate=1 prevent normal playback being pulled forward.
      // Initial alignment is cleared after startup; moving windows never re-seek to zero.
      this.engine = new Hls({ startPosition: 0, autoStartLoad: false, lowLatencyMode: false, liveSyncDurationCount: 1000000, liveMaxLatencyDurationCount: Infinity, maxLiveSyncPlaybackRate: 1, backBufferLength: 120, maxBufferLength: 30 });
      const engine = this.engine;
      engine.on(Hls.Events.MEDIA_ATTACHED, () => { if (generation === this.generation) engine.loadSource(source); });
      engine.on(Hls.Events.MANIFEST_PARSED, () => {
        if (generation !== this.generation) return;
        engine.startLoad(this.initialTarget ?? 0);
        this.play();
      });
      engine.on(Hls.Events.ERROR, (_event, data) => {
        if (generation !== this.generation || this.failed || !data.fatal) return;
        this.fail(data.type === Hls.ErrorTypes.NETWORK_ERROR ? '视频片段加载失败，请检查连接后重试。' : '视频解码失败，请重试或更换浏览器。');
      });
      engine.attachMedia(this.video);
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      // A media-fragment start plus metadata/canplay alignment prevents native live-edge startup.
      const nativeSource = new URL(source);
      nativeSource.hash = `t=${this.initialTarget ?? 0}`;
      this.video.src = nativeSource.href;
      this.video.load();
    } else {
      this.fail(Hls ? '当前浏览器不支持 HLS 播放，请使用新版 Chrome、Edge 或 Safari。' : '播放器依赖未加载，请刷新页面后重试。');
    }
  }

  async reportProgress() {
    if (!this.session || !this.loaded || this.failed || this.progressBusy || this.initialTarget != null) return;
    this.progressBusy = true;
    const generation = this.generation;
    try {
      const status = await request(`api/playback/${encodeURIComponent(this.session.id)}/progress`, { method: 'POST', body: { time: Math.max(0, this.video.currentTime || 0) }, signal: this.controller.signal });
      if (generation === this.generation && Array.isArray(status?.episodes)) this.acceptStatus(status);
    } catch (error) {
      if (generation === this.generation && error.name !== 'AbortError') this.notice(`播放进度暂未同步，下一集预热可能延迟：${error.message}`);
    } finally { if (generation === this.generation) this.progressBusy = false; }
  }
  fail(message) {
    this.save(); this.failed = true;
    this.updateNextWarning();
    clearTimeout(this.pollTimer); clearInterval(this.progressTimer);
    this.video.pause(); this.engine?.stopLoad();
    this.showOverlay(true, message || '播放失败，请重试。', true);
    this.notice('播放已暂停。重试会释放旧会话，并从当前集已保存的位置重新准备。');
  }
  retry() {
    if (!this.series || !this.current) return;
    const p = (this.loaded && this.initialTarget == null ? this.position() : null) || this.lastPosition;
    this.begin(this.series, this.episodes, p?.episode || this.current, p?.position ?? this.resumeAt);
  }
  release(id) {
    request(`api/playback/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true }).catch(() => { /* Server TTL is the fallback if the browser is offline. */ });
  }
  stop() {
    if (this.loaded && this.initialTarget == null) this.lastPosition = this.position();
    this.save(); this.generation++;
    clearTimeout(this.pollTimer); clearInterval(this.progressTimer);
    this.controller?.abort(); this.controller = null;
    this.progressBusy = false; this.loaded = false; this.initialTarget = null;
    this.status = null; this.nextRetryBusy = false; this.nextRetryError = ''; this.updateNextWarning();
    this.previous.disabled = true; this.next.disabled = true; this.seek.disabled = true;
    this.engine?.destroy(); this.engine = null;
    this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    if (this.session?.id) this.release(this.session.id);
    this.session = null;
  }
}
