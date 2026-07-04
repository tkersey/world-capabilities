const packManifest = {
  driverId: "local-memory-kv",
  packageName: "@tkersey/world-capabilities/local-memory-kv"
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

function check(hostRequest) {
  if (!hostRequest?.requestId) return "missing_request_id";
  if (!hostRequest?.idempotencyKey) return "missing_idempotency_key";
  if (!hostRequest?.target?.descriptorFingerprint) return "missing_descriptor_fingerprint";
  if (!Array.isArray(hostRequest?.responseSchema?.statuses) || hostRequest.responseSchema.statuses.length === 0) return "unsupported_response_schema";
  if (hostRequest.payload?.worldAuthoredEvidence) return "forbidden_world_evidence";
  if (String(hostRequest.payload?.key ?? "").length > 128) return "key_too_large";
  if (String(hostRequest.payload?.value ?? "").length > 1024) return "value_too_large";
  return null;
}

export function manifest() {
  return packManifest;
}

export async function preflight(context, hostRequest) {
  const reason = check(hostRequest);
  if (reason) return reject(hostRequest, reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { ready: true } };
}

export async function resolve(context, hostRequest) {
  const reason = check(hostRequest);
  if (reason) return reject(hostRequest, reason);
  const store = context.kv ?? new Map();
  context.kv = store;
  if (hostRequest.payload.operation === "put") {
    store.set(hostRequest.payload.key, hostRequest.payload.value);
    return { requestId: hostRequest.requestId, status: status(hostRequest, "ok"), payload: { stored: true, durability: "none" } };
  }
  if (hostRequest.payload.operation === "get") {
    if (!store.has(hostRequest.payload.key)) return reject(hostRequest, "missing_key");
    return { requestId: hostRequest.requestId, status: status(hostRequest, "ok"), payload: { value: store.get(hostRequest.payload.key), durability: "none" } };
  }
  return reject(hostRequest, "unsupported_memory_operation");
}

export async function dryRun(context, hostRequest) {
  const reason = check(hostRequest);
  if (reason) return reject(hostRequest, reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { wouldMutateProcessMemory: hostRequest.payload.operation === "put" } };
}

export async function recover(context, effectRecord) {
  return { status: "failed", payload: { reason: "recover_unsupported_no_durability_claim" } };
}

export async function shadow(context, hostRequest, recordedResolution) {
  return { status: "failed", payload: { reason: "shadow_unsupported" } };
}
