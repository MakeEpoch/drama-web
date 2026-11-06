// Explicit synthetic-media fixture for browser smoke checks. Never contacts SDK.
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from '../server/app.js'
import { runProcess } from '../server/media.js'

const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : await mkdtemp(join(tmpdir(), 'drama-web-fixture-'))
await mkdir(dataDir, { recursive: true, mode: 0o700 })
const mediaDir = join(dataDir, 'synthetic-fixtures')
await mkdir(mediaDir, { recursive: true, mode: 0o700 })
for (let i = 1; i <= 3; i++) {
  await runProcess('/usr/bin/ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=180x320:rate=25`,
    ...(i !== 2 ? ['-f', 'lavfi', '-i', `sine=frequency=${i * 220}:sample_rate=48000`] : []),
    '-t', String(8 + i), '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
    ...(i !== 2 ? ['-c:a', 'aac'] : []), join(mediaDir, `e${i}.mp4`)])
}
const coverPath = join(mediaDir, 'cover.jpg')
await runProcess('/usr/bin/ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x303c72:s=180x320', '-frames:v', '1', '-threads', '1', '-update', '1', coverPath])
const base = (process.env.PUBLIC_BASE ?? '').replace(/\/+$/, '')
const item = { id: 'synthetic', title: '本地合成 · 连续播放测试', description: '仅用于测试，三集彩色测试图与合成音。第二集无音轨，后端补静音。不是红果真人源。', cover: `${base}/api/cover?u=${'a'.repeat(64)}`, episodes: 3, heat: '合成样本' }
const episodes = Array.from({ length: 3 }, (_, i) => ({ id: `e${i + 1}`, number: i + 1, title: `第${i + 1}集 · ${i === 1 ? '静音' : '合成音'}` }))
const upstream = {
  async feed() { return { items: [item] } },
  async search() { return { items: [item], cursor: '', hasMore: false } },
  async series() { return { series: item, episodes } },
  async source(id, path) { await copyFile(join(mediaDir, `${id}.mp4`), path); return { path } },
  async cover() { return { body: await readFile(coverPath) } },
}
const app = await createApp({ dataDir, base, upstream })
const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 3339)
app.server.listen(port, host, () => console.info(`Synthetic fixture only: http://${host}:${port}${base}/`))
console.info('Synthetic fixtures retained in private DATA_DIR; no upstream calls, keys or anonymous device.')
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close())
