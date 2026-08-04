import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  CapabilityRouterV1,
  EffectStatus,
  createEffectResult,
  decodeEffectRequest,
  decodeEffectResult,
  decodeJsonStringValue,
  decodeStringValue,
  effectInterfaceId,
  encodeJsonStringValue,
  stringValueSchemaId
} from "../src/v1/index.mjs";

const REQUEST = Buffer.from("V1JMREVSUTEBAAAAzsv4PjOqIpx6fIhz3PpQIQfQBpBJgGPl/ZhB61sPIQ60PALu7Q1toJPlzqEcNzWLUTkSdG2wFdviJDPdp75bkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+PnsVNnMCk9QDrj7fk3SRRxHDJ8DAxdOz9pTKNio+HV23O/j1AZsz8DHR/oIjlOnjt+QHPbZ/H394AGV4uxYoW+JHLOqyVGCqBl1l5Nu/Snak4YmG3Lyvx64Rbugn7b+3Kp04wMkjDMXCwAAAAcAAABwYXlsb2Fk9+yRHaSj2v0yozJM8OeKhy9t02kvUfN8O1szV59ej9cBAAAAAAAAAAAAEAADAAAA", "base64");

describe("World Effect protocol v1", () => {
  it("decodes and authenticates a World-produced request", () => {
    const request = decodeEffectRequest(REQUEST);

    assert.deepEqual(request.interfaceId, effectInterfaceId("test.one-effect.v1"));
    assert.deepEqual(request.payloadSchemaId, stringValueSchemaId());
    assert.equal(decodeStringValue(request.payloadBytes), "payload");
  });

  it("authors only an identity-valid EffectResult", () => {
    const request = decodeEffectRequest(REQUEST);
    const resultBytes = Buffer.alloc(8);
    resultBytes.writeBigInt64LE(41n);
    const result = createEffectResult({
      requestId: request.requestId,
      status: EffectStatus.ok,
      resultSchemaId: request.resultSchemaId,
      resultBytes
    });
    const decoded = decodeEffectResult(result.encodedBytes);

    assert.equal(decoded.status, EffectStatus.ok);
    assert.equal(decoded.resultBytes.readBigInt64LE(), 41n);
  });

  it("rejects request and result identity tampering", () => {
    const request = Buffer.from(REQUEST);
    request[12] ^= 1;
    assert.throws(() => decodeEffectRequest(request), { code: "ERR_CAPABILITY_V1_REQUEST_IDENTITY" });

    const decoded = decodeEffectRequest(REQUEST);
    const result = createEffectResult({
      requestId: decoded.requestId,
      status: EffectStatus.failed,
      resultSchemaId: decoded.resultSchemaId
    });
    const resultBytes = Buffer.from(result.encodedBytes);
    resultBytes[12] ^= 1;
    assert.throws(() => decodeEffectResult(resultBytes), { code: "ERR_CAPABILITY_V1_RESULT_IDENTITY" });
  });

  it("rejects resealed zero semantic references and invalid genesis parents", () => {
    const zeroApplication = Buffer.from(REQUEST);
    zeroApplication.fill(0, 44, 76);
    resealRequest(zeroApplication);
    assert.throws(() => decodeEffectRequest(zeroApplication), { code: "ERR_CAPABILITY_V1_REQUEST" });

    const nonzeroGenesisParent = Buffer.from(REQUEST);
    nonzeroGenesisParent[76] = 1;
    resealRequest(nonzeroGenesisParent);
    assert.throws(() => decodeEffectRequest(nonzeroGenesisParent), { code: "ERR_CAPABILITY_V1_REQUEST" });

    assert.throws(() => createEffectResult({
      requestId: Buffer.alloc(32),
      status: EffectStatus.failed,
      resultSchemaId: Buffer.alloc(32)
    }), { code: "ERR_CAPABILITY_V1_RESULT" });
  });

  it("rejects null-prototype JSON accessors without executing them", () => {
    let getterCalls = 0;
    const value = Object.create(null);
    Object.defineProperty(value, "answer", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return getterCalls === 1 ? 42 : Number.NaN;
      }
    });

    assert.throws(() => encodeJsonStringValue(value), {
      code: "ERR_CAPABILITY_V1_JSON_VALUE"
    });
    assert.equal(getterCalls, 0);

    const admitted = Object.create(null);
    Object.defineProperty(admitted, "answer", {
      value: 42,
      enumerable: true
    });
    assert.deepEqual(
      decodeJsonStringValue(encodeJsonStringValue(admitted)),
      { answer: 42 }
    );
  });
});

