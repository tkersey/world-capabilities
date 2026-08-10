const PACKAGE_NAME = "@tkersey/world-capabilities/repository-repair-decision-fixture";
const APPLICATION_ID = "26f5ab2b7e86994e5d3b234bb32447891906276853c094f0ac73def2b99610bb";
const FORBIDDEN_EVIDENCE_KEYS = [
  "turnReceiptBytes", "archiveAppendBatchBytes", "capsuleBytes", "chronicleEventBytes",
  "chronicleCommitBytes", "actuationReceiptBytes", "boundaryModuleBytes", "executableImageBytes",
  "turnClosureBytes", "worldAuthoredEvidence", "boundaryAuthoredEvidence", "archiveMomentBytes",
  "archiveSealBytes"
];
const CORRECTED_SOURCE = `export function normalizeRange(start, end) {
  if (start <= end) {
    return { start, end };
  }
  return { start: end, end: start };
}
`;

const packManifest = Object.freeze({
  driverId: "repository-repair-decision-fixture",
  packageName: PACKAGE_NAME,
  authorityLabels: ["model.fixture"],
  supportedActuationClasses: ["model"],
  supportedActuatorRefs: ["actuator.repository-repair-decision-fixture.v1"],
  supportedDescriptorFingerprints: ["desc.repository-repair-decision-fixture.v1"],
  supportedResponseStatuses: ["ok", "rejected", "failed"],
  secretRequirements: []
});

export function manifest() { return structuredClone(packManifest); }

export async function preflight(context, request) {
  const reason = admissionReason(context, request);
  if (reason) return reject(request, reason);
  try {
    scriptedAction(request.payload);
  } catch (error) {
    return reject(request, safeReason(error));
  }
  return { requestId: request.requestId, status: "ok", payload: { admitted: true } };
}

export async function resolve(context, request) {
  const admitted = await preflight(context, request);
  if (admitted.status !== "ok") return admitted;
  context.effectAttempts = (context.effectAttempts ?? 0) + 1;
  context.modelCalls = (context.modelCalls ?? 0) + 1;
  return { requestId: request.requestId, status: "ok", payload: scriptedAction(request.payload) };
}

export async function dryRun(context, request) {
  const admitted = await preflight(context, request);
  if (admitted.status !== "ok") return admitted;
  return { requestId: request.requestId, status: "ok", payload: { action: scriptedAction(request.payload), effect: false } };
}

export async function recover(_context, effectRecord) {
  if (effectRecord?.recordedResolution) return structuredClone(effectRecord.recordedResolution);
  return { status: "failed", payload: { reason: "recorded_resolution_required" } };
}

export async function shadow(_context, request, recordedResolution) {
  return { requestId: request?.requestId ?? "unknown", status: "ok", payload: { matched: true, recordedResolution } };
}

function admissionReason(context, request) {
  if (!request || typeof request !== "object") return "host_request_not_object";
  if (typeof request.requestId !== "string" || request.requestId.length === 0) return "missing_request_id";
  if (typeof request.idempotencyKey !== "string" || request.idempotencyKey.length === 0) return "missing_idempotency_key";
  if (request.target?.descriptorFingerprint !== packManifest.supportedDescriptorFingerprints.at(0)) return "unsupported_descriptor_fingerprint";
  if (request.target?.actuatorRef !== packManifest.supportedActuatorRefs.at(0)) return "unsupported_actuator_ref";
  if (request.target?.actuationClass !== "model") return "unsupported_actuation_class";
  const statuses = request.responseSchema?.statuses;
  if (!Array.isArray(statuses) || !statuses.includes("ok") || !statuses.some((value) => value === "rejected" || value === "failed")) {
    return "unsupported_response_schema";
  }
  const packageReason = packagePolicyReason(context);
  if (packageReason) return packageReason;
  const hostileReason = hostilePayloadReason(request.payload);
  if (hostileReason) return hostileReason;
  if (context?.applicationId !== APPLICATION_ID) return "application_not_admitted";
  if (context?.policy?.repositoryRepairDecisionFixture !== true) return "fixture_policy_required";
  if (!request.payload || typeof request.payload !== "object") return "decision_request_required";
  if (request.payload.phase !== "decide") return "unsupported_decision_phase";
  if (!Array.isArray(request.payload.history)) return "decision_history_required";
  return null;
}

