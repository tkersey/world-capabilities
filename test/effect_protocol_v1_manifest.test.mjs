import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  fixtureAgentBindings,
  genericHttpJsonBinding,
  humanApprovalBinding,
  localMemoryKvBinding,
  researchLookupFixtureBinding
} from "../src/v1/index.mjs";

const PACKAGES = [
  "fixture-model",
  "generic-http-json",
  "human-approval",
  "local-memory-kv",
  "research-lookup-fixture",
  "sandbox-files"
];

describe("Effect protocol v1 pack declarations", () => {
  it("binds every packaged v1 interface to its exact router contract", async () => {
    const bindings = [
      ...fixtureAgentBindings(),
      genericHttpJsonBinding(),
      humanApprovalBinding(),
      localMemoryKvBinding(),
      researchLookupFixtureBinding()
    ];

    for (const packageName of PACKAGES) {
      const manifest = JSON.parse(await readFile(`packages/${packageName}/manifest.json`, "utf8"));
      assert(manifest.supportedWorldProtocolVersions.includes("world-effect-v1"));
      const expected = bindings
        .filter((binding) => binding.packageName === manifest.packageName)
        .map((binding) => ({
          authorityRequirements: binding.authorityRequirements.toString(),
          interfaceId: Buffer.from(binding.interfaceId).toString("hex"),
          payloadSchemaId: Buffer.from(binding.payloadSchemaId).toString("hex"),
          resultSchemaId: Buffer.from(binding.resultSchemaId).toString("hex"),
          ...(binding.applicationIds === undefined
            ? {}
            : {
                applicationIds: binding.applicationIds
                  .map((applicationId) => Buffer.from(applicationId).toString("hex"))
                  .sort()
              })
        }))
        .sort(compareInterfaces);
      const declared = manifest.effectProtocolV1.interfaces
        .map((entry) => ({
          authorityRequirements: entry.authorityRequirements,
          interfaceId: entry.interfaceId,
          payloadSchemaId: entry.payloadSchemaId,
          resultSchemaId: entry.resultSchemaId,
          ...(entry.applicationIds === undefined
            ? {}
            : { applicationIds: entry.applicationIds })
        }))
        .sort(compareInterfaces);

      assert.deepEqual(declared, expected, `${packageName}: manifest/router interface drift`);
      for (const binding of bindings.filter((candidate) => candidate.packageName === manifest.packageName)) {
        assert.equal(binding.recoveryClass, manifest.recoveryClass, `${packageName}: recovery class drift`);
      }
    }
  });
});

function compareInterfaces(left, right) {
  return left.interfaceId.localeCompare(right.interfaceId);
}