describe("CapabilityRouterV1 authority boundary", () => {
  it("inspects without executing adapter code and enforces policy before resolve", async () => {
    let preflightCalls = 0;
    let effectCalls = 0;
    const router = new CapabilityRouterV1({ bindings: [binding({
      adapter: {
        preflight: async (_context, request) => {
          preflightCalls += 1;
          return { requestId: request.requestId, status: "rejected", payload: { reason: "policy_denied" } };
        },
        resolve: async () => {
          effectCalls += 1;
          throw new Error("effect should not run");
        }
      }
    })] });

    assert.equal(router.inspect(REQUEST).effectAttempted, false);
    assert.equal(preflightCalls, 0);
    const resolved = await router.resolve({ policy: { live: false } }, REQUEST);
    assert.equal(resolved.result.status, EffectStatus.rejected);
    assert.equal(preflightCalls, 1);
    assert.equal(effectCalls, 0);
  });

  it("rejects capability-authored Frame evidence", async () => {
    const router = new CapabilityRouterV1({ bindings: [binding({
      adapter: {
        preflight: async (_context, request) => ({ requestId: request.requestId, status: "ok", payload: {} }),
        resolve: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: { value: 41 },
          frameBytes: Buffer.from("forbidden")
        })
      }
    })] });

    await assert.rejects(() => router.resolve({}, REQUEST), { code: "ERR_CAPABILITY_V1_WORLD_EVIDENCE" });
  });

  it("never authors a result outside the request-specific attempt or byte limits", async () => {
    const router = new CapabilityRouterV1({ bindings: [binding({
      adapter: {
        preflight: async (_context, request) => ({ requestId: request.requestId, status: "ok", payload: {} }),
        resolve: async (_context, request) => ({ requestId: request.requestId, status: "ok", payload: { value: 41 } })
      }
    })] });
    await assert.rejects(() => router.resolve({ attempt: 4 }, REQUEST), {
      code: "ERR_CAPABILITY_V1_RESULT_ATTEMPT"
    });

    const tightRequest = Buffer.from(REQUEST);
    tightRequest.writeUInt32LE(4, tightRequest.length - 8);
    resealRequest(tightRequest);
    await assert.rejects(() => router.resolve({ attempt: 1 }, tightRequest), {
      code: "ERR_CAPABILITY_V1_RESULT"
    });
  });

  it("derives the same handler identity from equivalent application ID sets", async () => {
    const requestApplicationId = Buffer.from(REQUEST.subarray(44, 76));
    const otherApplicationId = Buffer.alloc(32, 0xa5);
    const adapter = {
      preflight: async (_context, request) => ({
        requestId: request.requestId,
        status: "ok",
        payload: {}
      }),
      resolve: async (_context, request) => ({
        requestId: request.requestId,
        status: "ok",
        payload: { value: 41 }
      })
    };
    const first = new CapabilityRouterV1({ bindings: [binding({
      applicationIds: [requestApplicationId, otherApplicationId],
      adapter
    })] });
    const second = new CapabilityRouterV1({ bindings: [binding({
      applicationIds: [otherApplicationId, requestApplicationId],
      adapter
    })] });

    const firstResult = await first.resolve({}, REQUEST);
    const secondResult = await second.resolve({}, REQUEST);
    assert.equal(
      firstResult.handlerConfigurationIdentity,
      secondResult.handlerConfigurationIdentity
    );
  });

  it("keeps admitted application allowlists outside the public router surface", async () => {
    const applicationId = Buffer.from(REQUEST.subarray(44, 76));
    const configuredIds = [Buffer.from(applicationId)];
    const router = new CapabilityRouterV1({ bindings: [binding({
      applicationIds: configuredIds,
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: { value: 41 }
        })
      }
    })] });

    assert.equal(Object.prototype.hasOwnProperty.call(router, "bindings"), false);
    configuredIds[0].fill(0xa5);
    assert.equal((await router.resolve({}, REQUEST)).result.status, EffectStatus.ok);
  });

  it("uses one inert admitted outcome snapshot for validation and encoding", async () => {
    let semanticReadCalls = 0;
    const target = {
      requestId: decodeEffectRequest(REQUEST).requestId.toString("hex"),
      status: "ok",
      payload: { value: 41 }
    };
    const outcome = new Proxy(target, {
      get(object, key, receiver) {
        if (key === "requestId" || key === "status" || key === "payload") {
          semanticReadCalls += 1;
        }
        if (key === "payload") return { frameBytes: Buffer.from("forbidden") };
        return Reflect.get(object, key, receiver);
      }
    });
    const router = new CapabilityRouterV1({ bindings: [binding({
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async () => outcome
      },
      encodeOutcome: (admitted) => {
        assert.deepEqual(admitted.payload, { value: 41 });
        const bytes = Buffer.alloc(8);
        bytes.writeBigInt64LE(BigInt(admitted.payload.value));
        return bytes;
      }
    })] });

    const resolved = await router.resolve({}, REQUEST);

    assert.equal(resolved.result.status, EffectStatus.ok);
    assert.equal(semanticReadCalls, 0);
  });

  it("keeps standard JSON bindings compatible with admitted outcome snapshots", async () => {
    const router = new CapabilityRouterV1({ bindings: [binding({
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: { nested: { values: [1, 2, 3] } }
        })
      },
      encodeOutcome: (outcome) => encodeJsonStringValue(outcome.payload)
    })] });

    const resolved = await router.resolve({}, REQUEST);

    assert.deepEqual(
      decodeJsonStringValue(resolved.result.resultBytes),
      { nested: { values: [1, 2, 3] } }
    );
  });

  it("preserves owned admitted carrier representations for binding encoders", async () => {
    const values = [1, 2, 3];
    const buffer = Buffer.from([4, 5, 6]);
    const bytes = new Uint8Array([7, 8, 9]);
    const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
    let byteCarrierDescriptorCalls = 0;
    const router = new CapabilityRouterV1({ bindings: [binding({
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: { values, buffer, bytes }
        })
      },
      encodeOutcome: (outcome) => {
        assert.deepEqual(outcome.payload.values.map((value) => value * 2), [2, 4, 6]);
        assert.deepEqual([...outcome.payload.values], values);
        assert.equal(Buffer.isBuffer(outcome.payload.buffer), true);
        assert.notStrictEqual(outcome.payload.buffer, buffer);
        assert.deepEqual(outcome.payload.buffer, buffer);
        assert.equal(outcome.payload.bytes instanceof Uint8Array, true);
        assert.equal(Buffer.isBuffer(outcome.payload.bytes), false);
        assert.notStrictEqual(outcome.payload.bytes, bytes);
        assert.deepEqual(outcome.payload.bytes, bytes);
        return Buffer.from([0x2a]);
      }
    })] });

    Object.getOwnPropertyDescriptors = (value) => {
      if (value === buffer || value === bytes) byteCarrierDescriptorCalls += 1;
      return getOwnPropertyDescriptors(value);
    };
    let resolved;
    try {
      resolved = await router.resolve({}, REQUEST);
    } finally {
      Object.getOwnPropertyDescriptors = getOwnPropertyDescriptors;
    }

    assert.deepEqual(resolved.result.resultBytes, Buffer.from([0x2a]));
    assert.equal(byteCarrierDescriptorCalls, 0);
  });

  it("rejects revoked outcome proxies through the capability error surface", async () => {
    const target = {
      requestId: decodeEffectRequest(REQUEST).requestId.toString("hex"),
      status: "ok",
      payload: { value: 41 }
    };
    let revoke;
    const revocable = Proxy.revocable(target, {
      getPrototypeOf(object) {
        revoke();
        return Reflect.getPrototypeOf(object);
      }
    });
    revoke = revocable.revoke;
    const router = new CapabilityRouterV1({ bindings: [binding({
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async () => revocable.proxy
      }
    })] });

    await assert.rejects(() => router.resolve({}, REQUEST), {
      code: "ERR_CAPABILITY_V1_OUTCOME"
    });
  });

  it("rejects array proxy indices beyond the snapshotted length", async () => {
    let encodeCalls = 0;
    const values = new Proxy([], {
      ownKeys() {
        return ["0", "length"];
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === "0") {
          return { value: 42, writable: true, enumerable: true, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    const router = new CapabilityRouterV1({ bindings: [binding({
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: { values }
        })
      },
      encodeOutcome: () => {
        encodeCalls += 1;
        return Buffer.from([0x2a]);
      }
    })] });

    await assert.rejects(() => router.resolve({}, REQUEST), {
      code: "ERR_CAPABILITY_V1_OUTCOME"
    });
    assert.equal(encodeCalls, 0);
  });

  it("rejects evidence-bearing byte carrier extensions before copying", async () => {
    let carrier;
    let encodeCalls = 0;
    const router = new CapabilityRouterV1({ bindings: [binding({
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: { carrier }
        })
      },
      encodeOutcome: () => {
        encodeCalls += 1;
        return Buffer.from([0x2a]);
      }
    })] });

    for (const [value, key] of [
      [Buffer.from([1, 2, 3]), "frameBytes"],
      [new Uint8Array([4, 5, 6]), "frame_bytes"]
    ]) {
      carrier = value;
      Object.defineProperty(carrier, key, { value: Buffer.from("forbidden") });
      await assert.rejects(() => router.resolve({}, REQUEST), {
        code: "ERR_CAPABILITY_V1_WORLD_EVIDENCE"
      });
    }
    assert.equal(encodeCalls, 0);
  });

  it("rejects unsupported exotic admitted carrier representations", async () => {
    let exotic = new Date("2026-08-03T00:00:00Z");
    let encodeCalls = 0;
    const router = new CapabilityRouterV1({ bindings: [binding({
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: { exotic }
        })
      },
      encodeOutcome: () => {
        encodeCalls += 1;
        return Buffer.from([0x2a]);
      }
    })] });

    for (const value of [exotic, new Map([["answer", 42]]), new Uint16Array([42])]) {
      exotic = value;
      await assert.rejects(() => router.resolve({}, REQUEST), {
        code: "ERR_CAPABILITY_V1_OUTCOME"
      });
    }
    assert.equal(encodeCalls, 0);
  });

  it("rejects inherited outcome accessors without executing them", async () => {
    let getterCalls = 0;
    const inherited = Object.create({
      get status() {
        getterCalls += 1;
        this.payload = { frameBytes: Buffer.from("forbidden") };
        return "ok";
      }
    });
    inherited.requestId = decodeEffectRequest(REQUEST).requestId.toString("hex");
    inherited.payload = { value: 41 };
    const router = new CapabilityRouterV1({ bindings: [binding({
      adapter: {
        preflight: async (_context, request) => ({
          requestId: request.requestId,
          status: "ok",
          payload: {}
        }),
        resolve: async () => inherited
      }
    })] });

    await assert.rejects(() => router.resolve({}, REQUEST), {
      code: "ERR_CAPABILITY_V1_OUTCOME"
    });
    assert.equal(getterCalls, 0);
  });
});

function binding(overrides = {}) {
  const request = decodeEffectRequest(REQUEST);
  return {
    bindingId: "one-effect.fixture.v1",
    driverId: "one-effect-fixture",
    packageName: "@fixture/one-effect",
    interfaceId: request.interfaceId,
    payloadSchemaId: request.payloadSchemaId,
    resultSchemaId: request.resultSchemaId,
    authorityRequirements: request.authorityRequirements,
    target: {
      descriptorFingerprint: "fixture",
      actuatorRef: "fixture",
      actuationClass: "fixture"
    },
    decodePayload: (bytes) => ({ prompt: decodeStringValue(bytes) }),
    encodeOutcome: () => {
      const bytes = Buffer.alloc(8);
      bytes.writeBigInt64LE(41n);
      return bytes;
    },
    ...overrides
  };
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
