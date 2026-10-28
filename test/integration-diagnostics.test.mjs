import { integration, registerNativeCapability, diagnose } from 'dsh-ops/integration'
import { createScope } from '@deepseek-ai/dsh-scope'
import { bootHost, shutdown, scopedToolNames } from './lib/host.mjs'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
await test('diagnostics distinguishes unselected, unavailable and ready publication states', () => withTempDir('diagnostics', async cwd => {
  const { ctx } = await bootHost()
  try {
    const agent = { id: 'diag', session: { id: 'diag', mode: 'read-only', header: { cwd, agentPreset: 'diag-preset' } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    const unselected = await diagnose(ctx, agent)
    assert.equal(unselected.state, 'not-selected')
    await ctx.plugin(integration({ preset: 'diag-preset', profile: 'discovery', externalTools: ['diag_lookup'], externalAlwaysLoaded: ['diag_lookup'] }))
    const unavailable = await diagnose(ctx, agent)
    assert.equal(unavailable.external[0].state, 'unavailable')
    await registerNativeCapability(ctx, { search: 'diagnostic lookup', authorize: () => true, definition: {
      name: 'diag_lookup', description: 'Diagnostic lookup.', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ ok: true }),
    } })
    await ctx.serial('agent/created', { agent })
    await waitFor(() => scopedToolNames(ctx, agent).includes('diag_lookup'))
    const result = await ctx.get('tools').execute({ agent, name: 'ops_status', arguments: {}, callId: 'diag', signal: new AbortController().signal })
    assert.equal(result.isError, false); assert.equal(result.value.external[0].state, 'active')
    const ready = await diagnose(ctx, agent)
    assert.equal(ready.state, 'ready'); assert.equal(ready.external[0].state, 'active')
    assert.equal(scopedToolNames(ctx, agent).includes('diag_lookup'), true)
    const retained = ctx.get('tools').get('ops_status', agent)
    await ctx.serial('agent/disposed', { agent })
    assert.equal((await retained.execute({}, { agent })).status, 'rejected')
  } finally { await shutdown(ctx) }
}))
report('integration-diagnostics')
