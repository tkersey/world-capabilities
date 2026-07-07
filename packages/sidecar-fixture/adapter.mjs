const packManifest = {
  driverId: "sidecar-fixture",
  packageName: "@tkersey/world-capabilities/sidecar-fixture",
  authorityLabels: ["sidecar.fixture"],
  supportedActuationClasses: ["sidecar"],
  supportedActuatorRefs: ["actuator.sidecar-fixture"],
  supportedDescriptorFingerprints: ["desc.sidecar-fixture.v0"],
  supportedResponseStatuses: ["ok", "rejected", "failed"],
  secretRequirements: []
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

function status(hostRequest, wanted, fallback = "failed") {
  const statuses = hostRequest?.responseSchema?.statuses ?? [];
  if (statuses.includes(wanted)) return wanted;
  if (statuses.includes(fallback)) return fallback;
  return "failed";
}

function reject(hostRequest, reason) {
  return { requestId: hostRequest?.requestId ?? "unknown", status: status(hostRequest, "rejected"), payload: { reason } };
}

function tooDeep(value, depth = 0) {
  if (depth > 8) return true;
  if (!value || typeof value !== "object") return false;
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.some((item) => tooDeep(item, depth + 1));
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

function check(context, hostRequest) {
  if (!hostRequest?.requestId) return "missing_request_id";
  if (!hostRequest?.idempotencyKey) return "missing_idempotency_key";
  if (!hostRequest?.target?.descriptorFingerprint) return "missing_descriptor_fingerprint";
  if (!packManifest.supportedDescriptorFingerprints.includes(hostRequest.target.descriptorFingerprint)) return "unsupported_descriptor_fingerprint";
  if (!hostRequest.target.actuatorRef) return "missing_actuator_ref";
  if (!packManifest.supportedActuatorRefs.includes(hostRequest.target.actuatorRef)) return "unsupported_actuator_ref";
  if (!hostRequest.target.actuationClass) return "missing_actuation_class";
  if (!packManifest.supportedActuationClasses.includes(hostRequest.target.actuationClass)) return "unsupported_actuation_class";
  const statuses = hostRequest.responseSchema?.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) return "unsupported_response_schema";
  if (!packManifest.supportedResponseStatuses.every((item) => statuses.includes(item))) return "unsupported_response_schema";
  if (context?.policy?.denyPackages?.includes(packManifest.packageName)) return "package_denied";
  if (context?.policy?.allowPackages && !context.policy.allowPackages.includes(packManifest.packageName)) return "package_not_allowed";
  if (tooDeep(hostRequest.payload)) return "excessive_nesting";
  const hostile = hostilePayloadReason(hostRequest.payload);
  if (hostile) return hostile;
  return null;
}

export function manifest() {
  return structuredClone(packManifest);
}

export async function preflight(context, hostRequest) {
  const reason = check(context, hostRequest);
  if (reason) return reject(hostRequest, reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { sidecarConfigured: true } };
}

export async function resolve(context, hostRequest) {
  const reason = check(context, hostRequest);
  if (reason) return reject(hostRequest, reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { sidecarWouldResolve: true } };
}

export async function dryRun(context, hostRequest) {
  const reason = check(context, hostRequest);
  if (reason) return reject(hostRequest, reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { sidecarInvoked: false } };
}

export async function recover(context, effectRecord) {
  return { status: "failed", payload: { reason: "recover_unsupported" } };
}

export async function shadow(context, hostRequest, recordedResolution) {
  return { status: "failed", payload: { reason: "shadow_unsupported" } };
}
