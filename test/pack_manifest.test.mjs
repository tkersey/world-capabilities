import { expect, test } from "bun:test";
import { assertAdapterManifestParity, importAdapter, loadPack, packageNames, verifyPack } from "../harness/pack-utils.mjs";

test("all package manifests verify", async () => {
  for (const name of await packageNames()) await verifyPack(await loadPack(name));
});

test("adapter manifest policy fields stay in parity with package manifests", () => {
  const manifest = {
    packageName: "@tkersey/world-capabilities/parity-pack",
    driverId: "parity-pack",
    supportedActuationClasses: ["http"],
    supportedActuatorRefs: ["actuator.parity-pack"],
    supportedDescriptorFingerprints: ["desc.parity-pack.v0"],
    supportedResponseStatuses: ["ok", "rejected", "failed"],
    secretRequirements: [{ name: "API_TOKEN", requiredByDefault: false }]
  };
  const pack = { name: "parity-pack", manifest };

  assertAdapterManifestParity(pack, { ...manifest });
  expect(() => assertAdapterManifestParity(pack, { ...manifest, supportedResponseStatuses: ["ok", "failed"] })).toThrow(/supportedResponseStatuses mismatch/);
  expect(() => assertAdapterManifestParity(pack, { ...manifest, secretRequirements: [] })).toThrow(/secretRequirements mismatch/);

  const { supportedActuatorRefs, ...missing } = manifest;
  expect(() => assertAdapterManifestParity(pack, missing)).toThrow(/missing supportedActuatorRefs/);
});

test("adapter manifest policy state is isolated from callers", async () => {
  for (const name of await packageNames()) {
    const pack = await loadPack(name);
    const adapter = await importAdapter(pack.dir);
    const returned = adapter.manifest();
    returned.supportedActuationClasses.push("mutated-class");
    returned.supportedActuatorRefs.length = 0;
    returned.supportedDescriptorFingerprints.push("desc.mutated");
    returned.supportedResponseStatuses.push("mutated-status");
    returned.secretRequirements.push({ name: "MUTATED_SECRET", requiredByDefault: true });
    assertAdapterManifestParity(pack, adapter.manifest());
  }
});
