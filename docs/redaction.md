# Redaction

Diagnostics and reports are untrusted operational data. Foundry redacts
token/password/api-key-shaped strings, `sk-...` shaped values, nested object
values, arrays, and diagnostic strings before they can be reported.

Secret-shaped strings under non-secret keys are still redacted.
