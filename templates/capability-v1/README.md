# Effect v1 capability pack template

Copy this directory to `packages/<pack-name>/`, then replace every
`__PLACEHOLDER__` value with reviewed identities and limits.

The manifest is inert authority data. Declare exact interface, payload schema,
result schema, authority, and optional application identities. Keep adapter
execution out of inspection; `inspectPack` reads and validates source,
checksums, and declarations without importing the adapter.

Keep `applicationIds` only when the pack is intentionally bound to exact
application identities. Remove that field when the pack is reusable across
conformant applications.

The adapter receives only the receiver’s projected effect request. It must run
policy and admission checks before any effect, return a bounded untrusted
outcome, and never emit Frame, application-state, manifest, Boundary, or World
evidence fields.

After authoring:

```text
bun run packs:build
bun run proof:packs
bun run proof:negative
bun run proof:policy
```

Add executable tests for every declared conformance vector. Do not mark a
vector passed from manifest inspection alone.
