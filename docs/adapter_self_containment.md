# Adapter Self-Containment

In-process adapters may use static local imports only when every imported file
is checksum-covered and remains inside the pack root. Foundry v0 rejects package
imports, dynamic import, `eval`, direct or indirect `Function` constructors,
unchecked Worker loading, `process.getBuiltinModule`, and host-path imports
outside the pack.

Builtin modules are denied unless the package class explicitly allows them in
manifest metadata. No package registry clients are allowed.
