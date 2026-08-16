import * as fixture from "../../../packages/router-adequacy-decision-fixture/adapter.mjs";
import { effectInterfaceId } from "../protocol.mjs";
import { decodeDecisionTurn, encodeAction } from "./router_adequacy_codecs.mjs";
import { ADEQUACY_APPLICATION_ID } from "./repository_workspace_adequacy_binding.mjs";

const DECISION_PAYLOAD_SCHEMA_ID =
  "aace2967929a1dfcbe84fad29b6db4845da67be4845447976aafcb3fa448f702";
const ACTION_RESULT_SCHEMA_ID =
  "fee2bec3c17e756cc3c80d5a5fa9c0815a098aab03cd36565ab06e183838762b";

export function routerAdequacyDecisionFixtureBinding(options = {}) {
  const adapter = options.adapter ?? fixture;
  return {
    bindingId: "router-adequacy-decision-fixture.v1",
    driverId: "router-adequacy-decision-fixture",
    packageName: "@tkersey/world-capabilities/router-adequacy-decision-fixture",
    interfaceId: effectInterfaceId("model.decide.v1"),
    payloadSchemaId: digest(DECISION_PAYLOAD_SCHEMA_ID),
    resultSchemaId: digest(ACTION_RESULT_SCHEMA_ID),
    applicationIds: [digest(ADEQUACY_APPLICATION_ID)],
    authorityRequirements: 9n,
    target: {
      descriptorFingerprint: "desc.router-adequacy-decision-fixture.v1",
      actuatorRef: "actuator.router-adequacy-decision-fixture.v1",
      actuationClass: "model"
    },
    adapter,
    decodePayload: decodeDecisionTurn,
    encodeOutcome: (outcome) => encodeAction(outcome.payload),
    recoveryClass: "pure"
  };
}

function digest(value) { return Buffer.from(value, "hex"); }
