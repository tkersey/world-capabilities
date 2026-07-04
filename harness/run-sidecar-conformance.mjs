#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { assert } from "./assertions.mjs";
import { loadPack, validateSidecarCommand, assertNoForbiddenEvidence } from "./pack-utils.mjs";

const pack = await loadPack("sidecar-fixture");
validateSidecarCommand(pack);
const sidecar = pack.manifest.metadata.sidecar;
const proc = spawnSync(sidecar.command[0], sidecar.command.slice(1), {
  cwd: pack.dir,
  input: JSON.stringify({ requestId: "sidecar", payload: { fixture: true } }),
  encoding: "utf8",
  timeout: sidecar.timeoutMs
});

assert(proc.stdout.length <= sidecar.stdoutBytes, "sidecar stdout exceeded bound");
assert(proc.stderr.length <= sidecar.stderrBytes, "sidecar stderr exceeded bound");
assert(proc.status === 0, `sidecar exited ${proc.status}: ${proc.stderr}`);
const output = JSON.parse(proc.stdout);
assertNoForbiddenEvidence(output, "sidecar output");
assert(output.status === "ok", "sidecar fixture did not resolve ok");
console.log("sidecar conformance passed");
