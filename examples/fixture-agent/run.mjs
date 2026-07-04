import { resolve } from "../../packages/fixture-model/adapter.mjs";

const result = await resolve({}, {
  requestId: "example-fixture-agent",
  idempotencyKey: "world:idem:example-fixture-agent",
  target: { descriptorFingerprint: "desc.fixture-model.v0", actuatorRef: "actuator.fixture-model", actuationClass: "model" },
  responseSchema: { statuses: ["ok", "rejected", "failed"] },
  payload: { prompt: "choose fixture action" }
});
console.log(JSON.stringify(result, null, 2));
