#!/usr/bin/env bun
import { corpusChecksums, corpusFingerprint, writeJson } from "../harness/corpus-utils.mjs";

const checksums = await corpusChecksums();
const fingerprint = await corpusFingerprint();
await writeJson("corpus/agent-runtime-v0.1/checksums.json", checksums);
await writeJson("corpus/agent-runtime-v0.1/expected-fingerprints.json", {
  corpusFingerprint: fingerprint,
  agentRuntimeFingerprint: checksums["corpus/agent-runtime-v0.1/manifest.json"]
});
console.log(`updated corpus fingerprint ${fingerprint}`);
