import { createHash } from "node:crypto";
import { resolve } from "node:path";

import * as workspace from "../../../packages/repository-workspace-adequacy/adapter.mjs";
import { effectInterfaceId } from "../protocol.mjs";
import {
  decodeListRequest,
  decodeReadRequest,
  decodeReplaceRequest,
  decodeSearchRequest,
  decodeTestRequest,
  encodeListResult,
  encodeReadResult,
  encodeReplaceOutcome,
  encodeSearchResult,
  encodeTestResult
} from "./router_adequacy_codecs.mjs";

export const ADEQUACY_APPLICATION_ID =
  "6f26bd0ac8bd4351f4263c2f64fb68db5459d5b25f8f7ac2d060f40fea7c063c";

const SITE = Object.freeze({
  list: Object.freeze({
    label: "repo.list.v2",
    payload: "a0daed086016083f9ca1f3e218bf4d87a31ecd59df343c96cee04a2966f3a084",
    result: "3ab7407035609a7ca158f9519e33ff4a76d6c531c4a9dd4cdb80a4d67ef6fe0c",
    authority: 2n,
    descriptor: "desc.repository-list.v2",
    actuator: "actuator.repository-list.v2",
    recovery: "idempotent",
    decode: decodeListRequest,
    encode: encodeListResult
  }),
  read: Object.freeze({
    label: "repo.read.v2",
    payload: "546f886ded70c0a0fea51781b65f5d25772e562f3bd06641c6fde4e540dd903b",
    result: "5db72109d35d6f64b4da5ab2c1688514f03cbd43346a0aa35884a998b62459cf",
    authority: 2n,
    descriptor: "desc.repository-read.v2",
    actuator: "actuator.repository-read.v2",
    recovery: "idempotent",
    decode: decodeReadRequest,
    encode: encodeReadResult
  }),
  search: Object.freeze({
    label: "repo.search.v2",
    payload: "47969b29a68017cd5182e7a137c94451d83516d5d52791bab61deb29304f92c4",
    result: "bf22ace7693284eeaeeeae80efd14f839a6a3898bff4025810f1cc6ab40d9833",
    authority: 2n,
    descriptor: "desc.repository-search.v2",
    actuator: "actuator.repository-search.v2",
    recovery: "idempotent",
    decode: decodeSearchRequest,
    encode: encodeSearchResult
  }),
  test: Object.freeze({
    label: "repo.test.v2",
    payload: "24410ad4e4d67a9045bf094f6535e0866753bf28918b25536f09ec43285d1e2c",
    result: "f495213500302f67163eaae4587abc929ccf992f5c5035ce1a5df713366c8b77",
    authority: 6n,
    descriptor: "desc.repository-test.v2",
    actuator: "actuator.repository-test.v2",
    recovery: "retryable",
    decode: decodeTestRequest,
    encode: encodeTestResult
  }),
  replace: Object.freeze({
    label: "repo.replace.approved.v2",
    payload: "3b519b6bd6fe0164235f78f63d704f8955a74b87291c224ab33d46e0b1e2f44b",
    result: "51685ffb0c53aabfc5e7896056ef1c43072426b5cde1ba3d72643c9739ef583e",
    authority: 20n,
    descriptor: "desc.repository-replace-approved.v2",
    actuator: "actuator.repository-replace-approved.v2",
    recovery: "idempotent",
    decode: decodeReplaceRequest,
    encode: encodeReplaceOutcome
  })
});

export function repositoryWorkspaceAdequacyBindings(options = {}) {
  const adapter = options.adapter ?? workspace;
  return Object.entries(SITE).map(([operation, site]) => ({
    bindingId: `repository-workspace-adequacy.${operation}.v2`,
    driverId: "repository-workspace-adequacy",
    packageName: "@tkersey/world-capabilities/repository-workspace-adequacy",
    interfaceId: effectInterfaceId(site.label),
    payloadSchemaId: digest(site.payload),
    resultSchemaId: digest(site.result),
    applicationIds: [digest(ADEQUACY_APPLICATION_ID)],
    authorityRequirements: site.authority,
    target: {
      descriptorFingerprint: site.descriptor,
      actuatorRef: site.actuator,
      actuationClass: "repository"
    },
    adapter,
    decodePayload: (bytes) => Object.freeze({ operation, ...site.decode(bytes) }),
    encodeOutcome: (outcome) => site.encode(outcome.payload),
    configurationIdentity: workspaceConfigurationIdentity,
    recoveryClass: site.recovery
  }));
}

function workspaceConfigurationIdentity(context, projected) {
  const root = typeof context?.workspaceRootReal === "string"
    ? context.workspaceRootReal
    : resolve(String(context?.workspaceRoot ?? ""));
  const hasher = createHash("sha256");
  hasher.update("world.capability-configuration.v1\0");
  hasher.update("repository-workspace-adequacy\0");
  hasher.update(root);
  hasher.update("\0");
  hasher.update(projected.payload.operation);
  return hasher.digest("hex");
}

function digest(value) {
  return Buffer.from(value, "hex");
}
