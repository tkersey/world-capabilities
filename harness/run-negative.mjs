#!/usr/bin/env bun
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles, readJson } from "./corpus-utils.mjs";
import { assert } from "./assertions.mjs";
import { assertNoForbiddenEvidence, importAdapter, loadPack, packageNames } from "./pack-utils.mjs";

async function negativeFixtures() {
  return (await listFiles("corpus/negative")).filter((file) => file.endsWith(".json"));
}

async function loadFixture(path) {
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text);
  if (typeof parsed.rawHostRequest === "string") {
    try {
      JSON.parse(parsed.rawHostRequest);
    } catch {
      return { kind: "raw-rejected" };
    }
    throw new Error(`${path}: rawHostRequest unexpectedly parsed without trailing-byte rejection`);
  }
  return { kind: "host-request", hostRequest: parsed.hostRequest ?? parsed };
}

function basePayloadFor(name) {
  if (name === "fixture-model") return { prompt: "choose fixture action" };
  if (name === "generic-http-json") return { url: "https://example.invalid/fixture", method: "GET" };
  if (name === "human-approval") return { anchor: "world:host-request:1" };
  if (name === "local-memory-kv") return { operation: "put", key: "k", value: "v" };
  if (name === "research-lookup-fixture") {
    return { query: "portable algebraic effects", maximumItems: 2 };
  }
  if (name === "sandbox-files") return { operation: "read", path: "fixture.txt" };
  return { fixture: true };
}

function expectedPayloadReason(fixturePath) {
  if (fixturePath.endsWith("forbidden-world-evidence.json")) return "forbidden_world_evidence";
  if (fixturePath.endsWith("forbidden-evidence-key.json")) return "forbidden_evidence";
  if (fixturePath.endsWith("duplicate-resolution.json")) return "invalid_resolution_state";
  if (fixturePath.endsWith("stale-resolution.json")) return "invalid_resolution_state";
  if (fixturePath.endsWith("malformed-sum-variant.json")) return "malformed_sum_variant";
  if (fixturePath.endsWith("excessive-nesting.json")) return "excessive_nesting";
  if (fixturePath.endsWith("oversized-response.json")) return "oversized_response";
  if (fixturePath.endsWith("secret-shaped-diagnostics.json")) return "secret_shaped_diagnostics";
  return null;
}

function preserveSchema(fixturePath) {
  return fixturePath.endsWith("unsupported-status.json") || fixturePath.endsWith("wrong-response-schema.json");
}

function bindTargetToPack(hostRequest, pack, fixturePath) {
  if (!hostRequest.target?.descriptorFingerprint) return hostRequest;
  return {
    ...hostRequest,
    target: {
      ...hostRequest.target,
      descriptorFingerprint: pack.manifest.supportedDescriptorFingerprints[0],
      actuatorRef: pack.manifest.supportedActuatorRefs[0],
      actuationClass: pack.manifest.supportedActuationClasses[0]
    },
    responseSchema: preserveSchema(fixturePath) ? hostRequest.responseSchema : { statuses: pack.manifest.supportedResponseStatuses },
    payload: { ...basePayloadFor(pack.name), ...(hostRequest.payload ?? {}) }
  };
}

const fixtureRoot = await mkdtemp(join(tmpdir(), "world-negative-"));
try {
  await writeFile(join(fixtureRoot, "fixture.txt"), "fixture");
  for (const name of await packageNames()) {
    const pack = await loadPack(name);
    const adapter = await importAdapter(pack.dir);
    for (const fixturePath of await negativeFixtures()) {
      const fixture = await loadFixture(fixturePath);
      if (fixture.kind === "raw-rejected") continue;
      const context = {
        packageName: pack.manifest.packageName,
        policy: {
          live: true,
          networkLive: true,
          fileWrite: true,
          humanLive: true,
          researchLookup: true
        },
        approvalMode: "allow",
        fixtureRoot,
        effectAttempted: 0
      };
      const result = await adapter.resolve(context, bindTargetToPack(fixture.hostRequest, pack, fixturePath));
      assertNoForbiddenEvidence(result, `${name} ${fixturePath}`);
      assert(["rejected", "failed", "deferred"].includes(result.status), `${name}: negative fixture ${fixturePath} was not rejected/failed/deferred`);
      const expectedReason = expectedPayloadReason(fixturePath);
      if (expectedReason) {
        assert(result.payload?.reason === expectedReason, `${name}: negative fixture ${fixturePath} stopped at ${result.payload?.reason}, expected ${expectedReason}`);
      }
      assert(context.effectAttempted === 0, `${name}: effect attempted for ${fixturePath}`);
      assert(context.kv === undefined, `${name}: memory mutated for ${fixturePath}`);
    }
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

const forbidden = await readJson(join("corpus", "negative", "forbidden-world-evidence.json"));
assert(forbidden.hostRequest.payload.worldAuthoredEvidence, "forbidden evidence fixture missing hostile key");
console.log("negative corpus passed");
