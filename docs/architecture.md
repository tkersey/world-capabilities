# Architecture

Capabilities are host-side effect handlers.

Boundary defines the program. World validates and records the effect outcome.
world-host controls the receiver-local capability membrane. world-capabilities
supplies conformant adapter packages.

Foundry v0 is a downstream pressure test for world-host PR #5. It keeps pack
shape, policy checks, sidecar constraints, and hostile fixtures outside
Boundary, World, and world-host core.

Packs return untrusted ResolutionInput-like records. They do not author World
receipts, TurnClosures, capsules, Chronicle events, archive append batches,
actuation receipts, Boundary modules, or executable images.
