# Capability Pack

Every package includes:

- `manifest.json`
- `adapter.mjs`
- `conformance.json`
- `non-claims.md`
- `README.md`
- `checksums.sha256`

Manifest identity uses descriptor fingerprint, actuator ref, and schema
authority. Display labels are diagnostics only. Pack checksums are artifact
integrity checks, not signatures, and Foundry v0 makes no cryptographic trust
claim.

Every executable adapter artifact and local helper artifact must be covered by
`checksums.sha256`.
