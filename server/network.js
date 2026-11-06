import https from 'node:https'
import http from 'node:http'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import { open, rm } from 'node:fs/promises'
import { fail } from './errors.js'

const MEDIA = /(^|\.)(qznovelvod\.com|douyinvod\.com|bytecdn\.cn|ibytedtos\.com|snssdk\.com)$/i
const IMAGES = /(^|\.)(fqnovelpic\.com|byteimg\.com|pstatp\.com|snssdk\.com|bytecdn\.cn)$/i
export function validateURL(value, kind = 'media') {
  let url
  try { url = new URL(value) } catch { throw fail('SOURCE_URL', '不支持的来源地址', 403) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.port && !['80', '443'].includes(url.port) || !(kind === 'cover' ? IMAGES : MEDIA).test(url.hostname)) {
    throw fail('SOURCE_URL', '不支持的来源地址', 403)
  }
  return url
}
export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 ||
      a === 198 && (b === 18 || b === 19))
  }
  // Restrict IPv6 to global unicast; reject IPv4-mapped/loopback/link-local/ULA.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !address.toLowerCase().startsWith('2001:db8:')
}
function safeLookup(hostname, options, callback) {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error || !addresses?.length || addresses.some(row => !publicAddress(row.address))) {
      return callback(fail('SOURCE_DNS', '来源网络地址不可用', 502))
    }
    const selected = addresses.find(row => !options.family || row.family === options.family) ?? addresses[0]
    callback(null, options.all ? addresses : selected.address, selected.family)
  })
}

/** Bounds apply to the complete redirect chain, not independently to each hop. */
export async function download(value, { kind = 'media', path, maxBytes = 128 * 1024 ** 2, timeoutMs = 90_000, signal } = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(abort, timeoutMs)
  let file
  let completed = false
  try {
    if (path) file = await open(path, 'wx', 0o600)
    let url = validateURL(value, kind)
    for (let redirect = 0; redirect <= 3; redirect++) {
      const response = await new Promise((resolve, reject) => {
        const req = (url.protocol === 'https:' ? https : http).get(url, {
          lookup: safeLookup, signal: controller.signal,
          headers: { 'user-agent': 'DramaWeb/0.1', 'accept-encoding': 'identity' },
        }, resolve)
        req.on('error', reject)
      })
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location
        response.destroy()
        if (!location || redirect === 3) throw fail('SOURCE_REDIRECT', '来源重定向失败')
        url = validateURL(new URL(location, url).href, kind)
        continue
      }
      if (response.statusCode !== 200) {
        response.destroy()
        throw fail('SOURCE_HTTP', '来源暂时无法读取')
      }
      if (Number(response.headers['content-length']) > maxBytes) {
        response.destroy()
        throw fail('SOURCE_TOO_LARGE', '来源文件超过大小限制', 413)
      }
      let size = 0
      const chunks = []
      try {
        for await (const chunk of response) {
          size += chunk.length
          if (size > maxBytes) throw fail('SOURCE_TOO_LARGE', '来源文件超过大小限制', 413)
          if (file) await file.writeFile(chunk)
          else chunks.push(chunk)
        }
      } finally { response.destroy() }
      if (!size) throw fail('SOURCE_EMPTY', '来源返回空文件')
      completed = true
      return { size, contentType: response.headers['content-type'] ?? '', ...(file ? {} : { body: Buffer.concat(chunks) }) }
    }
    throw fail('SOURCE_REDIRECT', '来源重定向失败')
  } catch (error) {
    if (controller.signal.aborted) throw fail('SOURCE_TIMEOUT', '来源读取超时或已取消', 504)
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    await file?.close()
    if (file && !completed && path) await rm(path, { force: true })
  }
}
