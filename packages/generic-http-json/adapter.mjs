const packManifest = {
  driverId: "generic-http-json",
  packageName: "@tkersey/world-capabilities/generic-http-json"
};

function status(hostRequest, wanted, fallback = "failed") {
  const statuses = hostRequest?.responseSchema?.statuses ?? [];
  if (statuses.includes(wanted)) return wanted;
  if (statuses.includes(fallback)) return fallback;
  return "failed";
}

function outcome(hostRequest, wanted, reason, extra = {}) {
  return {
    requestId: hostRequest?.requestId ?? "unknown",
    status: status(hostRequest, wanted),
    payload: { reason, ...extra }
  };
}

function preEffectReason(context, hostRequest) {
  if (!hostRequest || typeof hostRequest !== "object") return "host_request_not_object";
  if (!hostRequest.requestId) return "missing_request_id";
  if (!hostRequest.target?.descriptorFingerprint) return "missing_descriptor_fingerprint";
  if (!hostRequest.idempotencyKey) return "missing_idempotency_key";
  if (!Array.isArray(hostRequest.responseSchema?.statuses) || hostRequest.responseSchema.statuses.length === 0) return "unsupported_response_schema";
  if (hostRequest.payload?.worldAuthoredEvidence) return "forbidden_world_evidence";
  if (!hostRequest.payload?.url || typeof hostRequest.payload.url !== "string") return "malformed_target";
  if (!["GET", "POST", "PUT", "DELETE"].includes(hostRequest.payload.method)) return "method_not_allowed";
  if (hostRequest.payload.requiresSecret && !context?.secrets?.[hostRequest.payload.requiresSecret]) return "missing_secret";
  if (context?.policy?.auditOnly) return "audit_only";
  if (!context?.policy?.live && !context?.policy?.networkLive) return "network_denied";
  if (hostRequest.payload.simulateOversizedResponse) return "oversized_response";
  if (hostRequest.payload.diagnostic) return "secret_shaped_diagnostics";
  return null;
}

export function manifest() {
  return packManifest;
}

export async function preflight(context, hostRequest) {
  const reason = preEffectReason(context, hostRequest);
  if (reason) return outcome(hostRequest, "rejected", reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { ready: true } };
}

export async function resolve(context, hostRequest) {
  const denied = preEffectReason(context, hostRequest);
  if (denied) return outcome(hostRequest, denied.includes("oversized") || denied.includes("diagnostics") ? "failed" : "rejected", denied);
  context.effectAttempted = (context.effectAttempted ?? 0) + 1;
  return {
    requestId: hostRequest.requestId,
    status: status(hostRequest, "ok"),
    payload: { dryRunOnly: false, httpStatus: 200 },
    diagnostics: { endpointInvoked: true }
  };
}

export async function dryRun(context, hostRequest) {
  const denied = preEffectReason({ ...context, policy: { ...(context?.policy ?? {}), auditOnly: false, networkLive: true } }, hostRequest);
  if (denied && !["network_denied", "audit_only"].includes(denied)) return outcome(hostRequest, "rejected", denied);
  return { requestId: hostRequest?.requestId ?? "unknown", status: "ok", payload: { wouldFetch: false, url: hostRequest?.payload?.url } };
}

export async function recover(context, effectRecord) {
  return { status: "failed", payload: { reason: "recover_unsupported_without_stable_request_id" } };
}

export async function shadow(context, hostRequest, recordedResolution) {
  return { requestId: hostRequest?.requestId ?? "unknown", status: "ok", payload: { liveEndpointInvoked: false, recordedResolution } };
}
