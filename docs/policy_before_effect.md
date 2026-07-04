# Policy Before Effect

No real effect may happen before the host membrane has validated authority.

Every capability must prove that policy, approval, target fingerprint,
idempotency key, schema compatibility, secret availability, redaction setup, and
EffectJournal requirements are known before any effect attempt.

Foundry tests this with trap contexts where malformed inputs and denied policy
must leave `effectAttempted = 0`.
