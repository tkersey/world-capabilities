import { createHash } from "node:crypto";
import { resolve } from "node:path";

import * as workspace from "../../../packages/repository-workspace-actuality/adapter.mjs";
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
} from "./repository_repair_codecs.mjs";

export const ACTUALITY_APPLICATION_ID =
  "14926c1ecd6436230718f3e1772f2946916ec0959fc81a8fab94190cc2e9a3d5";

const SITE = Object.freeze({
  list: Object.freeze({
    label: "repo.list.v1",
    payload: "a0daed086016083f9ca1f3e218bf4d87a31ecd59df343c96cee04a2966f3a084",
    result: "3b014169da863d8aa4dcc9869a54388d4ba7742f579a84514247f94c3763efa1",
    authority: 2n,
    descriptor: "desc.repository-list.v1",
    actuator: "actuator.repository-list.v1",
    recovery: "idempotent",
    decode: decodeListRequest,
    encode: encodeListResult
  }),
  read: Object.freeze({
    label: "repo.read.v1",
    payload: "017baa484f81869bf82b34408d483e93be77164caf80ac5b445692a69a5aa1d9",
    result: "0ab085b6f5907acca30164145cee04860fa3e4f978585b8a3bf342f0c23d549e",
    authority: 2n,
    descriptor: "desc.repository-read.v1",
    actuator: "actuator.repository-read.v1",
    recovery: "idempotent",
    decode: decodeReadRequest,
    encode: encodeReadResult
  }),
  search: Object.freeze({
    label: "repo.search.v1",
    payload: "47969b29a68017cd5182e7a137c94451d83516d5d52791bab61deb29304f92c4",
    result: "d83cc693f03934c13c077e0c7942664dceddd0d9b9e7b8ad0d0e3f9dbd46a508",
    authority: 2n,
    descriptor: "desc.repository-search.v1",
    actuator: "actuator.repository-search.v1",
    recovery: "idempotent",
    decode: decodeSearchRequest,
    encode: encodeSearchResult
  }),
  test: Object.freeze({
    label: "repo.test.v1",
    payload: "24410ad4e4d67a9045bf094f6535e0866753bf28918b25536f09ec43285d1e2c",
    result: "78c8c914d3fc220cd0c35cde51d36d7456a2de8414c20852571e2cf949bcecc3",
    authority: 6n,
    descriptor: "desc.repository-test.v1",
    actuator: "actuator.repository-test.v1",
    recovery: "retryable",
    decode: decodeTestRequest,
    encode: encodeTestResult
  }),
  replace: Object.freeze({
    label: "repo.replace.approved.v1",
    payload: "67524986efb03d7d820d7096c08e061c7c3120434514dd5b943cfd65c9081fa7",
    result: "7b1c3b72d83fec3c6ad3c4013bf61fb4e12695a58d0871ce7e88a31efe40322f",
    authority: 20n,
    descriptor: "desc.repository-replace-approved.v1",
    actuator: "actuator.repository-replace-approved.v1",
    recovery: "idempotent",
    decode: decodeReplaceRequest,
    encode: encodeReplaceOutcome
  })
});

export function repositoryWorkspaceBindings(options = {}) {
  const adapter = options.adapter ?? workspace;
  return Object.entries(SITE).map(([operation, site]) => ({
    bindingId: `repository-workspace-actuality.${operation}.v1`,
    driverId: "repository-workspace-actuality",
    packageName: "@tkersey/world-capabilities/repository-workspace-actuality",
    interfaceId: effectInterfaceId(site.label),
    payloadSchemaId: digest(site.payload),
    resultSchemaId: digest(site.result),
    applicationIds: [digest(ACTUALITY_APPLICATION_ID)],
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
  hasher.update("repository-workspace-actuality\0");
  hasher.update(root);
  hasher.update("\0");
  hasher.update(projected.payload.operation);
  return hasher.digest("hex");
}

function digest(value) {
  return Buffer.from(value, "hex");
}
