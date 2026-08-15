import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import decisionContract from "./decision-contract.json" with { type: "json" };

const PACKAGE_NAME = "@tkersey/world-capabilities/repository-repair-decision-fixture";
const APPLICATION_ID = "9de00d549101541f91554399aa4114020ea9e4470fe64c1a40b93f52e6243245";
export const DECISION_CONTRACT_DIGEST = "eff01f65a1bc5d46693af84be7a2ce2a0cd07e7f6d7f20b7cb91aee76c2ad639";
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
const admittedContract = admitDecisionContract();

const packManifest = Object.freeze({
  driverId: "repository-repair-decision-fixture",
  packageName: PACKAGE_NAME,
  authorityLabels: ["model.fixture"],
  supportedActuationClasses: ["model"],
  supportedActuatorRefs: ["actuator.repository-repair-decision-fixture.v1"],
  supportedDescriptorFingerprints: ["desc.repository-repair-decision-fixture.v1"],
  supportedResponseStatuses: ["ok", "rejected", "failed"],
  secretRequirements: [],
  decisionContractDigest: admittedContract.semanticDigest
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
  if (request.payload.contractDigest !== DECISION_CONTRACT_DIGEST) return "decision_contract_mismatch";
  if (request.payload.phase !== "decide") return "unsupported_decision_phase";
  if (!request.payload.context || typeof request.payload.context !== "object") return "decision_context_required";
  if (Object.hasOwn(request.payload, "instructions") || Object.hasOwn(request.payload, "actionCatalog") ||
      Object.hasOwn(request.payload, "history")) return "static_contract_in_dynamic_turn";
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
  const context = request.context;
  const evidence = context.evidence;
  if (!context.listing) return action("list_repository", {});
  if (!context.packageDocument) return action("read_file", { role: "package", path: "package.json" });
  if (!context.sourceDocument && !evidence.mutationApplied) {
    return action("read_file", { role: "source", path: "src/range.mjs" });
  }
  if (!context.testDocument) return action("read_file", { role: "test", path: "test/range.test.mjs" });
  if (!context.latestSearch && !evidence.mutationApplied) {
    return action("search_text", { query: "normalizeRange", path_prefix: "src" });
  }
  if (!evidence.failingTestObserved) return action("run_tests", { suite: "default" });
  if (!evidence.mutationApplied) {
    if (context.latestTest?.passed !== false) throw new Error("failing_test_required");
    if (context.sourceDocument?.path !== "src/range.mjs") throw new Error("source_document_required");
    return action("replace_file", {
      path: "src/range.mjs",
      expected_sha256: context.sourceDocument.sha256,
      replacement: CORRECTED_SOURCE,
      rationale: "normalizeRange must preserve ascending bounds and swap only descending bounds."
    });
  }
  if (!evidence.passingTestObserved) return action("run_tests", { suite: "default" });
  if (context.latestTest?.passed !== true) throw new Error("passing_test_required");
  if (context.replacement?.kind !== "applied") throw new Error("replacement_application_required");
  return action("final", {
    summary: "Corrected normalizeRange and observed the complete Bun test suite passing.",
    changed_files: ["src/range.mjs"],
    tests_passed: true,
    final_source_sha256: context.replacement.payload.newSha256
  });
}

function admitDecisionContract() {
  const bytes = readFileSync(new URL("./decision-contract.bin", import.meta.url));
  if (bytes.length < 40 || bytes.subarray(0, 8).toString("ascii") !== "AGT_DCT2") {
    throw new Error("decision_contract_format_invalid");
  }
  const semanticDigest = bytes.subarray(-32).toString("hex");
  const computedDigest = createHash("sha256").update(bytes.subarray(0, -32)).digest("hex");
  if (semanticDigest !== computedDigest || semanticDigest !== DECISION_CONTRACT_DIGEST ||
      decisionContract.semanticDigest !== semanticDigest || decisionContract.format !== "agent-decision-contract/v2") {
    throw new Error("decision_contract_mismatch");
  }
  return Object.freeze({ semanticDigest });
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
