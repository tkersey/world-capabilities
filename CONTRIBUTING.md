# Contributing

Use Bun 1.3.14 or newer and run:

```sh
bun test
bun run check
bun run proof
bun run check:public-deterministic-v1
```

Never commit credentials, live provider transcripts, private repository data,
receiver policy, runtime stores, or owner-local paths. Fixtures must be
synthetic, deterministic, bounded, and safe to publish.

Capabilities may author only untrusted Effect v1 results. They may not author
Frames, World evidence, Machine state, or application policy. Policy and exact
application/schema/authority admission must complete before an external effect.

Pull requests from forks run without secrets. Live provider tests and mutation
against non-temporary workspaces never run for untrusted pull requests.
