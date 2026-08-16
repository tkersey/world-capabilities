import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import decisionContract from "./decision-contract.json" with { type: "json" };

const PACKAGE_NAME = "@tkersey/world-capabilities/router-adequacy-decision-fixture";
const APPLICATION_ID = "7eb84c4aa723014876aa7edf68d0fcbe73915af98cecc98ef382c3ed3c343aaa";
export const DECISION_CONTRACT_DIGEST = "a649bded9c3088cb82d13eaf10c6ca3a6a404e66b735e7118d94d00f63303fd2";
const FORBIDDEN_EVIDENCE_KEYS = [
  "turnReceiptBytes", "archiveAppendBatchBytes", "capsuleBytes", "chronicleEventBytes",
  "chronicleCommitBytes", "actuationReceiptBytes", "boundaryModuleBytes", "executableImageBytes",
  "turnClosureBytes", "worldAuthoredEvidence", "boundaryAuthoredEvidence", "archiveMomentBytes",
  "archiveSealBytes"
];
const SOLUTIONS = Object.freeze({
  methods_source: readFileSync(new URL("./solution/methods.txt", import.meta.url), "utf8"),
  errors_source: readFileSync(new URL("./solution/errors.txt", import.meta.url), "utf8"),
  router_source: readFileSync(new URL("./solution/router.txt", import.meta.url), "utf8"),
  index_source: readFileSync(new URL("./solution/index.txt", import.meta.url), "utf8")
});
const PATHS = Object.freeze({
  readme: "README.md",
  package: "package.json",
  methods_source: "src/methods.mjs",
  pattern_source: "src/pattern.mjs",
  errors_source: "src/errors.mjs",
  router_source: "src/router.mjs",
  index_source: "src/index.mjs",
  methods_test: "test/methods.test.mjs",
  router_test: "test/router.test.mjs"
});
const admittedContract = admitDecisionContract();

const packManifest = Object.freeze({
  driverId: "router-adequacy-decision-fixture",
  packageName: PACKAGE_NAME,
  authorityLabels: ["model.fixture"],
  supportedActuationClasses: ["model"],
  supportedActuatorRefs: ["actuator.router-adequacy-decision-fixture.v1"],
  supportedDescriptorFingerprints: ["desc.router-adequacy-decision-fixture.v1"],
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
  if (context?.policy?.routerAdequacyDecisionFixture !== true) return "fixture_policy_required";
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
  const decision = request.counters.decisions;
  if (!Number.isInteger(decision) || decision < 0 || decision > 23) throw new Error("unexpected_decision_counter");
  if (decision === 0) {
    if (context.listing !== null || context.documents.length !== 0) throw new Error("unexpected_initial_memory");
    return action("list_repository", {});
  }
  if (decision >= 1 && decision <= 9) {
    if (!context.listing || context.documents.length !== decision - 1) throw new Error("unexpected_read_memory");
    return readAction(readSlotForDecision(decision));
  }
  if (context.documents.length !== 9) throw new Error("all_documents_required");
  if (decision === 10) return action("run_tests", { suite: "default" });
  if (decision === 11) {
    if (!context.evidence.baselineFailureObserved || context.latestTest?.passed !== false) throw new Error("failing_test_required");
    return action("search_text", { query: "method_not_allowed", path_prefix: "" });
  }
  if (decision === 12) return replacementAction(context, "methods_source");
  if (decision === 13 || decision === 16 || decision === 19 || decision === 22) {
    const expectedMutation = decision === 13 ? 1 : decision === 16 ? 2 : decision === 19 ? 3 : 4;
    if (context.evidence.mutationCount !== expectedMutation) throw new Error("mutation_count_mismatch");
    return action("run_tests", { suite: "default" });
  }
  if (decision === 14) return readAction("methods_source");
  if (decision === 15) return replacementAction(context, "errors_source");
  if (decision === 17) return readAction("errors_source");
  if (decision === 18) return replacementAction(context, "router_source");
  if (decision === 20) return readAction("router_source");
  if (decision === 21) return replacementAction(context, "index_source");
  if (decision === 23) {
    if (context.evidence.mutationCount !== 4 || context.evidence.latestTestPassed !== true ||
        context.evidence.lastTestMutationCount !== 4 || context.mutations.length !== 4) {
      throw new Error("fresh_passing_fourth_test_required");
    }
    return action("final", {
      summary: "Implemented the method-aware router policy and observed the complete Bun test suite passing after four approved replacements.",
      changed_files: [PATHS.methods_source, PATHS.errors_source, PATHS.router_source, PATHS.index_source],
      tests_passed: true,
      mutation_count: 4
    });
  }
  throw new Error("unexpected_decision_counter");
}

function readAction(slot) {
  return action("read_file", { slot, path: pathForSlot(slot) });
}

function replacementAction(context, slot) {
  const document = context.documents.find((entry) => entry.slot === slot);
  const path = pathForSlot(slot);
  if (!document || document.path !== path) throw new Error("replacement_snapshot_required");
  if (!context.latestSearch && context.evidence.mutationCount === 0) throw new Error("literal_search_required");
  if (context.evidence.lastTestMutationCount !== context.evidence.mutationCount) throw new Error("test_between_mutations_required");
  return action("replace_file", {
    slot,
    path,
    expected_sha256: document.sha256,
    replacement: solutionForSlot(slot),
    rationale: `Apply the reviewed ${slot} implementation required by the router policy contract.`
  });
}

function readSlotForDecision(decision) {
  if (decision === 1) return "readme";
  if (decision === 2) return "package";
  if (decision === 3) return "methods_source";
  if (decision === 4) return "pattern_source";
  if (decision === 5) return "errors_source";
  if (decision === 6) return "router_source";
  if (decision === 7) return "index_source";
  if (decision === 8) return "methods_test";
  if (decision === 9) return "router_test";
  throw new Error("unexpected_read_decision");
}

function pathForSlot(slot) {
  if (slot === "readme") return PATHS.readme;
  if (slot === "package") return PATHS.package;
  if (slot === "methods_source") return PATHS.methods_source;
  if (slot === "pattern_source") return PATHS.pattern_source;
  if (slot === "errors_source") return PATHS.errors_source;
  if (slot === "router_source") return PATHS.router_source;
  if (slot === "index_source") return PATHS.index_source;
  if (slot === "methods_test") return PATHS.methods_test;
  if (slot === "router_test") return PATHS.router_test;
  throw new Error("document_slot_invalid");
}

function solutionForSlot(slot) {
  if (slot === "methods_source") return SOLUTIONS.methods_source;
  if (slot === "errors_source") return SOLUTIONS.errors_source;
  if (slot === "router_source") return SOLUTIONS.router_source;
  if (slot === "index_source") return SOLUTIONS.index_source;
  throw new Error("writable_slot_invalid");
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
