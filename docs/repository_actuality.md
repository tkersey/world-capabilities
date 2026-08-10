# Repository Actuality capability

`repository-workspace-actuality` resolves the exact repository effects emitted
by application
`26f5ab2b7e86994e5d3b234bb32447891906276853c094f0ac73def2b99610bb`.
It is not a general repository or shell capability.

Receiver context supplies the real workspace root, policy, approval, temporary
HOME, and exact Bun executable. The adapter resolves and retains the root
identity, rejects absolute paths and traversal, follows no symlinks, and admits
only regular UTF-8 files under `README.md`, `package.json`, `src`, and `test`.
Only `src/range.mjs` is writable.

The pack provides bounded listing, reads with SHA-256, deterministic literal
search, and one fixed process operation:

```text
executable = receiver Bun
argv       = ["test"]
cwd        = admitted workspace root
shell      = false
```

The adapter has no arbitrary executable, argv, environment, or shell surface.
Its pack manifest declares the exact fixed-process exception so static Foundry
inspection continues to reject `node:child_process` from every other ordinary
pack.

Replacement admission binds the receiver approval to the exact EffectRequest
and proposal digest. The adapter checks the expected current SHA-256, writes a
same-directory temporary file, renames it atomically, and verifies the final
digest. If the current digest already equals the replacement digest it returns
`alreadyApplied` without a second write; any other mismatch is a typed
conflict.

The capability returns only an Effect outcome. It cannot author World Frames,
Boundary state, branch heads, or application results.

```sh
bun run proof:actuality-workspace
```
