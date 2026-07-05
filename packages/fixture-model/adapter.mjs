const packManifest = {
  driverId: "fixture-model",
  packageName: "@tkersey/world-capabilities/fixture-model",
  supportedActuationClasses: ["model"],
  supportedActuatorRefs: ["actuator.fixture-model"],
  supportedDescriptorFingerprints: ["desc.fixture-model.v0"],
  supportedResponseStatuses: ["ok", "rejected", "failed"]
};

const FORBIDDEN_EVIDENCE_KEYS = [
  "turnReceiptBytes",
  "archiveAppendBatchBytes",
  "capsuleBytes",
  "chronicleEventBytes",
  "chronicleCommitBytes",
  "actuationReceiptBytes",
  "boundaryModuleBytes",
  "executableImageBytes",
  "turnClosureBytes",
  "worldAuthoredEvidence",
  "boundaryAuthoredEvidence",
  "archiveMomentBytes",
  "archiveSealBytes"
];

function tooDeep(value, depth = 0) {
  if (depth > 8) return true;
  if (!value || typeof value !== "object") return false;
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.some((item) => tooDeep(item, depth + 1));
}

function packagePolicyReason(context) {
  if (context?.policy?.denyPackages?.includes(packManifest.packageName)) return "package_denied";
  if (context?.policy?.allowPackages && !context.policy.allowPackages.includes(packManifest.packageName)) return "package_not_allowed";
  return null;
}

function hostilePayloadReason(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of FORBIDDEN_EVIDENCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return key === "worldAuthoredEvidence" ? "forbidden_world_evidence" : "forbidden_evidence";
  }
  if (value.duplicateResolution || value.staleResolution) return "invalid_resolution_state";
  if (value.variant?.kind === "unknown") return "malformed_sum_variant";
  if (value.simulateOversizedResponse) return "oversized_response";
  if (value.diagnostic) return "secret_shaped_diagnostics";
  for (const item of Object.values(value)) {
    const reason = hostilePayloadReason(item);
    if (reason) return reason;
  }
  return null;
}

function baseCheck(hostRequest) {
  if (!hostRequest || typeof hostRequest !== "object") return "host_request_not_object";
  if (!hostRequest.requestId) return "missing_request_id";
  if (!hostRequest.idempotencyKey) return "missing_idempotency_key";
  if (!hostRequest.target?.descriptorFingerprint) return "missing_descriptor_fingerprint";
  if (!packManifest.supportedDescriptorFingerprints.includes(hostRequest.target.descriptorFingerprint)) return "unsupported_descriptor_fingerprint";
  if (!hostRequest.target.actuatorRef) return "missing_actuator_ref";
  if (!packManifest.supportedActuatorRefs.includes(hostRequest.target.actuatorRef)) return "unsupported_actuator_ref";
  if (!hostRequest.target.actuationClass) return "missing_actuation_class";
  if (!packManifest.supportedActuationClasses.includes(hostRequest.target.actuationClass)) return "unsupported_actuation_class";
  const statuses = hostRequest.responseSchema?.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) return "unsupported_response_schema";
  if (!packManifest.supportedResponseStatuses.every((item) => statuses.includes(item))) return "unsupported_response_schema";
  if (tooDeep(hostRequest.payload)) return "excessive_nesting";
  const hostile = hostilePayloadReason(hostRequest.payload);
  if (hostile) return hostile;
  return null;
}

function status(hostRequest, wanted, fallback = "failed") {
  const statuses = hostRequest?.responseSchema?.statuses ?? [];
  if (statuses.includes(wanted)) return wanted;
  if (statuses.includes(fallback)) return fallback;
  return "failed";
}

function rejection(hostRequest, reason) {
  return { requestId: hostRequest?.requestId ?? "unknown", status: status(hostRequest, "rejected"), payload: { reason } };
}

export function manifest() {
  return packManifest;
}

export async function preflight(context, hostRequest) {
  const reason = baseCheck(hostRequest);
  if (reason) return rejection(hostRequest, reason);
  const policyReason = packagePolicyReason(context);
  if (policyReason) return rejection(hostRequest, policyReason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { mode: "fixture" } };
}

export async function resolve(context, hostRequest) {
  const failed = await preflight(context, hostRequest);
  if (failed.status !== "ok") return failed;
  if (!hostRequest.payload?.prompt) return rejection(hostRequest, "malformed_prompt");
  return {
    requestId: hostRequest.requestId,
    status: status(hostRequest, "ok"),
    payload: { action: "fixture.action", arguments: { source: "fixture-model" } },
    diagnostics: { mode: "fixture" }
  };
}

export async function dryRun(context, hostRequest) {
  const failed = await preflight(context, hostRequest);
  if (failed.status !== "ok") return failed;
  return { requestId: hostRequest.requestId, status: "ok", payload: { wouldResolve: true, mode: "dry-run" } };
}

export async function recover(context, effectRecord) {
  return { status: "failed", payload: { reason: "recover_unsupported" } };
}

export async function shadow(context, hostRequest, recordedResolution) {
  return { requestId: hostRequest?.requestId ?? "unknown", status: "ok", payload: { matched: true, recordedResolution } };
}
