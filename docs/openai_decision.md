# OpenAI decision capability

`repository-repair-openai` resolves only `model.decide.v1` for the exact Agent
Actuality application and decision contract. It calls the fixed endpoint:

```text
https://api.openai.com/v1/responses
```

The receiver must supply `OPENAI_API_KEY`, an exact `openaiModel`, and policy.
There is no source model default, arbitrary base URL, provider routing, or
automatic retry. The adapter sends one Responses request with strict JSON
Schema output, `store: false`, `background: false`, and an empty tools array.
It never executes a model-produced tool call.

Admission rejects missing secrets or model configuration, allowlist mismatch,
contract drift, non-success responses, timeout, refusal, incomplete or multiple
outputs, malformed JSON, unknown actions, payload-shape differences, and exact
UTF-8 or integer bound violations. Successful JSON is encoded as the compiled
Agent's canonical Boundary Action value before it becomes an EffectResult.

Host claims are redacted to provider, endpoint class, requested and returned
models, token counts, `store: false`, and a SHA-256 digest of the response ID.
They contain no API key, prompt, repository content, raw model output, or full
provider response.

Default proof uses an injected mock fetch and never contacts OpenAI:

```sh
bun run proof:actuality-openai-mock
```

The real network lane is owned by the Agent actuality harness because it must
also drive world-host, the workspace capability, and interactive approval.
