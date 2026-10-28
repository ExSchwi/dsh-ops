# OPS Integration API

English | [中文](集成接口.md)

This document describes the opt-in preset integration exported as `dsh-ops/integration`.
Installing OPS or importing the module publishes nothing. The preset owner must mount one
integration inside its own composition, or provide an explicit preset id.

## Minimal Native integration

```js
import { integration } from 'dsh-ops/integration'
export default integration({ preset: 'acme-chat' })
```

The default publishes the resident Native file surface and an `ops_discover_tools` entry for
that exact preset. It does not replace official tools, publish Bash, or affect any other preset.
Selection activates only reviewed OPS capabilities and takes effect on the next model step.

## Detailed configuration

```js
integration({
  preset: 'acme-chat',
  files: true,
  shell: true,
  presentation: 'native',
  discovery: true,
  allowedTools: ['stat', 'grep', 'read_files'],
  alwaysLoaded: ['stat'],
  replaceOfficial: false,
  promptPolicy: true,
  extraGuidance: 'Use OPS for bounded repository inspection.',
})
```

`files`, `shell`, discovery, prompt guidance, and official replacement are independent choices.
`alwaysLoaded` must be a subset of `allowedTools`; unknown keys and unavailable capabilities fail
synchronously. The `shell` choice publishes `ops_bash` only where the host and authorization
permit it. Bash is resident, not a discovery choice.

## PTC

Use `profile: 'ptc'` only when the host presents the selected preset as actual PTC (`run_code` plus
the `tools:ptc-only` section). `files: false` is invalid. `discovery: false` removes the typed SDK
loader, while the PTC resident contracts remain. OPS currently does **not** expose a third-party
PTC provider/SDK registration contract; Native provider integration must not be described as one.

## Lifecycle and ownership

The binding is scoped to the mounting composition and exact preset id. Sibling scopes and unrelated
preset ids remain unchanged. A second binding for the same id and scope is rejected. Dispose the
returned Cordis fiber to withdraw tools, prompt sections, replacements, pending activation and old
callbacks. OPS checks binding, scope, presentation and current host authority at execution time; the
provider remains responsible for its own code and authorization.

Official tools are kept unless `replaceOfficial: true`, and a replacement is hidden only while its
OPS counterpart is actually visible. A missing worker or failed publication therefore leaves the
official tool available. Compatibility mode still lifts replacements without unloading OPS.

## External advanced tools

See [External Native provider contract](external-provider.md). Plugins register reviewed metadata,
parameters, result schema/rendering and a mandatory authorization callback through
`registerNativeCapability`. Presets explicitly allow names using `externalTools` (default `[]`),
optionally select `externalAlwaysLoaded`, and deny names using `externalDisabled`. Pure external
Native discovery needs no OPS worker, file component, Bash or subprocess service. External PTC
SDK registration is not supported.
