# Sidecar Security

Sidecar entrypoints and helpers must be checksum-covered. Remote URLs, Deno
remote URLs, package runners, eval flags, unchecked preload flags, bare
unchecked executables, unbounded stdout/stderr, and timeout-free execution are
rejected.

Allowed runtime executables in Foundry v0 are `node`, `bun`, and `deno` when the
entrypoint is artifact-bound.
