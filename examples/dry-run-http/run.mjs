import { dryRun } from "../../packages/generic-http-json/adapter.mjs";

const result = await dryRun({}, {
  requestId: "example-dry-run-http",
  idempotencyKey: "world:idem:example-dry-run-http",
  target: { descriptorFingerprint: "desc.generic-http-json.v0", actuatorRef: "actuator.generic-http-json", actuationClass: "http" },
  responseSchema: { statuses: ["ok", "rejected", "failed"] },
  payload: { url: "https://example.invalid/fixture", method: "GET" }
});
console.log(JSON.stringify(result, null, 2));
