import { expect, test } from "bun:test";
import { resolve } from "../packages/fixture-model/adapter.mjs";

test("fixture model exact action output", async () => {
  const result = await resolve({}, {
    requestId: "fixture-exact",
    idempotencyKey: "world:idem:fixture-exact",
    target: {
      descriptorFingerprint: "desc.fixture-model.v0",
      actuatorRef: "actuator.fixture-model",
      actuationClass: "model"
    },
    responseSchema: { statuses: ["ok", "rejected", "failed"] },
    payload: { prompt: "choose fixture action" }
  });
  expect(result).toEqual({
    requestId: "fixture-exact",
    status: "ok",
    payload: { action: "fixture.action", arguments: { source: "fixture-model" } },
    diagnostics: { mode: "fixture" }
  });
});
