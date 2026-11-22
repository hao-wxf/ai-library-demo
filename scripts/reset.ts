import { rmSync } from 'node:fs'

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  rmSync(`data/library.sqlite${suffix}`, { force: true })
  rmSync(`data/agent.sqlite${suffix}`, { force: true })
}
console.log('AI Library demo data reset. Stop the server before running this script.')
