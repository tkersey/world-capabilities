#!/usr/bin/env bun
import { assertDeepEqual, assertEqual } from "../harness/assertions.mjs";
import { corpusChecksums, corpusFingerprint, readJson } from "../harness/corpus-utils.mjs";

const expectedChecksums = await readJson("corpus/agent-runtime-v0.1/checksums.json");
const expectedFingerprints = await readJson("corpus/agent-runtime-v0.1/expected-fingerprints.json");
assertDeepEqual(await corpusChecksums(), expectedChecksums, "corpus checksums drifted");
assertEqual(await corpusFingerprint(), expectedFingerprints.corpusFingerprint, "corpus fingerprint drifted");
console.log("corpus check passed");
