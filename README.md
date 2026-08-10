# world-capabilities

`world-capabilities` is the Effect protocol v1 Foundry for host-side capability
packs that resolve World external effects under receiver-local policy.

Boundary defines and defunctionalizes the program.
World closes known handlers at comptime and emits the application runtime.
world-host persists Frames and operates the capability membrane.
world-capabilities resolves only genuinely external effects.

The repository may remain private. Its versioned packs are checksum-bound,
statically inspectable source distributions. World-host supplies the capability
membrane; this repository supplies independently authored effect
implementations and conformance.

## Charter

Capabilities are host-side effect handlers. A capability package may return
untrusted ResolutionInput-like records only.

This repository does not define Boundary semantics, does not define World
semantics, does not mint World evidence, and does not replace world-host. World
validates and finalizes outcomes and authors receipts/evidence. Capability
packages remain replaceable host-owned adapters.

Effect v1 Foundry default conformance:

- uses no live network
- requires no secrets
- requires no Boundary checkout
- requires no World source checkout
- requires no world-host checkout
- uses no real vendor SDKs
- uses no npm runtime dependencies
- executes no adapter during static pack inspection

Effect protocol v1 is the primary surface. The v1 router accepts a
World-authored `EffectRequest`, runs
receiver-local preflight before any effect, and authors only an untrusted
`EffectResult`. It cannot author a `Frame` or other World evidence.

The v0 HostRequest adapter surface remains compatibility-only.

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

- `research-lookup-fixture`: World `v3.0.0` Research Digest fixture,
  bound to exact application, interface, schema, and authority identities and
  returning only bounded research items for Machine-owned formatting.
- `fixture-model`: deterministic model-like fixture capability.
- `generic-http-json`: dry-run HTTP JSON skeleton.
- `human-approval`: noninteractive approval fixture.
- `sandbox-files`: local fixture-root file read/write skeleton.
- `local-memory-kv`: deterministic key/value fixture.
- `sidecar-fixture`: sidecar packaging/security fixture.
- `repository-repair-decision-fixture`: deterministic typed Action sequence for
  the exact Agent Actuality application.
- `repository-repair-openai`: fixed-endpoint OpenAI Responses capability with
  strict structured output and receiver-owned secret/model configuration.
- `repository-workspace-actuality`: bounded repository reads, literal search,
  fixed `bun test`, request-bound approval, and one atomic source replacement.

Every Effect v1 pack declares exact interface, schema, and authority identities
in `manifest.json`; application-specific packs also declare admitted
application identities. `agent.invoke.v1` is a receiver-constructed built-in
binding because its child runner is host authority rather than pack data.

Start a new pack from [`templates/capability-v1`](templates/capability-v1/README.md).
Static inspection uses `inspectPack`; executable verification uses
`verifyPack`.

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

The default gate is source-independent. The older checkout-coupled fixture
integration remains available as `bun run proof:v1-checkout-integration`; it is
not part of the release gate.

`corpus:update` and `packs:build` are explicit maintainer commands. They never
run as part of default proof.

See [Effect protocol v1](docs/effect_protocol_v1.md),
[agent invocation](docs/agent_invoke_v1.md), and the
[v0/v1 adapter boundary](docs/v0_v1_adapter.md). The application-specific
Actuality packs are described in
[repository actuality](docs/repository_actuality.md) and
[OpenAI decisions](docs/openai_decision.md).
