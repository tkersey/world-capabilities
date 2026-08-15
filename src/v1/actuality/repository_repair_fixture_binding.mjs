import * as fixture from "../../../packages/repository-repair-decision-fixture/adapter.mjs";
import { effectInterfaceId } from "../protocol.mjs";
import { decodeDecisionTurn, encodeAction } from "./repository_repair_codecs.mjs";
import { ACTUALITY_APPLICATION_ID } from "./repository_workspace_binding.mjs";

const DECISION_PAYLOAD_SCHEMA_ID =
  "71a55185311a35066f51f4aecc2f4fd1c2ee7d0dc0b563a42f5ec2620d4d6cfd";
const ACTION_RESULT_SCHEMA_ID =
  "34d136f0796a2332d269477a46af9b478e42ab671e730584dc7c0582347b417a";

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
    decodePayload: decodeDecisionTurn,
    encodeOutcome: (outcome) => encodeAction(outcome.payload),
    recoveryClass: "pure"
  };
}

function digest(value) { return Buffer.from(value, "hex"); }
