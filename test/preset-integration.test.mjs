/** Independently named preset consumes the public package export, not OPS internals. */
import fs from 'node:fs'
import path from 'node:path'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { integration, resolveIntegrationConfig } from 'dsh-ops/integration'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import * as Standard from '../lib/components/mode-standard/index.js'
import * as Discovery from '../lib/components/discovery/index.js'
import { bootHost, shutdown, scopedToolNames } from './lib/host.mjs'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
const tool = name => ({ name, description: name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
async function boot() {
  const { ctx } = await bootHost()
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {})
  ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }) })
  ctx.provide('agentPresets', { composedPreset: () => undefined })
  const live = []; ctx.provide('agents', { list: () => [...live] })
  const mint = async (id, cwd, parent) => {
    const base = createScope(parent?.ctx ?? ctx, { preset: id }, parent ? { parent } : undefined).ctx
    await base.plugin({ inject: ['tools'], apply(inner) { for (const name of ['read', 'glob', 'grep']) inner.tools.register(tool(name)) } })
    const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd, agentPreset: id } } }
    await base.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent, { parent: scopeOf(base) }).ctx } })
    live.push(agent); await ctx.serial('agent/created', { agent })
    return agent
  }
  return { ctx, mint, names: agent => scopedToolNames(ctx, agent) }
}
const execute = (ctx, agent, raw, args) => ctx.get('tools').execute({ agent, name: `ops_${raw}`, arguments: args, callId: 'third-party', signal: new AbortController().signal })
const next = (ctx, agent) => ctx.serial('session/event', agent.session, { type: 'step/end' })
await test('simple and detailed configuration are explicit and reject inert or invalid options', () => {
  const simple = resolveIntegrationConfig({ preset: 'acme-native' })
  assert.equal(simple.files, true); assert.equal(simple.shell, false); assert.equal(simple.replaceOfficial, false)
  assert.equal(simple.native.enabled, true)
  for (const raw of [{ preset: '' }, { preset: 'x', typo: true }, { preset: 'x', shell: 'yes' }, { preset: 'x', alwaysLoaded: ['bash'] },
    { preset: 'x', allowedTools: [], alwaysLoaded: ['stat'] }, { preset: 'x', profile: 'ptc', files: false },
    { preset: 'x', profile: 'ptc', extraGuidance: 'not implemented' }]) assert.throws(() => resolveIntegrationConfig(raw))
})
await test('unknown presets stay unchanged, opted-in files retain official tools and unload revokes callbacks', () => withTempDir('preset-integration', async cwd => {
  const { ctx, mint, names } = await boot()
  try {
    await ctx.plugin(Discovery, { required: true })
    const unrelated = await mint('acme-unselected', cwd)
    assert.deepEqual(names(unrelated), ['glob', 'grep', 'read'])
    const row = await ctx.plugin(integration({ preset: 'acme-selected', discovery: false }))
    const own = await mint('acme-selected', cwd)
    await waitFor(() => names(own).includes('ops_read_files'))
    for (const official of ['read', 'glob', 'grep']) assert.ok(names(own).includes(official))
    assert.equal(names(own).includes('ops_discover_tools'), false)
    assert.equal(names(own).includes('ops_bash'), false)
    fs.writeFileSync(path.join(cwd, 'hello.txt'), 'hello')
    assert.equal((await execute(ctx, own, 'read_files', { files: [{ path: 'hello.txt' }] })).isError, false)
    const stale = ctx.get('tools').get('ops_read_files', own)
    assert.equal((await stale.execute({ files: [] }, { agent: unrelated, signal: new AbortController().signal })).status, 'rejected')
    await row.dispose()
    assert.deepEqual(names(own), ['glob', 'grep', 'read'])
    assert.equal((await stale.execute({ files: [] }, { agent: own, signal: new AbortController().signal })).status, 'rejected')
  } finally { await shutdown(ctx) }
}))
await test('independent preset discovery pools activate only after a committed step', () => withTempDir('preset-pools', async cwd => {
  const { ctx, mint, names } = await boot()
  try {
    await ctx.plugin(integration({ preset: 'acme-one', profile: 'discovery', allowedTools: ['stat'] }))
    await ctx.plugin(integration({ preset: 'acme-two', profile: 'discovery', allowedTools: ['diff'] }))
    const a = await mint('acme-one', cwd), b = await mint('acme-two', cwd)
    await waitFor(() => names(a).includes('ops_discover_tools') && names(b).includes('ops_discover_tools'))
    assert.deepEqual((await execute(ctx, a, 'discover_tools', { query: 'select:ops_diff' })).value.activated, [])
    assert.deepEqual((await execute(ctx, a, 'discover_tools', { query: 'select:ops_stat' })).value.activated, ['ops_stat'])
    assert.equal(names(a).includes('ops_stat'), false)
    await next(ctx, a); await waitFor(() => names(a).includes('ops_stat'))
    assert.equal(names(b).includes('ops_stat'), false)
    a.session.header.agentPreset = 'acme-unselected'
    await ctx.serial('session/event', a.session, { type: 'agent-preset/selected' })
    await waitFor(() => !names(a).includes('ops_stat') && !names(a).includes('ops_discover_tools'))
  } finally { await shutdown(ctx) }
}))
await test('a missing worker never hides the official alternatives (#436)', () => withTempDir('preset-no-worker', async cwd => {
  const { ctx, mint, names } = await boot()
  try {
    await ctx.plugin(integration({ preset: 'acme-broken', binaryPath: path.join(cwd, 'missing-worker'), replaceOfficial: true }))
    const own = await mint('acme-broken', cwd)
    const assembly = await ctx.get('systemPrompt').assemble({ scope: own, agent: own })
    for (const name of ['read', 'glob', 'grep']) {
      assert.ok(names(own).includes(name))
      assert.equal((await ctx.get('tools').execute({ agent: own, name, arguments: {}, callId: name, signal: new AbortController().signal })).isError, false)
    }
    assert.equal(assembly.sections.some(section => section.name.startsWith('dsh-ops:') && section.text.trim()), false)
  } finally { await shutdown(ctx) }
}))
await test('PTC uses actual host presentation, keeps another native preset intact and respects prompt/dynamic switches', () => withTempDir('preset-ptc', async cwd => {
  const { ctx, mint, names } = await boot()
  try {
    ctx.provide('ptcRuntime', { language: 'typescript' })
    await ctx.plugin(integration({ preset: 'acme-ptc-label', profile: 'ptc', discovery: false, promptPolicy: false }))
    await ctx.plugin(integration({ preset: 'acme-native' }))
    const labeled = await mint('acme-ptc-label', cwd), native = await mint('acme-native', cwd)
    const first = await ctx.get('systemPrompt').assemble({ scope: labeled, agent: labeled })
    assert.equal(names(labeled).some(name => name.startsWith('ops_')), false, 'a preset id is not PTC-only presentation')
    assert.ok(first.tools.some(tool => tool.name === 'read'))
    const lift = labeled.ctx.tools.presentAs('ptc')
    await ctx.get('systemPrompt').assemble({ scope: labeled, agent: labeled })
    await waitFor(() => names(labeled).includes('ops_inspect_local_file'))
    assert.equal(names(labeled).includes('ops_load_sdk'), false)
    const actual = await ctx.get('systemPrompt').assemble({ scope: labeled, agent: labeled })
    assert.deepEqual(actual.tools.map(tool => tool.name), ['run_code'])
    assert.equal(actual.sections.some(section => section.name.startsWith('dsh-ops:') && section.text.trim()), false)
    assert.ok(names(native).includes('ops_read_files'))
    lift()
  } finally { await shutdown(ctx) }
}))
report('preset-integration')
