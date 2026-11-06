import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from './app.js'

const port = Number(process.env.PORT ?? 3338)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
const dataDir = resolve(process.env.DATA_DIR ?? join(homedir(), '.local/share/drama-web'))
const app = await createApp({ dataDir, base: process.env.PUBLIC_BASE ?? '' })
const host = process.env.HOST ?? '127.0.0.1'
app.server.listen(port, host, () => console.info(`Drama Web listening on ${host}:${port}`))
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  const deadline = setTimeout(() => process.exit(1), 15_000)
  deadline.unref()
  await app.close()
  clearTimeout(deadline)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
