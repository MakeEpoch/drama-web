import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PlaybackManager } from './playback.js'
import { createUpstream } from './upstream.js'
import { runProcess } from './media.js'
import { AppError, fail, publicError } from './errors.js'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' }
export function normalizeBase(base = '') {
  const value = base.replace(/\/+$/, '')
  if (value && !/^\/(?:[A-Za-z0-9_-]+\/?)+$/.test(value)) throw new Error('PUBLIC_BASE must be a simple absolute URL path')
  return value
}
export async function jsonBody(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw fail('CONTENT_TYPE', '请使用 JSON 请求', 415)
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8192) throw fail('BODY_TOO_LARGE', '请求内容过大', 413)
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error()
    return body
  } catch { throw fail('INVALID_JSON', 'JSON 请求格式错误', 400) }
}
function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
async function sendFile(req, res, path, type, cache = 'no-cache') {
  const info = await stat(path).catch(() => { throw fail('FILE_NOT_FOUND', '文件不存在', 404) })
  if (!info.isFile()) throw fail('FILE_NOT_FOUND', '文件不存在', 404)
  let start = 0
  let end = info.size - 1
  let status = 200
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
    if (!range || !range[1] && !range[2]) throw fail('INVALID_RANGE', '不支持的读取范围', 416)
    if (!range[1]) {
      const suffix = Number(range[2])
      if (!Number.isSafeInteger(suffix) || suffix <= 0) throw fail('INVALID_RANGE', '读取范围不可用', 416)
      start = Math.max(0, info.size - suffix)
    } else { start = Number(range[1]); end = range[2] ? Number(range[2]) : end }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) throw fail('INVALID_RANGE', '读取范围不可用', 416)
    end = Math.min(end, info.size - 1)
    status = 206
    res.setHeader('content-range', `bytes ${start}-${end}/${info.size}`)
  }
  res.writeHead(status, { 'content-type': type, 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'cache-control': cache })
  if (req.method === 'HEAD') return res.end()
  const stream = createReadStream(path, { start, end })
  res.once('close', () => stream.destroy())
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