function packagePolicyReason(context) {
  const policy = context?.policy;
  if (policy && Object.prototype.hasOwnProperty.call(policy, "denyPackages") &&
      (!Array.isArray(policy.denyPackages) || policy.denyPackages.includes(PACKAGE_NAME))) return "package_denied";
  if (policy && Object.prototype.hasOwnProperty.call(policy, "allowPackages") &&
      (!Array.isArray(policy.allowPackages) || !policy.allowPackages.includes(PACKAGE_NAME))) return "package_not_allowed";
  return null;
}

function hostilePayloadReason(value, depth = 0) {
  if (depth > 8) return "excessive_nesting";
  if (!value || typeof value !== "object") return null;
  for (const key of FORBIDDEN_EVIDENCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return key === "worldAuthoredEvidence" ? "forbidden_world_evidence" : "forbidden_evidence";
    }
  }
  if (value.duplicateResolution || value.staleResolution) return "invalid_resolution_state";
  if (value.variant?.kind === "unknown") return "malformed_sum_variant";
  if (value.simulateOversizedResponse) return "oversized_response";
  if (value.diagnostic) return "secret_shaped_diagnostics";
  for (const item of Object.values(value)) {
    const reason = hostilePayloadReason(item, depth + 1);
    if (reason) return reason;
  }
  return null;
}

function scriptedAction(request) {
  const history = request.history;
  switch (history.length) {
    case 0: return action("list_repository", {});
    case 1: requireObservation(history, 0, "list_repository"); return action("read_file", { path: "package.json" });
    case 2: requireObservation(history, 1, "read_file", "package.json"); return action("read_file", { path: "src/range.mjs" });
    case 3: requireObservation(history, 2, "read_file", "src/range.mjs"); return action("read_file", { path: "test/range.test.mjs" });
    case 4: {
      requireObservation(history, 3, "read_file", "test/range.test.mjs");
      return action("search_text", { query: "normalizeRange", path_prefix: "src" });
    }
    case 5: {
      requireObservation(history, 4, "search_text");
      return action("run_tests", { suite: "default" });
    }
    case 6: {
      const test = requireObservation(history, 5, "run_tests");
      if (test.passed !== false) throw new Error("failing_test_required");
      const source = requireObservation(history, 2, "read_file", "src/range.mjs");
      return action("replace_file", {
        path: "src/range.mjs",
        expected_sha256: source.sha256,
        replacement: CORRECTED_SOURCE,
        rationale: "normalizeRange must preserve ascending bounds and swap only descending bounds."
      });
    }
    case 7: {
      const outcome = requireObservation(history, 6, "replace_file");
      if (outcome.kind !== "applied") throw new Error("replacement_application_required");
      return action("run_tests", { suite: "default" });
    }
    case 8: {
      const test = requireObservation(history, 7, "run_tests");
      if (test.passed !== true) throw new Error("passing_test_required");
      const replacement = requireObservation(history, 6, "replace_file");
      if (replacement.kind !== "applied") throw new Error("replacement_application_required");
      return action("final", {
        summary: "Corrected normalizeRange and observed the complete Bun test suite passing.",
        changed_files: ["src/range.mjs"],
        tests_passed: true,
        final_source_sha256: replacement.payload.newSha256
      });
    }
    default: throw new Error("fixture_history_not_admitted");
  }
}

function requireObservation(history, index, kind, path = null) {
  const observation = history.at(index);
  if (!observation || observation.kind !== kind) throw new Error("fixture_history_mismatch");
  if (path !== null && observation.payload?.path !== path) throw new Error("fixture_path_mismatch");
  return observation.payload;
}

function action(name, argumentsValue) { return Object.freeze({ action: name, arguments: Object.freeze(argumentsValue) }); }
function reject(request, reason) {
  const statuses = request?.responseSchema?.statuses ?? [];
  const status = statuses.includes("rejected") ? "rejected" : "failed";
  return { requestId: request?.requestId ?? "unknown", status, payload: { reason } };
}
function safeReason(error) {
  const reason = typeof error?.message === "string" ? error.message : "fixture_decision_failed";
  return /^[a-z0-9_]+$/.test(reason) ? reason : "fixture_decision_failed";
}
