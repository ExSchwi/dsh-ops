import fs from 'node:fs'
import path from 'node:path'
import { pinnedBashExecutable } from '../lib/shells/pinned.js'
import { confinedBash } from '../lib/bash-ipc.js'
import { independentBashRoots } from './lib/bash-ipc-processes.mjs'
import { assert, test, report, ownWindowsFixture, withTempDir } from './lib/harness.mjs'

/**
 * Stage the smallest payload the confined path accepts: the pinned executable and its DLLs, so the
 * IPC regression does not copy unrelated Git documentation and programs.
 * @param {string} home - the temporary home.
 * @returns {string} the `usr/bin` directory holding the payload.
 */
function minimalPayload(home) {
  const file = pinnedBashExecutable({ file: process.env.DSH_OPS_TEST_BASH })
  const source = path.resolve(path.dirname(file), '../usr/bin')
  const minimal = path.join(home, 'payload/usr/bin')
  fs.mkdirSync(minimal, { recursive: true })
  for (const name of fs.readdirSync(source).filter(name => name === 'bash.exe' || name.endsWith('.dll'))) {
    fs.copyFileSync(path.join(source, name), path.join(minimal, name))
  }
  return minimal
}

await test('identical payloads share one generation and a legacy generation is adopted (#466)', async () => {
  if (process.platform !== 'win32') {
    console.log('  Windows restricted MSYS fixture unavailable: non-Windows host')
    return
  }
  await withTempDir('bash-ipc-roots', async home => {
    const minimal = minimalPayload(home)
    const runtime = confinedBash(path.join(minimal, 'bash.exe'), { home })
    assert.ok(runtime.runtime)
    const cache = path.join(home, 'dsh-ops', 'bash-ipc')
    const generations = () => fs.readdirSync(cache).filter((name) => /^[a-f0-9]{24}$/u.test(name))

    // The identity is content-addressed, not source-path-addressed: the same payload at a second
    // root reuses the one generation instead of staging a second full copy (#466).
    const second = path.join(home, 'payload-2/usr/bin')
    fs.mkdirSync(second, { recursive: true })
    for (const name of fs.readdirSync(minimal)) fs.copyFileSync(path.join(minimal, name), path.join(second, name))
    const reused = confinedBash(path.join(second, 'bash.exe'), { home })
    assert.equal(reused.runtime, runtime.runtime)
    assert.deepEqual(generations(), [runtime.runtime], 'one payload, one generation')

    // A generation staged under the previous identity scheme is adopted — renamed into place after
    // every verified byte matches — rather than copied again or quarantined.
    const legacy = '0123456789abcdef01234567'
    fs.renameSync(path.join(cache, runtime.runtime), path.join(cache, legacy))
    const marker = path.join(cache, legacy, '.ops-ipc.json')
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'))
    parsed.identity = legacy
    fs.writeFileSync(marker, `${JSON.stringify(parsed)}\n`)
    const adopted = confinedBash(path.join(minimal, 'bash.exe'), { home })
    assert.equal(adopted.runtime, runtime.runtime)
    assert.equal(fs.existsSync(path.join(cache, legacy)), false, 'the legacy directory was renamed, not copied')
    assert.equal(fs.existsSync(path.join(cache, runtime.runtime)), true)
    assert.deepEqual(generations(), [runtime.runtime])
  })
})

await test('a confined call reclaims older generations and keeps one predecessor (#466)', async () => {
  if (process.platform !== 'win32') {
    console.log('  Windows restricted MSYS fixture unavailable: non-Windows host')
    return
  }
  await withTempDir('bash-ipc-roots-sweep', async home => {
    const cache = path.join(home, 'dsh-ops', 'bash-ipc')
    const older = 'e'.repeat(24), predecessor = 'f'.repeat(24)
    for (const [name, when] of [[older, Date.UTC(2026, 0, 1)], [predecessor, Date.UTC(2026, 0, 2)]]) {
      fs.mkdirSync(path.join(cache, name), { recursive: true })
      fs.writeFileSync(path.join(cache, name, 'payload.bin'), 'stale generation\n')
      fs.utimesSync(path.join(cache, name), new Date(when), new Date(when))
    }
    const minimal = minimalPayload(home)
    const runtime = confinedBash(path.join(minimal, 'bash.exe'), { home })
    const generations = fs.readdirSync(cache).filter((name) => /^[a-f0-9]{24}$/u.test(name))
    assert.equal(generations.includes(runtime.runtime), true, 'the current generation was staged')
    assert.equal(generations.includes(older), false, 'the older generation was reclaimed')
    assert.equal(generations.includes(predecessor), true, 'one predecessor is retained')
  })
})

await test('independent restricted Bash roots reopen the user shared section (#363)', async () => {
  if (process.platform !== 'win32') {
    console.log('  Windows restricted MSYS fixture unavailable: non-Windows host')
    return
  }
  await withTempDir('bash-ipc-roots-shared', async home => {
    const minimal = minimalPayload(home)
    const runtime = confinedBash(path.join(minimal, 'bash.exe'), { home })
    assert.ok(runtime.runtime)
    const workspace = path.join(home, 'workspace')
    fs.mkdirSync(workspace)
    ownWindowsFixture(workspace)
    await independentBashRoots(runtime, workspace)
  })
})
report('bash-ipc-roots')
