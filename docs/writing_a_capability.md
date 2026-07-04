# Writing a Capability

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

Do not claim exactly-once effects. Durable automatic use must reject
`best_effort` recovery unless an operator explicitly opts in.
