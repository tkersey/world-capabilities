#!/usr/bin/env bun
import { assert } from "./assertions.mjs";
import { importAdapter, loadPack } from "./pack-utils.mjs";

const pack = await loadPack("generic-http-json");
const adapter = await importAdapter(pack.dir);

function base(overrides = {}) {
  return {
    requestId: "policy-test",
    idempotencyKey: "world:idem:policy-test",
    target: {
      descriptorFingerprint: pack.manifest.supportedDescriptorFingerprints[0],
      actuatorRef: pack.manifest.supportedActuatorRefs[0],
      actuationClass: "http"
    },
    responseSchema: { statuses: ["ok", "rejected", "failed"] },
    payload: { url: "https://example.invalid/fixture", method: "GET" },
    ...overrides
  };
}

async function deniedCase(label, request, policy = {}) {
  const context = { packageName: pack.manifest.packageName, policy, effectAttempted: 0 };
  const result = await adapter.resolve(context, request);
  assert(context.effectAttempted === 0, `${label}: effect attempted before policy allowed`);
  assert(["rejected", "failed"].includes(result.status), `${label}: did not reject/fail`);
}

await deniedCase("live denied default", base());
await deniedCase("audit only", base(), { auditOnly: true });
await deniedCase("missing idempotency", base({ idempotencyKey: undefined }), { live: true });
await deniedCase("malformed target", base({ target: {} }), { live: true });
await deniedCase("unsupported schema", base({ responseSchema: { statuses: [] } }), { live: true });
await deniedCase("missing secret", base({ payload: { url: "https://example.invalid/fixture", method: "GET", requiresSecret: "API_TOKEN" } }), { live: true });

console.log("policy-before-effect tests passed");
