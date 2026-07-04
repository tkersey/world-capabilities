#!/usr/bin/env bun
import { loadPack, packageNames, importAdapter, assertNoForbiddenEvidence } from "./pack-utils.mjs";
import { assert } from "./assertions.mjs";

export async function runPackConformance(name) {
  const pack = await loadPack(name);
  const adapter = await importAdapter(pack.dir);
  for (const vector of pack.conformance.vectors) {
    assert(vector.passed === true, `${name}: vector ${vector.id} is not marked passed`);
  }
  const req = {
    requestId: `conformance-${name}`,
    idempotencyKey: `idem-${name}`,
    target: {
      descriptorFingerprint: pack.manifest.supportedDescriptorFingerprints[0],
      actuatorRef: pack.manifest.supportedActuatorRefs[0],
      actuationClass: pack.manifest.supportedActuationClasses[0]
    },
    responseSchema: { statuses: pack.manifest.supportedResponseStatuses },
    payload: { fixture: true }
  };
  const preflight = await adapter.preflight({ packageName: pack.manifest.packageName, policy: { auditOnly: true } }, req);
  assertNoForbiddenEvidence(preflight, `${name} preflight`);
  const dryRun = await adapter.dryRun({ packageName: pack.manifest.packageName, policy: { auditOnly: true } }, req);
  assertNoForbiddenEvidence(dryRun, `${name} dryRun`);
}

if (import.meta.main) {
  for (const name of await packageNames()) await runPackConformance(name);
  console.log("conformance vectors passed");
}
