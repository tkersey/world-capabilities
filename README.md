# world-capabilities

`world-capabilities` is the public reference Effect protocol v1 Foundry: a
router, portable codecs, capability packs, application-specific bindings, and
conformance for World applications.

Boundary owns portable computation. World owns Application ABI v1 and Frame
v1. world-host retains lifecycle evidence and dispatches effects.
world-capabilities applies receiver policy before external authority and returns
only untrusted EffectResults. It cannot author Frames, Machine state, or World
evidence.

## Capability classes

- Deterministic packs use synthetic fixtures and require no receiver secret.
- Live packs, including `repository-repair-openai`, receive provider secrets,
  model selection, allowlists, and policy from the receiver.
- Application-specific packs bind exact application, interface, schema, result
  bound, and authority identities.

The source repository and deterministic conformance release contain no receiver
secret, live provider transcript, runtime store, or private policy.

## Public deterministic distribution

Release `v2.1.2` publishes:

```text
world-capabilities-v2.1.2-deterministic.tar.gz
world-capabilities-v2.1.2-deterministic.tar.gz.sha256
```

The stable release URL is:

```text
https://github.com/tkersey/world-capabilities/releases/download/v2.1.2/world-capabilities-v2.1.2-deterministic.tar.gz
```

The archive contains the Effect v1 router/codecs, checksum-bound packs,
synthetic corpora, static pack inspection, and deterministic conformance. The
packaged verifier runs without a source checkout, GitHub authentication,
GitHub CLI, or receiver secret:

```sh
(cd .. && shasum -a 256 -c world-capabilities-v2.1.2-deterministic.tar.gz.sha256)
bun conformance/check-distribution.mjs --root .
bun conformance/run-conformance.mjs \
  --archive ../world-capabilities-v2.1.2-deterministic.tar.gz \
  --checksum ../world-capabilities-v2.1.2-deterministic.tar.gz.sha256
```

From a source checkout:

```sh
bun --version
bun test
bun run check
bun run check:public-deterministic-v1
bun run conformance:public-deterministic-v1
```

Static inspection does not import adapters. Executable conformance separately
proves deterministic adapter execution, policy-before-effect, exact
application/schema/authority admission, result bounds, forbidden World
evidence rejection, and absence of Frame authority.

## Included packs

- `research-lookup-fixture`, bound to the exact Research Digest artifact from
  World `v3.0.0`
- `fixture-model`
- `generic-http-json`
- `human-approval`
- `sandbox-files`
- `local-memory-kv`
- `sidecar-fixture`
- `repository-repair-decision-fixture`
- `repository-repair-openai`
- `repository-workspace-actuality`

Every Effect v1 pack declares exact identities in `manifest.json`.
`agent.invoke.v1` remains a receiver-constructed built-in binding because its
child runner is host authority rather than pack data.

Start a pack from [`templates/capability-v1`](templates/capability-v1/README.md).
See [Effect protocol v1](docs/effect_protocol_v1.md),
[agent invocation](docs/agent_invoke_v1.md),
[repository actuality](docs/repository_actuality.md), and
[OpenAI decisions](docs/openai_decision.md).

## Non-claims

This is a reference implementation; Effect v1 permits alternate capability
implementations. Live model execution requires credentials. Receiver policy is
local. The repository makes no exactly-once, hostile-host, or prompt-injection
immunity claim.
