import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CapabilityRouterV1,
  EffectStatus,
  decodeResearchResponse,
  researchLookupFixtureBinding
} from "../src/v1/index.mjs";
import {
  expectedPackFingerprint,
  importAdapter,
  inspectPack,
  loadPack,
  sha256Bytes
} from "../harness/pack-utils.mjs";
import { stableStringify } from "../harness/assertions.mjs";
import { buildPack } from "../scripts/build-packs.mjs";

const packageRoot = "packages/research-lookup-fixture";
const corpus = JSON.parse(await readFile(`${packageRoot}/corpus.json`, "utf8"));
const requestBytes = Buffer.from(corpus.effectRequestBase64, "base64");

describe("research.lookup.v1 fixture pack", () => {
  it("admits the exact World request before attempting the deterministic effect", async () => {
    const router = new CapabilityRouterV1({
      bindings: [researchLookupFixtureBinding()]
    });
    const deniedContext = context({ researchLookup: false });
    const denied = await router.resolve(deniedContext, requestBytes);
    assert.equal(denied.result.status, EffectStatus.rejected);
    assert.equal(deniedContext.effectAttempted, 0);

    const admittedContext = context({ researchLookup: true });
    const resolved = await router.resolve(admittedContext, requestBytes);
    assert.equal(resolved.result.status, EffectStatus.ok);
    assert.equal(admittedContext.effectAttempted, 1);
    assert.deepEqual(
      normalizeResponse(decodeResearchResponse(resolved.result.resultBytes)),
      corpus.response
    );
  });

  it("accepts compatible receiver response-status supersets", async () => {
    const pack = await loadPack("research-lookup-fixture");
    const adapter = await importAdapter(pack.dir);
    const request = {
      requestId: "research-response-schema-superset",
      idempotencyKey: "world:idem:research-response-schema-superset",
      target: {
        descriptorFingerprint: pack.manifest.supportedDescriptorFingerprints[0],
        actuatorRef: pack.manifest.supportedActuatorRefs[0],
        actuationClass: pack.manifest.supportedActuationClasses[0]
      },
      responseSchema: {
        statuses: [...pack.manifest.supportedResponseStatuses, "extra-compatible-status"]
      },
      payload: {
        query: corpus.request.query,
        maximumItems: BigInt(corpus.request.maximumItems)
      }
    };

    const admitted = await adapter.preflight(
      context({ researchLookup: true }),
      request
    );
    assert.equal(admitted.status, "ok");
  });

  it("rejects a request below the fixture's exact two-item response cardinality", async () => {
    const pack = await loadPack("research-lookup-fixture");
    const adapter = await importAdapter(pack.dir);
    const rejected = await adapter.preflight(
      context({ researchLookup: true }),
      {
        requestId: "research-one-item",
        idempotencyKey: "world:idem:research-one-item",
        target: {
          descriptorFingerprint: pack.manifest.supportedDescriptorFingerprints[0],
          actuatorRef: pack.manifest.supportedActuatorRefs[0],
          actuationClass: pack.manifest.supportedActuationClasses[0]
        },
        responseSchema: {
          statuses: pack.manifest.supportedResponseStatuses
        },
        payload: {
          query: corpus.request.query,
          maximumItems: 1n
        }
      }
    );

    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.payload.reason, "invalid_maximum_items");
  });

  it("rejects malformed payload bytes before adapter preflight or effect", async () => {
    let preflightCalls = 0;
    let effectCalls = 0;
    const binding = researchLookupFixtureBinding({
      adapter: {
        preflight: async () => {
          preflightCalls += 1;
          throw new Error("preflight must not receive malformed payload");
        },
        resolve: async () => {
          effectCalls += 1;
          throw new Error("effect must not receive malformed payload");
        }
      }
    });
    const malformed = Buffer.from(requestBytes);
    malformed[233] = 0xff;
    resealRequest(malformed);
    const router = new CapabilityRouterV1({ bindings: [binding] });

    await assert.rejects(
      () => router.resolve(context({ researchLookup: true }), malformed),
      { code: "ERR_CAPABILITY_V1_RESEARCH_REQUEST" }
    );
    assert.equal(preflightCalls, 0);
    assert.equal(effectCalls, 0);
  });

  it("rejects exact-identity drift in schema, application, and request", async () => {
    const router = new CapabilityRouterV1({
      bindings: [researchLookupFixtureBinding()]
    });

    const wrongSchema = Buffer.from(requestBytes);
    wrongSchema[160] ^= 1;
    resealRequest(wrongSchema);
    await assert.rejects(
      () => router.resolve(context({ researchLookup: true }), wrongSchema),
      { code: "ERR_CAPABILITY_V1_SCHEMA_MISMATCH" }
    );

    const wrongApplication = Buffer.from(requestBytes);
    wrongApplication[44] ^= 1;
    resealRequest(wrongApplication);
    await assert.rejects(
      () => router.resolve(context({ researchLookup: true }), wrongApplication),
      { code: "ERR_CAPABILITY_V1_APPLICATION_MISMATCH" }
    );

    const wrongRequest = Buffer.from(requestBytes);
    wrongRequest[12] ^= 1;
    await assert.rejects(
      () => router.resolve(context({ researchLookup: true }), wrongRequest),
      { code: "ERR_CAPABILITY_V1_REQUEST_IDENTITY" }
    );
  });

  it("rejects excessive results and capability-authored World evidence", async () => {
    const huge = "x".repeat(64 * 1024);
    const excessive = researchLookupFixtureBinding({
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {
            first: { title: huge, summary: huge },
            second: { title: huge, summary: huge },
            digestResult: { digest: huge, itemCount: 2n }
          }
        })
      }
    });
    await assert.rejects(
      () => new CapabilityRouterV1({ bindings: [excessive] })
        .resolve(context({ researchLookup: true }), requestBytes),
      { code: "ERR_CAPABILITY_V1_RESULT" }
    );

    const evidence = researchLookupFixtureBinding({
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: corpus.response,
          frameBytes: Buffer.from("forbidden")
        })
      }
    });
    await assert.rejects(
      () => new CapabilityRouterV1({ bindings: [evidence] })
        .resolve(context({ researchLookup: true }), requestBytes),
      { code: "ERR_CAPABILITY_V1_WORLD_EVIDENCE" }
    );
  });

  it("reuses the retained EffectResult on deterministic retry", async () => {
    const router = new CapabilityRouterV1({
      bindings: [researchLookupFixtureBinding()]
    });
    const retained = new Map();
    const effectContext = context({ researchLookup: true });
    const first = await resolveRetained(router, effectContext, retained);
    const retried = await resolveRetained(router, effectContext, retained);

    assert.equal(effectContext.effectAttempted, 1);
    assert.deepEqual(first.result.encodedBytes, retried.result.encodedBytes);
  });

  it("statically inspects pack source without executing its adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "research-lookup-static-pack-"));
    try {
      const dir = join(root, "research-lookup-fixture");
      await cp(packageRoot, dir, { recursive: true });
      const poisoned = "throw new Error(\"adapter executed\");\n";
      await writeFile(join(dir, "adapter.mjs"), poisoned);
      const pack = await loadPack("research-lookup-fixture", root);
      pack.manifest.checksums["adapter.mjs"] = sha256Bytes(Buffer.from(poisoned));
      await writeFile(
        join(dir, "manifest.json"),
        `${stableStringify(pack.manifest)}\n`
      );
      await writeFile(
        join(dir, "checksums.sha256"),
        Object.entries(pack.manifest.checksums)
          .map(([path, checksum]) => `${checksum}  ${path}`)
          .join("\n") + "\n"
      );

      await assert.rejects(
        async () => inspectPack(await loadPack("research-lookup-fixture", root)),
        /pack fingerprint mismatch/
      );
      pack.manifest.packFingerprint = await expectedPackFingerprint(pack);
      await writeFile(
        join(dir, "manifest.json"),
        `${stableStringify(pack.manifest)}\n`
      );
      await inspectPack(await loadPack("research-lookup-fixture", root));
      await assert.rejects(
        () => importAdapter(dir),
        /adapter executed/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds its conformance receipt to the exact pack and fixture corpus", async () => {
    const pack = await loadPack("research-lookup-fixture");
    const receipt = JSON.parse(
      await readFile(`${packageRoot}/conformance-receipt.json`, "utf8")
    );
    const corpusFingerprint = sha256Bytes(
      await readFile(`${packageRoot}/corpus.json`)
    );
    const vectorIds = pack.conformance.vectors.map((vector) => vector.id);

    assert.equal(pack.manifest.packFingerprint, await expectedPackFingerprint(pack));
    assert.equal(receipt.packFingerprint, pack.manifest.packFingerprint);
    assert.equal(receipt.corpusFingerprint, corpusFingerprint);
    assert.equal(
      receipt.globalConformanceCorpusFingerprint,
      pack.manifest.conformanceCorpusFingerprint
    );
    assert.deepEqual(receipt.vectors, vectorIds);
    assert.equal(receipt.receiptFingerprint, receiptFingerprint(receipt));
  });

  it("regenerates the conformance receipt when a pack artifact changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "research-lookup-build-pack-"));
    try {
      const dir = join(root, "research-lookup-fixture");
      await cp(packageRoot, dir, { recursive: true });
      const originalReceipt = JSON.parse(
        await readFile(join(dir, "conformance-receipt.json"), "utf8")
      );
      await writeFile(
        join(dir, "adapter.mjs"),
        `${await readFile(join(dir, "adapter.mjs"), "utf8")}\n// rebuilt fixture\n`
      );
      const globalCorpusFingerprint = (
        await loadPack("research-lookup-fixture")
      ).manifest.conformanceCorpusFingerprint;

      await buildPack("research-lookup-fixture", {
        root,
        globalCorpusFingerprint
      });

      const rebuiltPack = await loadPack("research-lookup-fixture", root);
      const rebuiltReceipt = JSON.parse(
        await readFile(join(dir, "conformance-receipt.json"), "utf8")
      );
      assert.notEqual(rebuiltPack.manifest.packFingerprint, originalReceipt.packFingerprint);
      assert.equal(rebuiltReceipt.packFingerprint, rebuiltPack.manifest.packFingerprint);
      assert.equal(
        rebuiltReceipt.corpusFingerprint,
        rebuiltPack.manifest.checksums["corpus.json"]
      );
      assert.equal(
        rebuiltReceipt.globalConformanceCorpusFingerprint,
        globalCorpusFingerprint
      );
      assert.equal(rebuiltReceipt.receiptFingerprint, receiptFingerprint(rebuiltReceipt));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function context(policy) {
  return {
    policy,
    effectAttempted: 0,
    attempt: 1
  };
}

async function resolveRetained(router, effectContext, retained) {
  const inspected = router.inspect(requestBytes);
  const key = Buffer.from(inspected.request.requestId).toString("hex");
  if (retained.has(key)) return retained.get(key);
  const resolved = await router.resolve(effectContext, requestBytes);
  retained.set(key, resolved);
  return resolved;
}

function normalizeResponse(value) {
  return {
    ...value,
    digestResult: {
      ...value.digestResult,
      itemCount: value.digestResult.itemCount.toString()
    }
  };
}

function receiptFingerprint(receipt) {
  const material = { ...receipt, receiptFingerprint: "" };
  return createHash("sha256")
    .update("world.effect-v1-conformance-receipt.v1")
    .update(Buffer.from([0]))
    .update(stableStringify(material))
    .digest("hex");
}

function resealRequest(bytes) {
  bytes.fill(0, 12, 44);
  bytes.fill(0, bytes.length - 48, bytes.length - 16);
  const requestId = createHash("sha256")
    .update("world.effect-request.v1")
    .update(Buffer.from([0]))
    .update(bytes)
    .digest();
  requestId.copy(bytes, 12);
  const interfaceId = bytes.subarray(128, 160);
  const applicationId = bytes.subarray(44, 76);
  const idempotencyKey = createHash("sha256")
    .update("world.idempotency-key.v1")
    .update(Buffer.from([0]))
    .update(requestId)
    .update(interfaceId)
    .update(applicationId)
    .digest();
  idempotencyKey.copy(bytes, bytes.length - 48);
}
