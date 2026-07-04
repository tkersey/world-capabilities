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
