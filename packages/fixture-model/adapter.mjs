const packManifest = {
  driverId: "fixture-model",
  packageName: "@tkersey/world-capabilities/fixture-model"
};

function baseCheck(hostRequest) {
  if (!hostRequest || typeof hostRequest !== "object") return "host_request_not_object";
  if (!hostRequest.requestId) return "missing_request_id";
  if (!hostRequest.idempotencyKey) return "missing_idempotency_key";
  if (!hostRequest.target?.descriptorFingerprint) return "missing_descriptor_fingerprint";
  if (!Array.isArray(hostRequest.responseSchema?.statuses) || hostRequest.responseSchema.statuses.length === 0) return "unsupported_response_schema";
  if (hostRequest.payload?.worldAuthoredEvidence) return "forbidden_world_evidence";
  if (hostRequest.payload?.variant?.kind === "unknown") return "malformed_sum_variant";
  if (hostRequest.payload?.duplicateResolution || hostRequest.payload?.staleResolution) return "invalid_resolution_state";
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
