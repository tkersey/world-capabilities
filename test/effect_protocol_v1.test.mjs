import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  CapabilityRouterV1,
  EffectStatus,
  createEffectResult,
  decodeEffectRequest,
  decodeEffectResult,
  decodeStringValue,
  effectInterfaceId,
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
