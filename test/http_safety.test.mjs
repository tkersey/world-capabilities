import { expect, test } from "bun:test";
import { resolve, dryRun } from "../packages/generic-http-json/adapter.mjs";

function request(overrides = {}) {
  return {
    requestId: "http-safety",
    idempotencyKey: "world:idem:http-safety",
    target: {
      descriptorFingerprint: "desc.generic-http-json.v0",
      actuatorRef: "actuator.generic-http-json",
      actuationClass: "http"
    },
    responseSchema: { statuses: ["ok", "rejected", "failed"] },
    payload: { url: "https://example.invalid/fixture", method: "GET" },
    ...overrides
  };
}

test("dry run never attempts fetch", async () => {
  const context = { effectAttempted: 0 };
  const result = await dryRun(context, request());
  expect(result.payload.wouldFetch).toBe(false);
  expect(context.effectAttempted).toBe(0);
});

test("policy denied prevents HTTP effect", async () => {
  const context = { policy: { networkLive: false }, effectAttempted: 0 };
  const result = await resolve(context, request());
  expect(result.status).toBe("rejected");
  expect(context.effectAttempted).toBe(0);
});

test("target and schema compatibility prevent HTTP effect", async () => {
  const wrongTarget = { policy: { networkLive: true }, effectAttempted: 0 };
  const wrongTargetResult = await resolve(wrongTarget, request({
    target: {
      descriptorFingerprint: "desc.other.v0",
      actuatorRef: "actuator.generic-http-json",
      actuationClass: "http"
    }
  }));
  expect(wrongTargetResult.payload.reason).toBe("unsupported_descriptor_fingerprint");
  expect(wrongTarget.effectAttempted).toBe(0);

  const unsupportedSchema = { policy: { networkLive: true }, effectAttempted: 0 };
  const unsupportedSchemaResult = await resolve(unsupportedSchema, request({
    responseSchema: { statuses: ["accepted"] }
  }));
  expect(unsupportedSchemaResult.payload.reason).toBe("unsupported_response_schema");
  expect(unsupportedSchema.effectAttempted).toBe(0);

  const missingActuator = { policy: { networkLive: true }, effectAttempted: 0 };
  const missingActuatorResult = await resolve(missingActuator, request({
    target: {
      descriptorFingerprint: "desc.generic-http-json.v0",
      actuationClass: "http"
    }
  }));
  expect(missingActuatorResult.payload.reason).toBe("missing_actuator_ref");
  expect(missingActuator.effectAttempted).toBe(0);

  const wrongClass = { policy: { networkLive: true }, effectAttempted: 0 };
  const wrongClassResult = await resolve(wrongClass, request({
    target: {
      descriptorFingerprint: "desc.generic-http-json.v0",
      actuatorRef: "actuator.generic-http-json",
      actuationClass: "file"
    }
  }));
  expect(wrongClassResult.payload.reason).toBe("unsupported_actuation_class");
  expect(wrongClass.effectAttempted).toBe(0);
});

test("non-http urls are rejected before effects", async () => {
  const live = { policy: { networkLive: true }, effectAttempted: 0 };
  const liveResult = await resolve(live, request({
    payload: { url: "file:///etc/passwd", method: "GET" }
  }));
  expect(liveResult.payload.reason).toBe("malformed_target");
  expect(live.effectAttempted).toBe(0);

  const dry = { effectAttempted: 0 };
  const dryResult = await dryRun(dry, request({
    payload: { url: "file:///etc/passwd", method: "GET" }
  }));
  expect(dryResult.payload.reason).toBe("malformed_target");
  expect(dry.effectAttempted).toBe(0);
});

test("package deny policy prevents HTTP effect", async () => {
  const context = {
    policy: { networkLive: true, denyPackages: ["@tkersey/world-capabilities/generic-http-json"] },
    effectAttempted: 0
  };
  const result = await resolve(context, request());
  expect(result.payload.reason).toBe("package_denied");
  expect(context.effectAttempted).toBe(0);
});

test("package deny policy must be an array before HTTP effect", async () => {
  const context = {
    policy: { networkLive: true, denyPackages: "@tkersey/world-capabilities/generic-http-json" },
    effectAttempted: 0
  };
  const result = await resolve(context, request());
  expect(result.payload.reason).toBe("package_denied");
  expect(context.effectAttempted).toBe(0);
});

test("package allow policy must be an array before HTTP effect", async () => {
  const context = {
    policy: { networkLive: true, allowPackages: "@tkersey/world-capabilities/generic-http-json-extra" },
    effectAttempted: 0
  };
  const result = await resolve(context, request());
  expect(result.payload.reason).toBe("package_not_allowed");
  expect(context.effectAttempted).toBe(0);
});

test("package deny policy precedes secret lookup", async () => {
  const context = {
    policy: { networkLive: true, denyPackages: ["@tkersey/world-capabilities/generic-http-json"] },
    secrets: {},
    effectAttempted: 0
  };
  const result = await resolve(context, request({
    payload: { url: "https://example.invalid/fixture", method: "GET", requiresSecret: "API_TOKEN" }
  }));
  expect(result.payload.reason).toBe("package_denied");
  expect(context.effectAttempted).toBe(0);
});

test("package deny policy precedes malformed HTTP payload details", async () => {
  const context = {
    policy: { networkLive: true, denyPackages: ["@tkersey/world-capabilities/generic-http-json"] },
    effectAttempted: 0
  };
  const missingUrl = await resolve(context, request({
    payload: { method: "GET" }
  }));
  expect(missingUrl.payload.reason).toBe("package_denied");
  expect(context.effectAttempted).toBe(0);

  const invalidMethod = await resolve(context, request({
    payload: { url: "https://example.invalid/fixture", method: "TRACE" }
  }));
  expect(invalidMethod.payload.reason).toBe("package_denied");
  expect(context.effectAttempted).toBe(0);
});

test("live policy precedes secret lookup", async () => {
  const context = { policy: { networkLive: false }, secrets: {}, effectAttempted: 0 };
  const result = await resolve(context, request({
    payload: { url: "https://example.invalid/fixture", method: "GET", requiresSecret: "API_TOKEN" }
  }));
  expect(result.payload.reason).toBe("network_denied");
  expect(context.effectAttempted).toBe(0);
});

test("nested hostile payload markers prevent HTTP effects", async () => {
  const context = { policy: { networkLive: true }, effectAttempted: 0 };
  const result = await resolve(context, request({
    payload: {
      url: "https://example.invalid/fixture",
      method: "GET",
      meta: { worldAuthoredEvidence: "forbidden" }
    }
  }));
  expect(result.payload.reason).toBe("forbidden_world_evidence");
  expect(context.effectAttempted).toBe(0);
});

test("nested forbidden evidence keys prevent HTTP effects", async () => {
  const context = { policy: { networkLive: true }, effectAttempted: 0 };
  const result = await resolve(context, request({
    payload: {
      url: "https://example.invalid/fixture",
      method: "GET",
      meta: { capsuleBytes: "forbidden" }
    }
  }));
  expect(result.payload.reason).toBe("forbidden_evidence");
  expect(context.effectAttempted).toBe(0);
});
