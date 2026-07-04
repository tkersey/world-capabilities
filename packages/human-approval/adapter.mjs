const packManifest = {
  driverId: "human-approval",
  packageName: "@tkersey/world-capabilities/human-approval"
};

function status(hostRequest, wanted, fallback = "rejected") {
  const statuses = hostRequest?.responseSchema?.statuses ?? [];
  if (statuses.includes(wanted)) return wanted;
  if (statuses.includes(fallback)) return fallback;
  return "failed";
}

function reject(hostRequest, reason) {
  return { requestId: hostRequest?.requestId ?? "unknown", status: status(hostRequest, "rejected"), payload: { reason } };
}

function reason(context, hostRequest) {
  if (!hostRequest?.requestId) return "missing_request_id";
  if (!hostRequest?.target?.descriptorFingerprint) return "missing_descriptor_fingerprint";
  if (!hostRequest?.idempotencyKey) return "missing_idempotency_key";
  if (!Array.isArray(hostRequest?.responseSchema?.statuses) || hostRequest.responseSchema.statuses.length === 0) return "unsupported_response_schema";
  if (!String(hostRequest.payload?.anchor ?? "").startsWith("world:host-request:")) return "missing_world_host_request_anchor";
  if (context?.policy?.auditOnly || context?.policy?.humanLive === false) return "policy_denied";
  if (context?.policy?.denyPackages?.includes(packManifest.packageName)) return "package_denied";
  return null;
}

export function manifest() {
  return packManifest;
}

export async function preflight(context, hostRequest) {
  const denied = reason(context, hostRequest);
  if (denied) return reject(hostRequest, denied);
  return { requestId: hostRequest.requestId, status: "ok", payload: { ready: true } };
}

export async function resolve(context, hostRequest) {
  const denied = reason(context, hostRequest);
  if (denied) return reject(hostRequest, denied);
  const mode = context?.approvalMode ?? "deny";
  if (mode === "allow") return { requestId: hostRequest.requestId, status: status(hostRequest, "ok"), payload: { approved: true } };
  return { requestId: hostRequest.requestId, status: status(hostRequest, "rejected"), payload: { approved: false } };
}

export async function dryRun(context, hostRequest) {
  const denied = reason({ ...context, policy: { ...(context?.policy ?? {}), humanLive: true, auditOnly: false } }, hostRequest);
  if (denied) return reject(hostRequest, denied);
  return { requestId: hostRequest.requestId, status: "deferred", payload: { promptWouldBeShown: false } };
}

export async function recover(context, effectRecord) {
  return { status: "failed", payload: { reason: "recover_unsupported_without_operator_event_id" } };
}

export async function shadow(context, hostRequest, recordedResolution) {
  return { status: "failed", payload: { reason: "shadow_unsupported" } };
}
