import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { encodeEpisode, prepareFile, directorySize, seriesProfile } from './media.js'
import { fail, publicError, safeId } from './errors.js'

const MiB = 1024 ** 2
const sum = job => job.duration ?? job.segments.reduce((total, segment) => total + segment.duration, 0)
const playableJob = job => job.fileReady || job.segments.length > 0
export class PlaybackManager {
  constructor({ upstream, dataDir, base = '', concurrency = 2, maxSessions = 6,
    maxBytes = 2048 * MiB, jobBudget = 256 * MiB, idleMs = 120_000,
    cacheAgeMs = 3_600_000, mode = 'hls', encode = mode === 'file' ? prepareFile : encodeEpisode, encoding = {} }) {
    Object.assign(this, { upstream, base, concurrency, maxSessions, maxBytes, jobBudget, idleMs, cacheAgeMs, mode, encode, encoding })
    this.root = join(resolve(dataDir), 'hls-v1')
    this.sessions = new Map()
    this.seriesProfiles = new Map()
    this.jobs = new Map()
    this.queue = []
    this.running = 0
    this.closed = false
    this.maintenance = Promise.resolve()
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (/^[a-f0-9]{64}$/.test(entry.name) && entry.isDirectory()) {
        const target = resolve(this.root, entry.name)
        if (target.startsWith(this.root + '/')) await rm(target, { recursive: true, force: true })
      }
    }
    this.timer = setInterval(() => this.cleanup().catch(() => {}), 30_000)
    this.timer.unref()
  }
  url(id) { return `${this.base}/api/playback/${id}/index.m3u8` }
  get(id, touch = true) {
    safeId(id)
    const session = this.sessions.get(id)
    if (!session) throw fail('PLAYBACK_NOT_FOUND', '播放会话已过期，请重新选集', 404)
    if (touch) session.usedAt = Date.now()
    return session
  }
  async create(seriesId, episodeId) {
    safeId(seriesId); safeId(episodeId)
    if (this.closed || this.sessions.size >= this.maxSessions) throw fail('PLAYBACK_BUSY', '播放会话已满，请关闭其他播放器', 503)
    const detail = await this.upstream.series(seriesId)
    const index = detail.episodes.findIndex(episode => episode.id === episodeId)
    if (index < 0) throw fail('EPISODE_NOT_FOUND', '该分集不属于当前短剧', 404)
    if (this.sessions.size >= this.maxSessions || this.closed) throw fail('PLAYBACK_BUSY', '播放会话已满', 503)
    let profile = this.seriesProfiles.get(seriesId)
    if (!profile || profile.state === 'failed') {
      profile = this.mode === 'file' ? { id: 'file-v1', owner: null, fail() {} } : seriesProfile(episodeId)
      this.seriesProfiles.set(seriesId, profile)
      if (this.seriesProfiles.size > 200) {
        for (const [key] of this.seriesProfiles) {
          if (key !== seriesId && ![...this.sessions.values()].some(session => session.seriesId === key)) { this.seriesProfiles.delete(key); break }
        }
      }
    }
    const id = randomUUID()
    const session = { id, profile, seriesId, all: detail.episodes, first: index, currentIndex: index, offset: 0,
      sequence: 0, discontinuities: 0, entries: [], retryKeys: new Map(), usedAt: Date.now(), createdAt: Date.now(), time: 0 }
    this.sessions.set(id, session)
    session.pending = this.extend(session, index + 1)
    return { id, mode: this.mode, ...(this.mode === 'hls' ? { playlistUrl: this.url(id) } : {}), statusUrl: `${this.base}/api/playback/${id}` }
  }
  exclusive(fn) {
    const promise = this.maintenance.then(fn)
    this.maintenance = promise.catch(() => {})
    return promise
  }
  reservedBytes() {
    return [...this.jobs.values()].reduce((total, job) => total + (!job.running && (job.done || job.error) ? job.bytes : this.jobBudget), 0)
  }
  async extend(session, through) {
    for (let i = (session.entries.at(-1)?.index ?? session.first - 1) + 1; i <= Math.min(through, session.all.length - 1); i++) {
      try {
        const episode = session.all[i]
        let key = session.retryKeys.get(i) ?? createHash('sha256').update(`${session.profile.id}:${session.seriesId}:${episode.id}`).digest('hex')
        const job = await this.exclusive(async () => {
          if (!this.sessions.has(session.id) || this.closed) return undefined
          let existing = this.jobs.get(key)
          if (existing?.error && !existing.refs.size && !existing.running && !existing.readers) { await this.removeJob(existing); existing = undefined }
          if (existing?.cancelled || existing?.error || existing?.controller.signal.aborted) {
            // A rapid explicit re-selection must not join a dying encoder. Do
            // not await its finally inside this queue (it also needs the queue).
            key = createHash('sha256').update(randomUUID()).digest('hex')
            existing = undefined
          }
          if (existing) { existing.refs.add(session.id); return existing }
          await this.sweep()
          let reserved = this.reservedBytes()
          const evictable = [...this.jobs.values()].filter(j => !j.refs.size && !j.running && !j.readers).sort((a, b) => a.usedAt - b.usedAt)
          while (reserved + this.jobBudget > this.maxBytes && evictable.length) {
            await this.removeJob(evictable.shift())
            reserved = this.reservedBytes()
          }
          if (reserved + this.jobBudget > this.maxBytes) throw fail('CACHE_FULL', '媒体空间已满，活跃播放不会被清除，请释放其他播放后重试', 507)
          if (!this.sessions.has(session.id)) return undefined
          const dir = join(this.root, key)
          await mkdir(dir, { mode: 0o700 })
          existing = { key, dir, episode, profile: session.profile, segments: [], refs: new Set([session.id]), readers: 0, controller: new AbortController(), usedAt: Date.now(), bytes: 0 }
          this.jobs.set(key, existing)
          this.queue.push(existing)
          return existing
        })
        if (!job) return
        if (!this.sessions.has(session.id)) { job.refs.delete(session.id); await this.retire(job); return }
        job.usedAt = Date.now()
        session.entries.push({ index: i, job })
        this.pump()
      } catch (error) {
        if (session.profile.owner === session.all[i].id) session.profile.fail(error)
        session.extendError = { index: i, ...publicError(error) }
        return
      }
    }
  }
  pump() {
    while (!this.closed && this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift()
      if (!this.jobs.has(job.key) || !job.refs.size) continue
      job.running = true
      this.running++
      job.promise = Promise.resolve().then(() => this.encode(job, { ...this.encoding, profile: job.profile, source: this.upstream.source.bind(this.upstream) }))
        .catch(error => { job.error = publicError(error) })
        .finally(async () => {
          try { job.bytes = await directorySize(job.dir) } catch { job.bytes = 0 }
          job.running = false
          job.usedAt = Date.now()
          this.running--
          if (!job.refs.size && job.cancelled) await this.exclusive(() => this.removeJob(job))
          this.pump()
        })
    }
  }
  timeline(session) {
    let start = session.offset
    let reachable = true
    return session.entries.map(({ job, index }) => {
      const duration = sum(job)
      const partialCurrent = job.error && index <= session.currentIndex && session.time < start + duration - 0.15
      const row = { id: job.episode.id, number: job.episode.number, title: job.episode.title, start, duration,
        ready: reachable && playableJob(job) && (!job.error || partialCurrent),
        ...(job.fileReady && !job.error ? { mediaUrl: `${this.base}/api/playback/${session.id}/media/${job.key}.mp4` } : {}) }
      start += duration
      reachable &&= job.done === true && !job.error
      return row
    })
  }
  problem(session) {
    const failed = session.entries.find(({ job }) => job.error)
    if (failed) return { index: failed.index, episodeId: failed.job.episode.id, ...failed.job.error }
    if (session.extendError) return { ...session.extendError, episodeId: session.all[session.extendError.index].id }
  }
  status(id) {
    const session = this.get(id)
    const problem = this.problem(session)
    const episodes = this.timeline(session)
    const final = session.entries.at(-1)
    const finished = !problem && !!final && final.index === session.all.length - 1 && session.entries.every(({ job }) => job.done && !job.error)
    const end = session.offset + episodes.reduce((total, row) => total + row.duration, 0)
    const playable = episodes.some(row => row.ready)
    const fatal = problem && problem.index <= session.currentIndex && !episodes.some((row, i) => session.entries[i].index >= session.currentIndex && row.ready)
    return { id, mode: this.mode, state: fatal ? 'error' : finished && session.time >= end - 0.15 ? 'ended' : playable ? 'ready' : 'preparing',
      ...(this.mode === 'hls' ? { playlistUrl: this.url(id) } : {}), episodes, finished,
      ...(fatal ? { error: { code: problem.code, message: problem.message } } : problem ? { nextError: { episodeId: problem.episodeId, code: problem.code, message: problem.message } } : {}) }
  }
  progress(id, time) {
    const session = this.get(id)
    if (typeof time !== 'number' || !Number.isFinite(time) || time < session.offset) throw fail('INVALID_TIME', '播放位置已移出窗口，请重新选集', 400)
    const timeline = this.timeline(session)
    const available = timeline.filter(row => row.ready).reduce((max, row) => Math.max(max, row.start + row.duration), session.offset)
    if (time > available + 2) throw fail('INVALID_TIME', '播放位置尚不可用', 400)
    session.time = time
    let current = 0
    for (let i = 0; i < timeline.length; i++) if (timeline[i].ready && time >= timeline[i].start) current = i
    session.currentIndex = session.entries[current]?.index ?? session.currentIndex
    const removeCount = Math.max(0, current - 1)
    if (removeCount) {
      const removed = session.entries.splice(0, removeCount)
      for (const { job } of removed) {
        session.offset += sum(job)
        session.sequence += job.segments.length
        session.discontinuities++
        job.refs.delete(id)
        void this.retire(job).catch(() => {})
      }
    }
    const through = session.currentIndex + 1
    if (!this.problem(session) && through > (session.entries.at(-1)?.index ?? -1)) {
      session.pending = session.pending.then(() => this.extend(session, through))
    }
    return this.status(id)
  }
  async retryNext(id) {
    const session = this.get(id)
    if (session.retrying) return this.status(id)
    session.retrying = true
    try {
      await session.pending
      const problem = this.problem(session)
      if (!problem) return this.status(id)
      if (problem.index <= session.currentIndex) throw fail('RETRY_CURRENT', '当前集失败，请重新选择当前集播放', 409)
      // Failed future jobs were never published. Give this explicit retry a new
      // opaque job key; a second session's failed/current job is not rewritten.
      const removed = session.entries.filter(entry => entry.index >= problem.index)
      session.entries = session.entries.filter(entry => entry.index < problem.index)
      for (const { job } of removed) { job.refs.delete(id); await this.retire(job) }
      session.retryKeys.set(problem.index, createHash('sha256').update(randomUUID()).digest('hex'))
      session.extendError = undefined
      session.pending = this.extend(session, session.currentIndex + 1)
      await session.pending
      return this.status(id)
    } finally { session.retrying = false }
  }
  playlist(id) {
    const session = this.get(id)
    const status = this.status(id)
    if (status.state === 'error') throw fail(status.error.code, status.error.message)
    const rows = []
    for (const { job, index } of session.entries) {
      if (job.error && index > session.currentIndex || !job.segments.length) break
      if (rows.length) rows.push('#EXT-X-DISCONTINUITY')
      for (const segment of job.segments) rows.push(`#EXTINF:${segment.duration.toFixed(6)},`, `${this.base}/api/playback/${id}/segments/${job.key}/${segment.name}`)
      if (!job.done || job.error) break
    }
    if (!rows.length) throw fail('PLAYBACK_PREPARING', '正在准备可播放分片', 425)
    return ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-TARGETDURATION:3',
      `#EXT-X-MEDIA-SEQUENCE:${session.sequence}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${session.discontinuities}`, ...rows,
      ...(status.finished ? ['#EXT-X-ENDLIST'] : []), ''].join('\n')
  }
  segment(id, key, name) {
    const session = this.get(id)
    if (!/^[a-f0-9]{64}$/.test(key) || !/^s\d{6}\.ts$/.test(name)) throw fail('SEGMENT_NOT_FOUND', '分片不存在', 404)
    const job = session.entries.find(entry => entry.job.key === key)?.job
    if (!job || !job.segments.some(segment => segment.name === name)) throw fail('SEGMENT_NOT_FOUND', '分片已移出窗口或尚未准备好', 404)
    return join(job.dir, name)
  }
  leaseMedia(id, key) {
    const session = this.get(id)
    const job = session.entries.find(entry => entry.job.key === key)?.job
    if (!/^[a-f0-9]{64}$/.test(key) || !job?.fileReady || job.error) throw fail('MEDIA_NOT_FOUND', '视频尚未准备好或已移出窗口', 404)
    return this.leaseJob(job, join(job.dir, 'output.mp4'))
  }
  leaseSegment(id, key, name) {
    const path = this.segment(id, key, name)
    return this.leaseJob(this.jobs.get(key), path)
  }
  leaseJob(job, path) {
    job.readers++
    let released = false
    return { path, release: () => {
      if (released) return
      released = true
      job.readers--
      if (!job.refs.size) void this.retire(job).catch(() => {})
    } }
  }
  async retire(job) {
    return this.exclusive(async () => {
      if (job.refs.size) return
      if (job.profile?.owner === job.episode.id) job.profile.fail(fail('PROFILE_CANCELLED', '首集画幅准备已取消，请重新选集', 503))
      job.evict = true
      if (job.running) { job.cancelled = true; job.controller.abort(); return }
      await this.removeJob(job)
    })
  }
  async release(id) {
    const session = this.get(id, false)
    this.sessions.delete(id)
    // Do not hold the maintenance queue while awaiting pending allocation.
    await session.pending
    for (const { job } of session.entries) { job.refs.delete(id); await this.retire(job) }
    return { ok: true }
  }
  async removeJob(job) {
    if (!job || job.refs.size || job.running || job.readers) return
    if (job.profile?.owner === job.episode.id) job.profile.fail(fail('PROFILE_CANCELLED', '首集画幅准备已取消，请重新选集', 503))
    this.jobs.delete(job.key)
    this.queue = this.queue.filter(item => item !== job)
    const target = resolve(this.root, job.key)
    if (!/^[a-f0-9]{64}$/.test(job.key) || !target.startsWith(this.root + '/')) throw new Error('Unsafe cache path')
    await rm(target, { recursive: true, force: true })
  }
  async sweep() {
    const now = Date.now()
    for (const session of this.sessions.values()) {
      if (now - session.usedAt > this.idleMs || now - session.createdAt > 6 * 3_600_000) {
        this.sessions.delete(session.id)
        for (const { job } of session.entries) {
          job.refs.delete(session.id)
          if (!job.refs.size) { job.evict = true; if (job.running) { job.cancelled = true; job.controller.abort() } }
        }
      }
    }
    for (const job of this.jobs.values()) if (!job.refs.size && !job.running && !job.readers && (job.evict || now - job.usedAt > this.cacheAgeMs)) await this.removeJob(job)
  }
  cleanup() { return this.exclusive(() => this.sweep()) }
  async close() {
    this.closed = true
    clearInterval(this.timer)
    await Promise.all([...this.sessions.values()].map(session => session.pending))
    for (const job of this.jobs.values()) job.controller.abort()
    await Promise.all([...this.jobs.values()].map(job => job.promise))
    await this.maintenance
    this.sessions.clear()
    this.queue = []
  }
}
