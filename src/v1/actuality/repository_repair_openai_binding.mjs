import { createHash } from "node:crypto";

import * as openai from "../../../packages/repository-repair-openai/adapter.mjs";
import { effectInterfaceId } from "../protocol.mjs";
import { decodeDecisionRequest, encodeAction } from "./repository_repair_codecs.mjs";
import { ACTUALITY_APPLICATION_ID } from "./repository_workspace_binding.mjs";

const DECISION_PAYLOAD_SCHEMA_ID =
  "9c77e9f50112cf7b620dd4d4f235365aff354615bf4b9e7f394434dc7cc367cb";
const ACTION_RESULT_SCHEMA_ID =
  "f881b59b5cd53a3cd073b8704794fdd52a99120ca9aeb7e6eb05f8054ce5cfb1";

export function repositoryRepairOpenAIBinding(options = {}) {
  const adapter = options.adapter ?? openai;
  return {
    bindingId: "repository-repair-openai.v1",
    driverId: "repository-repair-openai",
    packageName: "@tkersey/world-capabilities/repository-repair-openai",
    interfaceId: effectInterfaceId("model.decide.v1"),
    payloadSchemaId: digest(DECISION_PAYLOAD_SCHEMA_ID),
    resultSchemaId: digest(ACTION_RESULT_SCHEMA_ID),
    applicationIds: [digest(ACTUALITY_APPLICATION_ID)],
    authorityRequirements: 9n,
    target: {
      descriptorFingerprint: "desc.repository-repair-openai.v1",
      actuatorRef: "actuator.repository-repair-openai.v1",
      actuationClass: "model"
    },
    adapter,
    decodePayload: decodeDecisionRequest,
    encodeOutcome: (outcome) => encodeAction(outcome.payload),
    configurationIdentity: openAIConfigurationIdentity,
    hostClaims: openAIHostClaims,
    recoveryClass: "retryable"
  };
}

function openAIConfigurationIdentity(context) {
  const hasher = createHash("sha256");
  hasher.update("world.capability-configuration.v1\0");
  hasher.update("repository-repair-openai\0");
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