export async function createApp({ dataDir, base = '', upstream, managerOptions = {}, publicDir = join(project, 'public'), ffmpeg = '/usr/bin/ffmpeg' } = {}) {
  if (!dataDir) throw new Error('DATA_DIR required')
  base = normalizeBase(base)
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  upstream ??= createUpstream({ dataDir, base })
  const manager = new PlaybackManager({ upstream, dataDir, base, mode: 'file', ...managerOptions })
  await manager.init()
  const covers = new Map()
  let coverWorkers = 0
  const coverDir = join(dataDir, 'cover-temp')
  await mkdir(coverDir, { recursive: true, mode: 0o700 })
  async function cover(token) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw fail('INVALID_COVER', '无效封面编号', 400)
    const cached = covers.get(token)
    if (cached && Date.now() - cached.at < 300_000) return cached.body
    if (coverWorkers >= 2) throw fail('COVER_BUSY', '封面处理繁忙，请稍后重试', 503)
    coverWorkers++
    const id = randomUUID()
    const input = join(coverDir, `${id}.input`)
    const output = join(coverDir, `${id}.jpg`)
    try {
      const raw = await upstream.cover(token)
      await writeFile(input, raw.body, { mode: 0o600 })
      // Decode all image types (including HEIC) server-side; no SVG/HTML proxy.
      await runProcess(ffmpeg, ['-v', 'error', '-max_alloc', '67108864', '-nostdin', '-y', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', '-threads', '1', '-update', '1', output], { timeoutMs: 15_000 })
      const body = await readFile(output)
      if (body.length > 1024 ** 2) throw fail('COVER_TOO_LARGE', '封面输出过大', 413)
      covers.set(token, { at: Date.now(), body })
      while (covers.size > 100) covers.delete(covers.keys().next().value)
      return body
    } finally {
      coverWorkers--
      await Promise.all([rm(input, { force: true }), rm(output, { force: true })])
    }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'")
    try {
      // No CORS. Prevent a third-party page from creating/releasing local jobs.
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('ORIGIN_DENIED', '不允许跨站请求', 403)
      if (req.headers.origin) {
        let host
        try { host = new URL(req.headers.origin).host } catch {}
        if (host !== req.headers.host) throw fail('ORIGIN_DENIED', '不允许跨站请求', 403)
      }
      const url = new URL(req.url, 'http://localhost')
      let path = url.pathname
      // Works both directly under PUBLIC_BASE and through nginx prefix stripping.
      if (base && path === base) { res.writeHead(308, { location: `${base}/` }); return res.end() }
      if (base && path.startsWith(base + '/')) path = path.slice(base.length)
      const method = req.method
      if (method === 'GET' && path === '/api/health') return json(res, { ok: true, version: '0.1.0', playbackSessions: manager.sessions.size, transcodes: manager.running })
      if (method === 'GET' && path === '/api/feed') return json(res, await upstream.feed())
      if (method === 'GET' && path === '/api/search') return json(res, await upstream.search((url.searchParams.get('q') ?? '').trim(), url.searchParams.get('cursor') ?? ''))
      if (method === 'GET' && path === '/api/series') return json(res, await upstream.series(url.searchParams.get('id')))
      if (method === 'POST' && path === '/api/playback') {
        const body = await jsonBody(req)
        return json(res, await manager.create(body.seriesId, body.episodeId), 202)
      }
      const playback = /^\/api\/playback\/([^/]+)(.*)$/.exec(path)
      if (playback) {
        const [, id, suffix] = playback
        if (method === 'GET' && !suffix) return json(res, manager.status(id))
        if (method === 'DELETE' && !suffix) return json(res, await manager.release(id))
        if (method === 'POST' && suffix === '/progress') return json(res, manager.progress(id, (await jsonBody(req)).time))
        if (method === 'POST' && suffix === '/retry-next') { await jsonBody(req); return json(res, await manager.retryNext(id)) }
        if (method === 'GET' && suffix === '/index.m3u8') {
          const body = manager.playlist(id)
          res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' })
          return res.end(body)
        }
        const media = /^\/media\/([a-f0-9]{64})\.mp4$/.exec(suffix)
        if (['GET', 'HEAD'].includes(method) && media) {
          const lease = manager.leaseMedia(id, media[1])
          res.once('close', lease.release); res.once('finish', lease.release)
          try { return await sendFile(req, res, lease.path, 'video/mp4', 'private, max-age=3600') }
          catch (error) { lease.release(); throw error }
        }
        const segment = /^\/segments\/([^/]+)\/([^/]+)$/.exec(suffix)
        if (['GET', 'HEAD'].includes(method) && segment) {
          const lease = manager.leaseSegment(id, segment[1], segment[2])
          res.once('close', lease.release)
          res.once('finish', lease.release)
          try { return await sendFile(req, res, lease.path, 'video/mp2t', 'private, max-age=3600') }
          catch (error) { lease.release(); throw error }
        }
      }
      if (method === 'GET' && path === '/api/cover') {
        const body = await cover(url.searchParams.get('u') ?? '')
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': body.length, 'cache-control': 'private, max-age=300' })
        return res.end(body)
      }
      if (['GET', 'HEAD'].includes(method) && path === '/vendor/hls.min.js') {
        return await sendFile(req, res, join(project, 'node_modules/hls.js/dist/hls.min.js'), 'text/javascript; charset=utf-8', 'public, max-age=86400')
      }
      if (['GET', 'HEAD'].includes(method) && !path.startsWith('/api/')) {
        const relative = path === '/' ? 'index.html' : path.slice(1)
        if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.split('/').some(part => !part || part.startsWith('.'))) throw fail('FILE_NOT_FOUND', '文件不存在', 404)
        const target = resolve(publicDir, relative)
        const type = TYPES[extname(target)]
        if (!target.startsWith(resolve(publicDir) + '/') || !type) throw fail('FILE_NOT_FOUND', '文件不存在', 404)
        return await sendFile(req, res, target, type)
      }
      throw fail('NOT_FOUND', '接口不存在', 404)
    } catch (error) {
      if (res.headersSent) return res.destroy()
      json(res, { ok: false, error: publicError(error) }, error instanceof AppError ? error.status : 502)
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5000
  return { server, manager, async close() {
    const force = setTimeout(() => server.closeAllConnections(), 5000)
    try {
      await Promise.all([
        new Promise(resolve => { server.close(resolve); server.closeIdleConnections() }),
        manager.close(),
      ])
    } finally { clearTimeout(force) }
  } }
}
