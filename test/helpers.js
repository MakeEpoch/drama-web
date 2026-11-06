import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const episodes = Array.from({ length: 6 }, (_, i) => ({ id: `e${i + 1}`, number: i + 1, title: `第${i + 1}集` }))
export function fixtureUpstream(count = 6) {
  return {
    async feed() { return { items: [{ id: 'show', title: '合成测试', cover: '', episodes: count }] } },
    async search() { return { ...(await this.feed()), cursor: '', hasMore: false } },
    async series() { return { series: { id: 'show', title: '合成测试', cover: '', episodes: count }, episodes: episodes.slice(0, count) } },
    async source() { throw new Error('fixture source not configured') },
  }
}
export async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'drama-web-test-'))
  t.after(async () => {
    const path = resolve(dir)
    if (!path.startsWith(resolve(tmpdir()) + '/drama-web-test-')) throw new Error('Unsafe temp cleanup')
    await rm(path, { recursive: true, force: true })
  })
  return dir
}
export async function until(fn, timeout = 15_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = await fn()
    if (result) return result
    await delay(25)
  }
  throw new Error('Condition timed out')
}
export async function fakeEncode(job) {
  await writeFile(join(job.dir, 's000000.ts'), 'synthetic transport stream')
  job.segments = [{ name: 's000000.ts', duration: 2 }]
  job.done = true
}
