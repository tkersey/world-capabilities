# Why Capabilities

The runtime needs replaceable host-owned adapters without turning world-host
core into a monolith. Capability packs let model, file, tool, approval, and
sidecar integrations live in one external monorepo while preserving the evidence
authority boundary.

No real integrations live in Boundary or World. Foundry v0 also avoids real
vendor SDKs so the package membrane can stabilize before provider packages
exist.
