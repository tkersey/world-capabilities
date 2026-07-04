# world-capabilities

`world-capabilities` is the monorepo for host-side capability packs that resolve
World HostRequests under receiver-local policy.

Boundary defines the program.
World interprets and records the program.
world-host operates the process and capability membrane.
world-capabilities supplies conformant effect handlers.

This repository is private initially. PR #5 builds the Capability Plane
membrane. `world-capabilities` pressure-tests and populates that membrane while
staying compatible with the final PR #5 surface after it lands.

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
bun run corpus:check
```

`corpus:update` and `packs:build` are explicit maintainer commands. They never
run as part of default proof.
