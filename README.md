# world-capabilities

`world-capabilities` is the monorepo for host-side capability packs that resolve
World external effects under receiver-local policy.

Boundary defines and defunctionalizes the program.
World closes known handlers at comptime and emits the application runtime.
world-host persists Frames and operates the capability membrane.
world-capabilities resolves only genuinely external effects.

This repository is private initially. world-host PR #5 supplies the hardened v0
Capability Plane membrane. `world-capabilities` pressure-tests and populates
that membrane while adding the narrower v1 effect boundary.

## Charter

Capabilities are host-side effect handlers. A capability package may return
untrusted ResolutionInput-like records only.

This repository does not define Boundary semantics, does not define World
semantics, does not mint World evidence, and does not replace world-host. World
validates and finalizes outcomes and authors receipts/evidence. Capability
packages remain replaceable host-owned adapters.

Foundry v0 default conformance:

- uses no live network
- requires no secrets
- requires no Boundary checkout
- requires no World checkout
- requires no world-host checkout
- uses no real vendor SDKs
- uses no npm runtime dependencies
- publishes no packages

World Effect protocol v1 is available alongside the v0 HostRequest adapter
surface. The v1 router accepts a World-authored `EffectRequest`, runs
receiver-local preflight before any effect, and authors only an untrusted
`EffectResult`. It cannot author a `Frame` or other World evidence.

## Completion Equation

```text
Agent Runtime v0.1 pack
  + capability pack
  + capability policy
  + capability conformance
  =
a safe host effect handler
```

## Included Packs

- `fixture-model`: deterministic model-like fixture capability.
- `generic-http-json`: dry-run HTTP JSON skeleton.
- `human-approval`: noninteractive approval fixture.
- `sandbox-files`: local fixture-root file read/write skeleton.
- `local-memory-kv`: deterministic key/value fixture.
- `sidecar-fixture`: sidecar packaging/security fixture.

The first five packs declare their exact v1 interface, schema, and authority
identities in `manifest.json`. `agent.invoke.v1` is a receiver-constructed
built-in binding because its child runner is host authority rather than pack
data.

## Proof

```bash
bun --version
bun test
bun run check
bun run proof
bun run proof:packs
bun run proof:negative
bun run proof:sidecars
bun run proof:redaction
bun run proof:policy
bun run proof:v1
bun run proof:agent-invoke
bun run corpus:check
```

`corpus:update` and `packs:build` are explicit maintainer commands. They never
run as part of default proof.

See [Effect protocol v1](docs/effect_protocol_v1.md),
[agent invocation](docs/agent_invoke_v1.md), and the
[v0/v1 adapter boundary](docs/v0_v1_adapter.md).
