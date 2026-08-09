# Research Lookup Fixture

`research-lookup-fixture` implements only `research.lookup.v2` for the
Research Digest application in World `v3.0.0`.

The pack is deterministic, bounded, network-free, secret-free, and
application-identity-bound. It accepts one typed request for at most two
research items and returns only the bounded `ResearchItem` vector recorded in
`corpus.json`. The Boundary Machine, not this capability, formats the digest.

The receiver must admit the package and set `policy.researchLookup=true`
before resolution. Static pack inspection reads declarations, checksums, and
source without importing `adapter.mjs`.

The pack never receives application state and cannot author Frames,
application manifests, World evidence, or Boundary evidence.
