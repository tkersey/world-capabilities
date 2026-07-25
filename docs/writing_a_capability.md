# Writing a Capability

Start from [`templates/capability-v1`](../templates/capability-v1/README.md).
Declare exact Effect v1 interface, payload schema, result schema, authority,
limits, and optional application identities before implementing behavior.

Implement:

```js
export function manifest()
export async function preflight(context, hostRequest)
export async function resolve(context, hostRequest)
export async function recover(context, effectRecord)
export async function dryRun(context, hostRequest)
export async function shadow(context, hostRequest, recordedResolution)
```

`manifest`, `preflight`, `resolve`, and `dryRun` are required. `recover` and
`shadow` may return deterministic unsupported reports.

`preflight` must complete before any external effect. `resolve` returns only an
untrusted bounded outcome for router encoding as `EffectResult`; it must not
return Frame, application state, manifests, receipts, or World/Boundary
evidence.

Use `inspectPack` for inert declaration, checksum, and source inspection.
`inspectPack` does not import the adapter. Use `verifyPack` only when executable
adapter verification is intended.

Do not claim exactly-once effects. Durable automatic use must reject
`best_effort` recovery unless an operator explicitly opts in.
