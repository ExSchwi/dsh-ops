/**
 * The Bash IPC cache as state an operator can see and the plugin can bound (#466).
 *
 * These cases are deliberately filesystem-only: the sweep and the report must be assertable
 * without staging a 412 MB MSYS payload, and without waiting for Windows to release a directory.
 * The identity itself is exercised against the real pinned payload in `bash-ipc-roots`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bashIpcInventory, bashIpcRoot, reclaimBashGenerations } from '../lib/bash-ipc.js'
import { assert, report, test, withTempDir } from './lib/harness.mjs'

const generation = (seed) => seed.repeat(24).slice(0, 24)

/** Seed one directory with a single file of `bytes` bytes, so sizes are exact. */
function seed(directory, bytes) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'payload.bin'), Buffer.alloc(bytes))
}

await test('the report names every cache entry exactly once and separates reclaimable bytes', async () => {
  await withTempDir('bash-ipc-report', (home) => {
    const root = bashIpcRoot(home)
    const current = generation('a'), previous = generation('b'), oldest = generation('c')
    const entries = [[current, 11], [previous, 13], [oldest, 17], [`${oldest}.bad-m1`, 19], ['stage-x', 23]]
    entries.forEach(([name, bytes], index) => {
      seed(path.join(root, name), bytes)
      const when = new Date(Date.UTC(2026, 0, 5 - index))
      fs.utimesSync(path.join(root, name), when, when)
    })
    fs.writeFileSync(path.join(root, 'ignore-me.txt'), 'not a directory')

    const report = bashIpcInventory({ home, current })
    assert.equal(report.root, root)
    assert.equal(report.current, current)
    assert.equal(report.generations, 3)
    assert.deepEqual(report.entries.map((entry) => entry.kind),
      ['generation', 'generation', 'generation', 'quarantine', 'staging'])
    assert.deepEqual(report.entries.filter((entry) => entry.current).map((entry) => entry.name), [current])
    assert.equal(report.entries.every((entry) => entry.files === 1), true)
    assert.equal(report.totalBytes, 11 + 13 + 17 + 19 + 23)
    // One previous generation is retained; only the older one is scheduled for reclamation.
    assert.equal(report.reclaimableBytes, 17)
    assert.equal(report.entries.some((entry) => entry.name === 'ignore-me.txt'), false)
  })
})

await test('a sweep keeps the current and one previous generation, and removes the rest', async () => {
  await withTempDir('bash-ipc-sweep', (home) => {
    const root = bashIpcRoot(home)
    const names = ['a', 'b', 'c', 'd'].map(generation)
    // Oldest first, so the newest stale generation is the one retained beside the current one.
    names.forEach((name, index) => {
      seed(path.join(root, name), 10 * (index + 1))
      const when = new Date(Date.UTC(2026, 0, index + 1))
      fs.utimesSync(path.join(root, name), when, when)
    })
    const quarantine = `${names[0]}.bad-m1`, staging = 'stage-live'
    seed(path.join(root, quarantine), 3)
    seed(path.join(root, staging), 5)

    const logged = []
    const result = reclaimBashGenerations(root, names[3], { log: (line) => logged.push(line) })
    assert.deepEqual(result.kept, [names[2]], 'the newest stale generation is the retained predecessor')
    assert.deepEqual(result.removed.sort(), [names[0], names[1]].sort())
    assert.equal(result.bytes, 10 + 20)
    assert.equal(logged.length, 2)
    for (const name of names.slice(0, 2)) assert.equal(fs.existsSync(path.join(root, name)), false, name)
    for (const name of [names[2], names[3], quarantine, staging]) assert.equal(fs.existsSync(path.join(root, name)), true, name)
  })
})

await test('a generation that cannot be renamed is kept intact, never half-deleted', async () => {
  await withTempDir('bash-ipc-in-use', (home) => {
    const root = bashIpcRoot(home)
    const current = generation('a'), retained = generation('b'), inUse = generation('c'), older = generation('d')
    const entries = [[current, 1], [retained, 2], [inUse, 3], [older, 4]]
    entries.forEach(([name, size], index) => {
      seed(path.join(root, name), size)
      const when = new Date(Date.UTC(2026, 0, 4 - index))
      fs.utimesSync(path.join(root, name), when, when)
    })
    const removedCalls = []
    const result = reclaimBashGenerations(root, current, {
      rename: (from, to) => {
        if (path.basename(from) === inUse) throw Object.assign(new Error('EPERM: in use'), { code: 'EPERM' })
        fs.renameSync(from, to)
      },
      remove: (target) => { removedCalls.push(target); fs.rmSync(target, { recursive: true, force: true }) },
      log: () => {},
    })
    assert.deepEqual(result.kept.sort(), [retained, inUse].sort())
    assert.deepEqual(result.removed, [older])
    assert.equal(fs.existsSync(path.join(root, inUse)), true)
    assert.equal(fs.existsSync(path.join(root, retained)), true)
    assert.equal(fs.existsSync(path.join(root, older)), false)
    assert.equal(removedCalls.length, 1, 'a refused rename must not be followed by a delete')
  })
})

await test('a sweep interrupted between rename and delete is finished by the next one', async () => {
  await withTempDir('bash-ipc-stale', (home) => {
    const root = bashIpcRoot(home)
    const current = generation('a'), stale = `${generation('b')}.stale-m1`
    seed(path.join(root, current), 1)
    seed(path.join(root, stale), 2)
    const result = reclaimBashGenerations(root, current, { log: () => {} })
    assert.deepEqual(result.removed, [])
    assert.equal(fs.existsSync(path.join(root, stale)), false)
  })
})

report('bash-ipc-cache')
