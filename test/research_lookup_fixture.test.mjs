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
  encodeResearchResponse,
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

describe("research.lookup.v2 fixture pack", () => {
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
      decodeResearchResponse(resolved.result.resultBytes),
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
        maximumItems: corpus.request.maximumItems
      }
    };

    const admitted = await adapter.preflight(
      context({ researchLookup: true }),
      request
    );
    assert.equal(admitted.status, "ok");
  });

  it("treats maximumItems as an upper bound on the fixture response", async () => {
    const pack = await loadPack("research-lookup-fixture");
    const adapter = await importAdapter(pack.dir);
    for (const maximumItems of [0, 1, 2, 3, 0xffff_ffff]) {
      const request = {
        requestId: `research-${maximumItems}-items`,
        idempotencyKey: `world:idem:research-${maximumItems}-items`,
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
          maximumItems
        }
      };
      const admitted = await adapter.preflight(
        context({ researchLookup: true }),
        request
      );
      assert.equal(admitted.status, "ok");

      const resolved = await adapter.resolve(
        context({ researchLookup: true }),
        request
      );
      assert.equal(resolved.status, "ok");
      assert.deepEqual(
        resolved.payload.items,
        corpus.response.items.slice(0, maximumItems)
      );
      assert.ok(resolved.payload.items.length <= maximumItems);
    }

    for (const maximumItems of [-1, 1.5, 0x1_0000_0000]) {
      const rejected = await adapter.preflight(
        context({ researchLookup: true }),
        {
          requestId: `research-invalid-${maximumItems}`,
          idempotencyKey: `world:idem:research-invalid-${maximumItems}`,
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
            maximumItems
          }
        }
      );

      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.payload.reason, "invalid_maximum_items");
    }
  });

  it("binds the response to the admitted request limit snapshot", async () => {
    const pack = await loadPack("research-lookup-fixture");
    const adapter = await importAdapter(pack.dir);
    const request = {
      requestId: "research-request-limit-snapshot",
      idempotencyKey: "world:idem:research-request-limit-snapshot",
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
        maximumItems: 0
      }
    };

    const pending = adapter.resolve(
      context({ researchLookup: true }),
      request
    );
    request.payload.maximumItems = 2;

    const resolved = await pending;
    assert.equal(resolved.status, "ok");
    assert.deepEqual(resolved.payload.items, []);
  });

  it("binds an accessor-backed request limit to one admitted value", async () => {
    const pack = await loadPack("research-lookup-fixture");
    const adapter = await importAdapter(pack.dir);
    let getterCalls = 0;
    const request = {
      requestId: "research-accessor-backed-request-limit",
      idempotencyKey: "world:idem:research-accessor-backed-request-limit",
      target: {
        descriptorFingerprint: pack.manifest.supportedDescriptorFingerprints[0],
        actuatorRef: pack.manifest.supportedActuatorRefs[0],
        actuationClass: pack.manifest.supportedActuationClasses[0]
      },
      responseSchema: {
        statuses: pack.manifest.supportedResponseStatuses
      },
      payload: {
        query: corpus.request.query
      }
    };
    Object.defineProperty(request.payload, "maximumItems", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return getterCalls === 1 ? 0 : 2;
      }
    });
    const effectContext = context({ researchLookup: true });

    const resolved = await adapter.resolve(effectContext, request);

    assert.equal(resolved.status, "ok");
    assert.deepEqual(resolved.payload.items, []);
    assert.equal(getterCalls, 1);
    assert.equal(effectContext.effectAttempted, 1);
  });

  it("checks policy before taking the payload snapshot", async () => {
    const pack = await loadPack("research-lookup-fixture");
    const adapter = await importAdapter(pack.dir);
    let getterCalls = 0;
    const request = {
      requestId: "research-policy-before-payload-snapshot",
      idempotencyKey: "world:idem:research-policy-before-payload-snapshot",
      target: {
        descriptorFingerprint: pack.manifest.supportedDescriptorFingerprints[0],
        actuatorRef: pack.manifest.supportedActuatorRefs[0],
        actuationClass: pack.manifest.supportedActuationClasses[0]
      },
      responseSchema: {
        statuses: pack.manifest.supportedResponseStatuses
      },
      payload: {
        query: corpus.request.query
      }
    };
    Object.defineProperty(request.payload, "maximumItems", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("payload getter must not run before policy admission");
      }
    });

    const rejected = await adapter.preflight(
      context({ researchLookup: false }),
      request
    );

    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.payload.reason, "research_lookup_policy_required");
    assert.equal(getterCalls, 0);
  });

  it("rejects adapter results above the request-specific item ceiling", async () => {
    const excessive = researchLookupFixtureBinding({
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async (effectContext, request) => {
          effectContext.effectAttempted += 1;
          return {
            requestId: request.requestId,
            status: "ok",
            payload: {
              items: [
                ...corpus.response.items,
                corpus.response.items[0]
              ]
            }
          };
        }
      }
    });
    const effectContext = context({ researchLookup: true });

    await assert.rejects(
      () => new CapabilityRouterV1({ bindings: [excessive] })
        .resolve(effectContext, requestBytes),
      { code: "ERR_CAPABILITY_V1_RESEARCH_RESPONSE" }
    );
    assert.equal(effectContext.effectAttempted, 1);
  });

  it("requires an explicit request limit at the public response encoder", () => {
    assert.throws(
      () => encodeResearchResponse(corpus.response),
      { code: "ERR_CAPABILITY_V1_RESEARCH_RESPONSE" }
    );
    assert.deepEqual(
      decodeResearchResponse(encodeResearchResponse(
        corpus.response,
        corpus.request.maximumItems
      )),
      corpus.response
    );
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
    const wrongSchemaContext = context({ researchLookup: true });
    await assert.rejects(
      () => router.resolve(wrongSchemaContext, wrongSchema),
      { code: "ERR_CAPABILITY_V1_SCHEMA_MISMATCH" }
    );
    assert.equal(wrongSchemaContext.effectAttempted, 0);

    const wrongResultSchema = Buffer.from(requestBytes);
    wrongResultSchema[192] ^= 1;
    resealRequest(wrongResultSchema);
    const wrongResultSchemaContext = context({ researchLookup: true });
    await assert.rejects(
      () => router.resolve(wrongResultSchemaContext, wrongResultSchema),
      { code: "ERR_CAPABILITY_V1_SCHEMA_MISMATCH" }
    );
    assert.equal(wrongResultSchemaContext.effectAttempted, 0);

    const wrongApplication = Buffer.from(requestBytes);
    wrongApplication[44] ^= 1;
    resealRequest(wrongApplication);
    const wrongApplicationContext = context({ researchLookup: true });
    await assert.rejects(
      () => router.resolve(wrongApplicationContext, wrongApplication),
      { code: "ERR_CAPABILITY_V1_APPLICATION_MISMATCH" }
    );
    assert.equal(wrongApplicationContext.effectAttempted, 0);

    const wrongRequest = Buffer.from(requestBytes);
    wrongRequest[12] ^= 1;
    await assert.rejects(
      () => router.resolve(context({ researchLookup: true }), wrongRequest),
      { code: "ERR_CAPABILITY_V1_REQUEST_IDENTITY" }
    );
  });

  it("names the exact published World release in capability documentation", async () => {
    const releaseLabel = `World \`${corpus.worldRelease.tag}\``;
    const documentation = await Promise.all([
      readFile("README.md", "utf8"),
      readFile(`${packageRoot}/README.md`, "utf8"),
      readFile(`${packageRoot}/non-claims.md`, "utf8")
    ]);

    for (const source of documentation) {
      assert.ok(source.includes(releaseLabel));
    }
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
          payload: { items: [{ title: huge, summary: huge }] }
        })
      }
    });
    await assert.rejects(
      () => new CapabilityRouterV1({ bindings: [excessive] })
        .resolve(context({ researchLookup: true }), requestBytes),
      { code: "ERR_CAPABILITY_V1_RESEARCH_RESPONSE" }
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

  it("rejects router accessors without executing self-sanitizing getters", async () => {
    let getterCalls = 0;
    const payload = {};
    Object.defineProperty(payload, "items", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        delete payload.frameBytes;
        Object.defineProperty(payload, "items", {
          configurable: true,
          enumerable: true,
          value: corpus.response.items
        });
        return corpus.response.items;
      }
    });
    payload.frameBytes = Buffer.from("forbidden");
    const binding = researchLookupFixtureBinding({
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload
        })
      }
    });

    await assert.rejects(
      () => new CapabilityRouterV1({ bindings: [binding] })
        .resolve(context({ researchLookup: true }), requestBytes),
      { code: "ERR_CAPABILITY_V1_OUTCOME" }
    );
    assert.equal(getterCalls, 0);
  });

  it("rejects every sparse response position with the owned codec error", () => {
    for (let length = 1; length <= 8; length += 1) {
      for (let hole = 0; hole < length; hole += 1) {
        const items = Array.from(
          { length },
          (_, index) => index === hole ? undefined : corpus.response.items[0]
        );
        delete items[hole];
        const ownKeys = Object.keys(items);

        assert.throws(
          () => encodeResearchResponse({ items }, 8),
          { code: "ERR_CAPABILITY_V1_RESEARCH_RESPONSE" }
        );
        assert.equal(items.length, length);
        assert.deepEqual(Object.keys(items), ownKeys);
      }
    }
  });

  it("rejects a sparse adapter response before EffectResult publication", async () => {
    const sparse = researchLookupFixtureBinding({
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async (effectContext, request) => {
          effectContext.effectAttempted += 1;
          return {
            requestId: request.requestId,
            status: "ok",
            payload: { items: Array(1) }
          };
        }
      }
    });
    const effectContext = context({ researchLookup: true });

    await assert.rejects(
      () => new CapabilityRouterV1({ bindings: [sparse] })
        .resolve(effectContext, requestBytes),
      { code: "ERR_CAPABILITY_V1_RESEARCH_RESPONSE" }
    );
    assert.equal(effectContext.effectAttempted, 1);
  });

  it("requires exact items vector keys without invoking extension authority", () => {
    assert.deepEqual(
      decodeResearchResponse(encodeResearchResponse({
        items: [corpus.response.items[0]]
      }, 8)),
      { items: [corpus.response.items[0]] }
    );

    let iteratorCalls = 0;
    const withIterator = [corpus.response.items[0]];
    Object.defineProperty(withIterator, Symbol.iterator, {
      value: function* () {
        iteratorCalls += 1;
        yield corpus.response.items[0];
      }
    });
    const withString = [corpus.response.items[0]];
    Object.defineProperty(withString, "rendered", { value: "forbidden" });
    const withSymbol = [corpus.response.items[0]];
    Object.defineProperty(withSymbol, Symbol("forbidden"), { value: true });
    for (const items of [withIterator, withString, withSymbol]) {
      assert.throws(
        () => encodeResearchResponse({ items }, 8),
        { code: "ERR_CAPABILITY_V1_RESEARCH_RESPONSE" }
      );
    }
    assert.equal(iteratorCalls, 0);

    const throwing = [corpus.response.items[0]];
    Object.defineProperty(throwing, 0, {
      get: () => { throw new Error("adapter getter failed"); }
    });
    assert.throws(
      () => encodeResearchResponse({ items: throwing }, 8),
      { code: "ERR_CAPABILITY_V1_RESEARCH_RESPONSE" }
    );
  });

  it("rejects inherited ResearchItems at sparse array positions", () => {
    const items = Array(1);
    Object.setPrototypeOf(items, { 0: corpus.response.items[0] });

    assert.throws(
      () => encodeResearchResponse({ items }, 8),
      { code: "ERR_CAPABILITY_V1_RESEARCH_RESPONSE" }
    );
  });

  it("rejects polluted descriptor map entries for sparse response positions", () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "0");
    Object.defineProperty(Object.prototype, "0", {
      configurable: true,
      value: { value: corpus.response.items[0] }
    });
    try {
      assert.throws(
        () => encodeResearchResponse({ items: Array(1) }, 8),
        { code: "ERR_CAPABILITY_V1_RESEARCH_RESPONSE" }
      );
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "0", previous);
      else delete Object.prototype[0];
    }
  });

  it("preserves a leading BOM scalar in every ResearchItem Text field", () => {
    const response = {
      items: [{ title: "\uFEFFtitle", summary: "\uFEFFsummary" }]
    };

    assert.deepEqual(
      decodeResearchResponse(encodeResearchResponse(response, 8)),
      response
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

  it("rejects every non-items-only response product", async () => {
    const invalidPayloads = [
      { items: corpus.response.items, rendered: "forbidden" },
      {
        items: [
          { ...corpus.response.items[0], rank: 1 },
          corpus.response.items[1]
        ]
      }
    ];

    for (const payload of invalidPayloads) {
      const binding = researchLookupFixtureBinding({
        adapter: {
          preflight: async (_context, request) => ({
            requestId: request.requestId,
            status: "ok",
            payload: {}
          }),
          resolve: async (effectContext, request) => {
            effectContext.effectAttempted += 1;
            return {
              requestId: request.requestId,
              status: "ok",
              payload
            };
          }
        }
      });
      const effectContext = context({ researchLookup: true });

      await assert.rejects(
        () => new CapabilityRouterV1({ bindings: [binding] })
          .resolve(effectContext, requestBytes),
        { code: "ERR_CAPABILITY_V1_RESEARCH_RESPONSE" }
      );
      assert.equal(effectContext.effectAttempted, 1);
    }
  });

  it("compares the complete own-key set for exact response products", () => {
    const hiddenItems = { rendered: "forbidden" };
    Object.defineProperty(hiddenItems, "items", {
      value: corpus.response.items,
      enumerable: false
    });

    const hiddenFields = { rank: 1, rendered: "forbidden" };
    Object.defineProperties(hiddenFields, {
      title: { value: corpus.response.items[0].title, enumerable: false },
      summary: { value: corpus.response.items[0].summary, enumerable: false }
    });

    const symbolField = {
      items: corpus.response.items,
      [Symbol("forbidden")]: true
    };

    for (const response of [hiddenItems, { items: [hiddenFields] }, symbolField]) {
      assert.throws(
        () => encodeResearchResponse(response, 8),
        { code: "ERR_CAPABILITY_V1_RESEARCH_RESPONSE" }
      );
    }
  });

  it("rejects accessor-backed response state without executing getters", () => {
    let getterCalls = 0;
    const accessorResponse = {};
    Object.defineProperty(accessorResponse, "items", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        accessorResponse.rendered = "forbidden";
        return corpus.response.items;
      }
    });

    const accessorItem = { summary: corpus.response.items[0].summary };
    Object.defineProperty(accessorItem, "title", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        accessorItem.rank = 1;
        return corpus.response.items[0].title;
      }
    });

    const accessorItems = [];
    Object.defineProperty(accessorItems, 0, {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        accessorItems.rendered = "forbidden";
        return corpus.response.items[0];
      }
    });
    accessorItems.length = 1;

    for (const response of [
      accessorResponse,
      { items: [accessorItem] },
      { items: accessorItems }
    ]) {
      assert.throws(
        () => encodeResearchResponse(response, 8),
        { code: "ERR_CAPABILITY_V1_RESEARCH_RESPONSE" }
      );
    }
    assert.equal(getterCalls, 0);
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
