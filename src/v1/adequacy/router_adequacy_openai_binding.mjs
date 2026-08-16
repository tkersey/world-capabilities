import { createHash } from "node:crypto";

import * as openai from "../../../packages/router-adequacy-openai/adapter.mjs";
import { effectInterfaceId } from "../protocol.mjs";
import { decodeDecisionTurn, encodeAction } from "./router_adequacy_codecs.mjs";
import { ADEQUACY_APPLICATION_ID } from "./repository_workspace_adequacy_binding.mjs";

const DECISION_PAYLOAD_SCHEMA_ID =
  "aace2967929a1dfcbe84fad29b6db4845da67be4845447976aafcb3fa448f702";
const ACTION_RESULT_SCHEMA_ID =
  "fee2bec3c17e756cc3c80d5a5fa9c0815a098aab03cd36565ab06e183838762b";

export function routerAdequacyOpenAIBinding(options = {}) {
  const adapter = options.adapter ?? openai;
  return {
    bindingId: "router-adequacy-openai.v1",
    driverId: "router-adequacy-openai",
    packageName: "@tkersey/world-capabilities/router-adequacy-openai",
    interfaceId: effectInterfaceId("model.decide.v1"),
    payloadSchemaId: digest(DECISION_PAYLOAD_SCHEMA_ID),
    resultSchemaId: digest(ACTION_RESULT_SCHEMA_ID),
    applicationIds: [digest(ADEQUACY_APPLICATION_ID)],
    authorityRequirements: 9n,
    target: {
      descriptorFingerprint: "desc.router-adequacy-openai.v1",
      actuatorRef: "actuator.router-adequacy-openai.v1",
      actuationClass: "model"
    },
    adapter,
    decodePayload: decodeDecisionTurn,
    encodeOutcome: (outcome) => encodeAction(outcome.payload),
    configurationIdentity: openAIConfigurationIdentity,
    hostClaims: openAIHostClaims,
    recoveryClass: "retryable"
  };
}

function openAIConfigurationIdentity(context) {
  const hasher = createHash("sha256");
  hasher.update("world.capability-configuration.v1\0");
  hasher.update("router-adequacy-openai\0");
  hasher.update(String(context?.openaiModel ?? ""));
  hasher.update("\0");
  hasher.update(openai.DECISION_CONTRACT_DIGEST);
  return hasher.digest("hex");
}

function openAIHostClaims(outcome) {
  const claims = outcome?.claims;
  if (!claims || outcome.status !== "ok") return new Uint8Array(0);
  return Buffer.from(JSON.stringify({
    provider: "openai",
    endpointClass: "responses",
    requestedModel: claims.requestedModel,
    returnedModel: claims.returnedModel,
    responseIdSha256: createHash("sha256").update(claims.responseId).digest("hex"),
    inputTokens: claims.inputTokens,
    outputTokens: claims.outputTokens,
    totalTokens: claims.totalTokens,
    store: false
  }), "utf8");
}

function digest(value) { return Buffer.from(value, "hex"); }
