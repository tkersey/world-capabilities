const packManifest = {
  driverId: "sidecar-fixture",
  packageName: "@tkersey/world-capabilities/sidecar-fixture"
};

function reject(hostRequest, reason) {
  return { requestId: hostRequest?.requestId ?? "unknown", status: "rejected", payload: { reason } };
}

function tooDeep(value, depth = 0) {
  if (depth > 8) return true;
  if (!value || typeof value !== "object") return false;
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.some((item) => tooDeep(item, depth + 1));
}

function check(hostRequest) {
  if (!hostRequest?.requestId) return "missing_request_id";
  if (!hostRequest?.idempotencyKey) return "missing_idempotency_key";
  if (!hostRequest?.target?.descriptorFingerprint) return "missing_descriptor_fingerprint";
  if (!Array.isArray(hostRequest?.responseSchema?.statuses) || hostRequest.responseSchema.statuses.length === 0) return "unsupported_response_schema";
  if (!hostRequest.responseSchema.statuses.some((item) => ["ok", "rejected", "failed"].includes(item))) return "unsupported_response_schema";
  if (hostRequest.payload?.worldAuthoredEvidence) return "forbidden_world_evidence";
  if (hostRequest.payload?.duplicateResolution || hostRequest.payload?.staleResolution) return "invalid_resolution_state";
  if (hostRequest.payload?.variant?.kind === "unknown") return "malformed_sum_variant";
  if (hostRequest.payload?.simulateOversizedResponse) return "oversized_response";
  if (hostRequest.payload?.diagnostic) return "secret_shaped_diagnostics";
  if (tooDeep(hostRequest.payload)) return "excessive_nesting";
  return null;
}

export function manifest() {
  return packManifest;
}

export async function preflight(context, hostRequest) {
  const reason = check(hostRequest);
  if (reason) return reject(hostRequest, reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { sidecarConfigured: true } };
}

export async function resolve(context, hostRequest) {
  const reason = check(hostRequest);
  if (reason) return reject(hostRequest, reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { sidecarWouldResolve: true } };
}

export async function dryRun(context, hostRequest) {
  const reason = check(hostRequest);
  if (reason) return reject(hostRequest, reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { sidecarInvoked: false } };
}

export async function recover(context, effectRecord) {
  return { status: "failed", payload: { reason: "recover_unsupported" } };
}

export async function shadow(context, hostRequest, recordedResolution) {
  return { status: "failed", payload: { reason: "shadow_unsupported" } };
}
