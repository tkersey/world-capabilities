import { readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { join, resolve as pathResolve, relative, isAbsolute } from "node:path";

const packManifest = {
  driverId: "sandbox-files",
  packageName: "@tkersey/world-capabilities/sandbox-files"
};

function status(hostRequest, wanted, fallback = "rejected") {
  const statuses = hostRequest?.responseSchema?.statuses ?? [];
  if (statuses.includes(wanted)) return wanted;
  if (statuses.includes(fallback)) return fallback;
  return "failed";
}

function out(hostRequest, wanted, reason, extra = {}) {
  return { requestId: hostRequest?.requestId ?? "unknown", status: status(hostRequest, wanted), payload: { reason, ...extra } };
}

async function safePath(context, requested) {
  if (!context?.fixtureRoot) return { ok: false, reason: "missing_allowed_root" };
  if (!requested || typeof requested !== "string") return { ok: false, reason: "missing_path" };
  if (isAbsolute(requested)) return { ok: false, reason: "absolute_path_rejected" };
  if (requested.split(/[\\/]/).includes("..")) return { ok: false, reason: "path_traversal_rejected" };
  const root = pathResolve(context.fixtureRoot);
  const full = pathResolve(join(root, requested));
  if (!full.startsWith(`${root}/`) && full !== root) return { ok: false, reason: "path_escape_rejected" };
  try {
    const rootReal = await realpath(root);
      const parentReal = await realpath(pathResolve(full, ".."));
    if (!parentReal.startsWith(rootReal)) return { ok: false, reason: "symlink_ancestor_rejected" };
    try {
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) return { ok: false, reason: "final_symlink_rejected" };
    } catch {}
  } catch {}
  return { ok: true, full, display: relative(root, full) };
}

async function preEffectReason(context, hostRequest) {
  if (!hostRequest?.requestId) return "missing_request_id";
  if (!hostRequest?.target?.descriptorFingerprint) return "missing_descriptor_fingerprint";
  if (!hostRequest?.idempotencyKey) return "missing_idempotency_key";
  if (!Array.isArray(hostRequest?.responseSchema?.statuses) || hostRequest.responseSchema.statuses.length === 0) return "unsupported_response_schema";
  if (hostRequest.payload?.worldAuthoredEvidence) return "forbidden_world_evidence";
  const path = await safePath(context, hostRequest.payload?.path);
  if (!path.ok) return path.reason;
  if (hostRequest.payload?.operation === "write" && !context?.policy?.fileWrite) return "write_policy_required";
  if (hostRequest.payload?.operation === "write" && context?.policy?.approvalRequired && !context?.approval?.approved) return "approval_required";
  return null;
}

export function manifest() {
  return packManifest;
}

export async function preflight(context, hostRequest) {
  const reason = await preEffectReason(context, hostRequest);
  if (reason) return out(hostRequest, "rejected", reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { ready: true } };
}

export async function resolve(context, hostRequest) {
  const reason = await preEffectReason(context, hostRequest);
  if (reason) return out(hostRequest, "rejected", reason);
  const path = await safePath(context, hostRequest.payload.path);
  context.effectAttempted = (context.effectAttempted ?? 0) + 1;
  if (hostRequest.payload.operation === "read") {
    const bytes = await readFile(path.full, "utf8");
    return { requestId: hostRequest.requestId, status: status(hostRequest, "ok"), payload: { bytes } };
  }
  if (hostRequest.payload.operation === "write") {
    await writeFile(path.full, String(hostRequest.payload.bytes ?? ""));
    return { requestId: hostRequest.requestId, status: status(hostRequest, "ok"), payload: { path: path.display, idempotencyKey: hostRequest.idempotencyKey } };
  }
  return out(hostRequest, "rejected", "unsupported_file_operation");
}

export async function dryRun(context, hostRequest) {
  const path = await safePath(context, hostRequest?.payload?.path);
  if (!path.ok) return out(hostRequest, "rejected", path.reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { wouldTouch: path.display, effect: false } };
}

export async function recover(context, effectRecord) {
  return { status: "failed", payload: { reason: "recover_unsupported" } };
}

export async function shadow(context, hostRequest, recordedResolution) {
  return { status: "failed", payload: { reason: "shadow_unsupported" } };
}
