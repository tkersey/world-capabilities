import * as fixture from "../../../packages/repository-repair-decision-fixture/adapter.mjs";
import { effectInterfaceId } from "../protocol.mjs";
import { decodeDecisionRequest, encodeAction } from "./repository_repair_codecs.mjs";
import { ACTUALITY_APPLICATION_ID } from "./repository_workspace_binding.mjs";

const DECISION_PAYLOAD_SCHEMA_ID =
  "9c77e9f50112cf7b620dd4d4f235365aff354615bf4b9e7f394434dc7cc367cb";
const ACTION_RESULT_SCHEMA_ID =
  "f881b59b5cd53a3cd073b8704794fdd52a99120ca9aeb7e6eb05f8054ce5cfb1";

export function repositoryRepairDecisionFixtureBinding(options = {}) {
  const adapter = options.adapter ?? fixture;
  return {
    bindingId: "repository-repair-decision-fixture.v1",
    driverId: "repository-repair-decision-fixture",
    packageName: "@tkersey/world-capabilities/repository-repair-decision-fixture",
    interfaceId: effectInterfaceId("model.decide.v1"),
    payloadSchemaId: digest(DECISION_PAYLOAD_SCHEMA_ID),
    resultSchemaId: digest(ACTION_RESULT_SCHEMA_ID),
    applicationIds: [digest(ACTUALITY_APPLICATION_ID)],
    authorityRequirements: 9n,
    target: {
      descriptorFingerprint: "desc.repository-repair-decision-fixture.v1",
      actuatorRef: "actuator.repository-repair-decision-fixture.v1",
      actuationClass: "model"
    },
    adapter,
    decodePayload: decodeDecisionRequest,
    encodeOutcome: (outcome) => encodeAction(outcome.payload),
    recoveryClass: "pure"
  };
}

function digest(value) { return Buffer.from(value, "hex"); }
