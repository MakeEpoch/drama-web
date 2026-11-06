// SDK usage/data mapping informed by frostming/dsh-hongguo a914be7.
// Standalone implementation; no DSH services or existing plugin state.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createClient, fileProfileStore } from 'openhongguo'
import { fail, safeId } from './errors.js'
import { download, validateURL } from './network.js'

export function createUpstream({ dataDir, base = '', sdkFactory = createClient } = {}) {
  let clientPromise
  let queue = Promise.resolve()
  let waiting = 0
  let feedCache
  const details = new Map()
  const covers = new Map()
  function boundedSet(map, key, value, max) {
    map.delete(key)
    map.set(key, value)
    while (map.size > max) map.delete(map.keys().next().value)
  }
  async function sdk() {
    clientPromise ??= mkdir(dataDir, { recursive: true, mode: 0o700 }).then(() => sdkFactory({
      profile: fileProfileStore(join(dataDir, 'anonymous.json')), timeoutMs: 20_000, retryAttempts: 1,
      log() {},
    })).catch(error => { clientPromise = undefined; throw error })
    return clientPromise
  }
  // Device resets and playback resolution are serialized: one resolution must
  // not invalidate a concurrent call's profile. Queue is bounded, not unlimited.
  function call(fn) {
    if (waiting >= 24) return Promise.reject(fail('UPSTREAM_BUSY', '上游请求繁忙，请稍后重试', 503))
    waiting++
    const work = queue.then(async () => {
      const client = await sdk()
      try { return await fn(client) } catch (error) {
        if (error?.code !== 'ANONYMOUS_LIMITED') throw error
        await client.resetDevice()
        return fn(client)
      }
    })
    queue = work.catch(() => {}).finally(() => { waiting-- })
    return work
  }
  function cover(url) {
    if (!url) return ''
    try { validateURL(url, 'cover') } catch { return '' }
    const token = createHash('sha256').update(url).digest('hex')
    boundedSet(covers, token, url, 2048)
    // Signed upstream URLs are never serialized to the client.
    return `${base}/api/cover?u=${token}`
  }
  function row(item) {
    return {
      id: String(item.id), title: item.title ?? '', description: item.description ?? '',
      cover: cover(item.cover_url), episodes: item.episode_count ?? 0,
      heat: item.digg_count ?? item.comment_count ?? '',
    }
  }
  return {
    async feed() {
      if (feedCache && Date.now() - feedCache.at < 180_000) return feedCache.value
      const value = await call(async client => {
        const page = await client.discover({})
        return { items: [...new Map((page.items ?? []).slice(0, 60).map(item => [String(item.id), row(item)])).values()] }
      })
      feedCache = { at: Date.now(), value }
      return value
    },
    async search(query, cursor = '') {
      if (!query || query.length > 80 || cursor.length > 256) throw fail('INVALID_QUERY', '请输入有效搜索词', 400)
      return call(async client => {
        const page = await client.search(query, cursor ? { cursor } : {})
        return { items: [...new Map((page.items ?? []).slice(0, 60).map(item => [String(item.id), row(item)])).values()], cursor: page.cursor ?? '', hasMore: page.has_more === true }
      })
    },
    async series(id) {
      safeId(id)
      const cached = details.get(id)
      if (cached && Date.now() - cached.at < 300_000) return cached.value
      const value = await call(async client => {
        const series = await client.getSeries(id)
        const all = new Map()
        const cursors = new Set()
        let cursor
        for (let pageNo = 0; pageNo < 20; pageNo++) {
          const page = await client.listEpisodes(id, { pageSize: 200, ...(cursor ? { cursor } : {}) })
          for (const episode of page.items ?? []) all.set(String(episode.id), episode)
          if (!page.has_more) break
          if (!page.cursor || cursors.has(page.cursor) || pageNo === 19) throw fail('EPISODE_LIST_INCOMPLETE', '上游分集列表不完整，暂不能连续播放')
          cursors.add(page.cursor)
          cursor = page.cursor
        }
        if (Number(series.episode_count) > all.size) throw fail('EPISODE_LIST_INCOMPLETE', '上游分集列表不完整，暂不能连续播放')
        const episodes = [...all.values()].map(episode => ({
          id: safeId(String(episode.id)), number: Number(episode.number), title: episode.title ?? `第${episode.number}集`,
        })).sort((a, b) => a.number - b.number)
        if (!episodes.length || episodes.length > 2000 || episodes.some(e => !Number.isFinite(e.number))) {
          throw fail('EPISODES_UNAVAILABLE', '分集列表不可用', 404)
        }
        return { series: { ...row(series), id }, episodes }
      })
      boundedSet(details, id, { at: Date.now(), value }, 100)
      return value
    },
    async source(episodeId, path, signal) {
      safeId(episodeId)
      const result = await call(client => client.resolvePlayback(episodeId))
      const stream = result.playback?.streams?.find(stream => stream.url && !stream.hls && !stream.dash)
      if (!stream) throw fail('SOURCE_UNSUPPORTED', '该剧暂无可转码的文件源')
      const key = result.contentKey?.key
      if (result.playback?.protected && !/^[a-fA-F0-9]{32}$/.test(key ?? '')) {
        throw fail('CONTENT_KEY_UNAVAILABLE', '上游没有提供可用的内容密钥')
      }
      await download(stream.url, { path, signal })
      return { path, key: result.playback?.protected ? key : undefined }
    },
    async cover(token) {
      const url = covers.get(token)
      if (!url) throw fail('COVER_NOT_FOUND', '封面已过期，请刷新列表', 404)
      return download(url, { kind: 'cover', maxBytes: 6 * 1024 ** 2, timeoutMs: 20_000 })
    },
  }
}
