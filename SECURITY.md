# Security policy

Report vulnerabilities through GitHub private vulnerability reporting for
`tkersey/world-capabilities`. Do not put credentials, live provider payloads,
private repository contents, approval tokens, or exploit details in a public
issue.

The supported release lines are `2.1.x` and the latest `2.x` release. Effect
protocol or codec defects should be reported with a minimal synthetic fixture.
Host policy, filesystem, network, provider, secret-handling, or authority
defects should be reported as security issues.

Capability packs receive policy, workspace configuration, approvals, models,
and secrets from the receiver. Repository source, manifests, conformance
fixtures, and public release assets contain no receiver secret. Public source
does not make one receiver's policy universal.

No response-time commitment is made.
