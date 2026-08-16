import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { kill as killProcess } from "node:process";

const PACKAGE_NAME = "@tkersey/world-capabilities/repository-workspace-adequacy";
const APPLICATION_ID = "6f26bd0ac8bd4351f4263c2f64fb68db5459d5b25f8f7ac2d060f40fea7c063c";
const FORBIDDEN_EVIDENCE_KEYS = [
  "turnReceiptBytes", "archiveAppendBatchBytes", "capsuleBytes", "chronicleEventBytes",
  "chronicleCommitBytes", "actuationReceiptBytes", "boundaryModuleBytes", "executableImageBytes",
  "turnClosureBytes", "worldAuthoredEvidence", "boundaryAuthoredEvidence", "archiveMomentBytes",
  "archiveSealBytes"
];
const MAXIMUM_FILE_BYTES = 16 * 1024;
const MAXIMUM_PROCESS_BYTES = 8 * 1024;
const MAXIMUM_ENTRIES = 16;
const MAXIMUM_HITS = 12;
const MAXIMUM_EXCERPT_BYTES = 512;
const TEST_TIMEOUT_MS = 30_000;
const SLOT_PATHS = Object.freeze({
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
const SLOT_NAMES = Object.freeze(Object.keys(SLOT_PATHS));
const READABLE_PATHS = new Set(Object.values(SLOT_PATHS));
const WRITABLE_SLOTS = Object.freeze(["methods_source", "errors_source", "router_source", "index_source"]);
const WRITABLE_PATHS = new Set([
  SLOT_PATHS.methods_source,
  SLOT_PATHS.errors_source,
  SLOT_PATHS.router_source,
  SLOT_PATHS.index_source
]);

const packManifest = Object.freeze({
  driverId: "repository-workspace-adequacy",
  packageName: PACKAGE_NAME,
  authorityLabels: ["file.read", "file.write", "human"],
  supportedActuationClasses: ["repository"],
  supportedActuatorRefs: [
    "actuator.repository-list.v2",
    "actuator.repository-read.v2",
    "actuator.repository-search.v2",
    "actuator.repository-test.v2",
    "actuator.repository-replace-approved.v2"
  ],
  supportedDescriptorFingerprints: [
    "desc.repository-list.v2",
    "desc.repository-read.v2",
    "desc.repository-search.v2",
    "desc.repository-test.v2",
    "desc.repository-replace-approved.v2"
  ],
  supportedResponseStatuses: ["ok", "rejected", "failed"],
  secretRequirements: []
});

export function manifest() {
  return structuredClone(packManifest);
}

export async function preflight(context, request) {
  const admitted = await admit(context, request);
  if (!admitted.ok) return reject(request, admitted.reason);
  return {
    requestId: request.requestId,
    status: "ok",
    payload: { admitted: true }
  };
}

export async function resolve(context, request) {
  const admitted = await admit(context, request);
  if (!admitted.ok) return reject(request, admitted.reason);
  try {
    switch (request.payload.operation) {
      case "list": return ok(request, await listRepository(context, admitted.root));
      case "read": return ok(request, await readRepositoryFile(
        context,
        admitted.root,
        request.payload.slot,
        request.payload.path
      ));
      case "search": return ok(request, await searchRepository(context, admitted.root, request.payload));
      case "test": return ok(request, await runTests(context, admitted.root));
      case "replace": return ok(request, await replaceApproved(context, admitted.root, request));
      default: return reject(request, "unsupported_operation");
    }
  } catch (error) {
    return failed(request, safeFailureReason(error));
  }
}

export async function dryRun(context, request) {
  const admitted = await admit(context, request);
  if (!admitted.ok) return reject(request, admitted.reason);
  return ok(request, { wouldPerform: request.payload.operation, effect: false });
}

export async function recover(_context, effectRecord) {
  if (effectRecord?.recordedResolution) return structuredClone(effectRecord.recordedResolution);
  return { status: "failed", payload: { reason: "recorded_resolution_required" } };
}

export async function shadow(_context, request, recordedResolution) {
  return ok(request, { matched: true, recordedResolution });
}

async function admit(context, request) {
  if (!request || typeof request !== "object") return denied("host_request_not_object");
  if (typeof request.requestId !== "string" || request.requestId.length === 0) return denied("missing_request_id");
  if (typeof request.idempotencyKey !== "string" || request.idempotencyKey.length === 0) return denied("missing_idempotency_key");
  if (!request.target || !packManifest.supportedDescriptorFingerprints.includes(request.target.descriptorFingerprint)) {
    return denied("unsupported_descriptor_fingerprint");
  }
  if (!packManifest.supportedActuatorRefs.includes(request.target.actuatorRef)) return denied("unsupported_actuator_ref");
  if (!packManifest.supportedActuationClasses.includes(request.target.actuationClass)) return denied("unsupported_actuation_class");
  if (!responseSchemaSupports(request)) return denied("unsupported_response_schema");
  const packageReason = packagePolicyReason(context);
  if (packageReason) return denied(packageReason);
  const hostileReason = hostilePayloadReason(request.payload);
  if (hostileReason) return denied(hostileReason);
  if (context?.applicationId !== APPLICATION_ID) return denied("application_not_admitted");
  if (context?.policy?.repositoryAdequacy !== true) return denied("repository_policy_required");
  if (typeof context.workspaceRoot !== "string" || typeof context.workspaceRootReal !== "string") {
    return denied("workspace_root_required");
  }
  let root;
  try {
    root = await realpath(resolvePath(context.workspaceRoot));
  } catch {
    return denied("workspace_root_missing");
  }
  if (root !== context.workspaceRootReal) return denied("workspace_root_changed");
  const payload = request.payload;
  if (!payload || typeof payload !== "object") return denied("payload_required");
  const operation = payload.operation;
  if (!new Set(["list", "read", "search", "test", "replace"]).has(operation)) {
    return denied("unsupported_operation");
  }
  if (operation === "read") {
    if (!slotMatchesPath(payload.slot, payload.path)) return denied("read_slot_path_mismatch");
    const path = await admittedPath(root, payload.path, { requireFile: true, writable: false });
    if (!path.ok) return path;
  }
  if (operation === "search") {
    if (typeof payload.query !== "string" || Buffer.byteLength(payload.query, "utf8") === 0) return denied("search_query_required");
    const prefix = await admittedPrefix(root, payload.pathPrefix);
    if (!prefix.ok) return prefix;
  }
  if (operation === "test") {
    if (payload.suite !== "default") return denied("test_suite_not_admitted");
    if (typeof context.bunExecutable !== "string" || !isAbsolute(context.bunExecutable)) return denied("bun_executable_required");
    if (typeof context.temporaryHome !== "string" || !isAbsolute(context.temporaryHome)) return denied("temporary_home_required");
  }
  if (operation === "replace") {
    if (!slotMatchesPath(payload.slot, payload.path) || !WRITABLE_SLOTS.includes(payload.slot)) {
      return denied("replace_slot_path_mismatch");
    }
    const path = await admittedPath(root, payload.path, { requireFile: true, writable: true });
    if (!path.ok) return path;
    if (!/^[0-9a-f]{64}$/.test(payload.expectedSha256 ?? "")) return denied("expected_digest_invalid");
    if (typeof payload.replacement !== "string" || Buffer.byteLength(payload.replacement, "utf8") > MAXIMUM_FILE_BYTES) {
      return denied("replacement_not_admitted");
    }
    const approvalReason = approvalDenial(context, request);
    if (approvalReason) return denied(approvalReason);
  }
  return { ok: true, root };
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

async function listRepository(context, root) {
  const entries = [];
  for (const path of Object.values(SLOT_PATHS)) {
    const admitted = await admittedPath(root, path, { requireFile: true, writable: false });
    if (!admitted.ok) throw new Error(admitted.reason);
    entries.push({ path, kind: "file" });
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  bump(context, "effectAttempts");
  bump(context, "listings");
  return { entries, truncated: false };
}

async function readRepositoryFile(context, root, slot, requested) {
  const admitted = await admittedPath(root, requested, { requireFile: true, writable: false });
  if (!admitted.ok) throw new Error(admitted.reason);
  const contents = await readUtf8Bounded(admitted.full);
  bump(context, "effectAttempts");
  bump(context, "fileReads");
  const readSlots = context.readSlots instanceof Set ? context.readSlots : new Set(context.readSlots ?? []);
  readSlots.add(slot);
  context.readSlots = readSlots;
  return { slot, slotCode: SLOT_NAMES.indexOf(slot), path: admitted.path, sha256: sha256(contents), contents };
}

function slotMatchesPath(slot, path) {
  return pathForSlot(slot) === path;
}

function pathForSlot(slot) {
  if (slot === "readme") return SLOT_PATHS.readme;
  if (slot === "package") return SLOT_PATHS.package;
  if (slot === "methods_source") return SLOT_PATHS.methods_source;
  if (slot === "pattern_source") return SLOT_PATHS.pattern_source;
  if (slot === "errors_source") return SLOT_PATHS.errors_source;
  if (slot === "router_source") return SLOT_PATHS.router_source;
  if (slot === "index_source") return SLOT_PATHS.index_source;
  if (slot === "methods_test") return SLOT_PATHS.methods_test;
  if (slot === "router_test") return SLOT_PATHS.router_test;
  return null;
}

async function searchRepository(context, root, payload) {
  const prefix = await admittedPrefix(root, payload.pathPrefix);
  if (!prefix.ok) throw new Error(prefix.reason);
  const candidates = Object.values(SLOT_PATHS).filter((path) =>
    prefix.path === "" || path === prefix.path || path.startsWith(`${prefix.path}/`));
  candidates.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const hits = [];
  let truncated = false;
  for (const path of candidates) {
    const contents = await readUtf8Bounded(join(root, path));
    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines.at(index);
      if (!line.includes(payload.query)) continue;
      if (hits.length === MAXIMUM_HITS) { truncated = true; break; }
      hits.push({
        path,
        line: index + 1,
        excerpt: truncateUtf8(line, MAXIMUM_EXCERPT_BYTES)
      });
    }
    if (truncated) break;
  }
  bump(context, "effectAttempts");
  bump(context, "searches");
  return { hits, truncated };
}

async function runTests(context, root) {
  bump(context, "effectAttempts");
  bump(context, "testRuns");
  const result = await spawnBounded(context.bunExecutable, ["test"], {
    cwd: root,
    env: {
      HOME: context.temporaryHome,
      TMPDIR: context.temporaryHome,
      NO_COLOR: "1"
    }
  });
  context.lastTestPassed = result.passed;
  context.lastTestMutationCount = context.mutationsApplied ?? 0;
  if (!result.passed && (context.mutationsApplied ?? 0) === 0) context.preMutationTestFailed = true;
  return result;
}

async function replaceApproved(context, root, request) {
  const payload = request.payload;
  const admitted = await admittedPath(root, payload.path, { requireFile: true, writable: true });
  if (!admitted.ok) throw new Error(admitted.reason);
  bump(context, "effectAttempts");
  bump(context, "mutationAttempts");
  const current = await readUtf8Bounded(admitted.full);
  const currentDigest = sha256(current);
  const replacementDigest = sha256(payload.replacement);
  const slotCode = SLOT_NAMES.indexOf(payload.slot);
  if (currentDigest === replacementDigest) {
    return {
      kind: "applied",
      payload: {
        slot: payload.slot,
        slotCode,
        path: admitted.path,
        oldSha256: payload.expectedSha256,
        newSha256: replacementDigest,
        alreadyApplied: true,
        current: snapshot(payload.slot, admitted.path, replacementDigest, current)
      }
    };
  }
  if (currentDigest !== payload.expectedSha256) {
    return {
      kind: "conflict",
      payload: {
        slot: payload.slot,
        slotCode,
        path: admitted.path,
        expectedSha256: payload.expectedSha256,
        actualSha256: currentDigest
      }
    };
  }
  const changedPaths = context.changedPaths instanceof Set ? context.changedPaths : new Set(context.changedPaths ?? []);
  if (changedPaths.has(admitted.path)) {
    return deniedReplacement(payload, "second_different_replacement_denied");
  }
  const mutationCount = context.mutationsApplied ?? 0;
  if (mutationCount >= 4) return deniedReplacement(payload, "mutation_limit_reached");
  if (mutationCount === 0) {
    if ((context.readSlots?.size ?? 0) !== SLOT_NAMES.length) return deniedReplacement(payload, "all_slots_must_be_read");
    if ((context.listings ?? 0) < 1) return deniedReplacement(payload, "listing_required");
    if ((context.searches ?? 0) < 1) return deniedReplacement(payload, "search_required");
    if (context.preMutationTestFailed !== true || context.lastTestMutationCount !== 0) {
      return deniedReplacement(payload, "failing_baseline_test_required");
    }
  } else if (context.lastTestMutationCount !== mutationCount) {
    return deniedReplacement(payload, "test_between_mutations_required");
  }
  const info = await stat(admitted.full);
  if (info.nlink !== 1) return deniedReplacement(payload, "hard_link_ambiguity");
  const temporary = join(dirname(admitted.full), `.adequacy-${randomBytes(12).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, payload.replacement, { encoding: "utf8", flag: "wx", mode: info.mode & 0o777 });
    const handle = await open(temporary, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, admitted.full);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  const finalContents = await readUtf8Bounded(admitted.full);
  if (sha256(finalContents) !== replacementDigest) throw new Error("replacement_digest_mismatch");
  changedPaths.add(admitted.path);
  context.changedPaths = changedPaths;
  bump(context, "mutationsApplied");
  return {
    kind: "applied",
    payload: {
      slot: payload.slot,
      slotCode,
      path: admitted.path,
      oldSha256: currentDigest,
      newSha256: replacementDigest,
      alreadyApplied: false,
      current: snapshot(payload.slot, admitted.path, replacementDigest, finalContents)
    }
  };
}

function snapshot(slot, path, digest, contents) {
  return { slot, slotCode: SLOT_NAMES.indexOf(slot), path, sha256: digest, contents };
}

function deniedReplacement(payload, reason) {
  return { kind: "denied", payload: { slot: payload.slot, path: payload.path, reason } };
}

function approvalDenial(context, request) {
  const approval = context?.approval;
  if (!approval || approval.approved !== true) return "approval_required";
  if (approval.requestId !== request.requestId) return "approval_request_mismatch";
  const digest = proposalDigest(request.payload);
  if (approval.proposalDigest !== digest) return "approval_proposal_mismatch";
  if (approval.mode === "interactive") return null;
  if (approval.mode !== "adequacy-fixture-auto") return "approval_mode_not_admitted";
  const plan = context.fixturePlan ?? [];
  const expected = plan.at(context.mutationsApplied ?? 0);
  const replayed = plan.slice(0, context.mutationsApplied ?? 0).some((step) =>
    step.slot === request.payload.slot &&
    step.path === request.payload.path &&
    step.replacementDigest === sha256(request.payload.replacement)
  );
  if (context.applicationId !== APPLICATION_ID || context.fixtureInitialManifestMatched !== true ||
      ((!expected || expected.slot !== request.payload.slot || expected.path !== request.payload.path ||
        expected.replacementDigest !== sha256(request.payload.replacement)) && !replayed) ||
      context.fixtureRequestDigest !== digest) {
    return "fixture_auto_approval_not_admitted";
  }
  return null;
}

export function proposalDigest(payload) {
  const hasher = createHash("sha256");
  for (const value of [payload.path, payload.expectedSha256, payload.replacement, payload.rationale]) {
    const bytes = Buffer.from(String(value), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    hasher.update(length);
    hasher.update(bytes);
  }
  return hasher.digest("hex");
}

async function admittedPrefix(root, requested) {
  const path = requested === "" ? "." : requested;
  if (path === ".") return { ok: true, root, full: root, path: "" };
  if (path === "src" || path === "test") {
    const full = resolvePath(root, path);
    const info = await lstat(full).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return denied("path_not_directory");
    return { ok: true, root, full, path };
  }
  return admittedPath(root, path, { requireFile: false, writable: false, allowDirectory: true });
}

async function admittedPath(root, requested, options) {
  if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0") ||
      requested.includes("\\") || isAbsolute(requested)) return denied("path_not_relative");
  const segments = requested.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return denied("path_not_normalized");
  if (segments.some((segment) => segment.startsWith("."))) return denied("hidden_path_denied");
  if (!READABLE_PATHS.has(requested)) return denied("path_not_admitted");
  if (options.writable && !WRITABLE_PATHS.has(requested)) return denied("write_path_not_admitted");
  const full = resolvePath(root, requested);
  if (!inside(root, full)) return denied("path_escape_rejected");
  let parent;
  try { parent = await realpath(dirname(full)); } catch { return denied("parent_missing"); }
  if (!inside(root, parent)) return denied("symlink_ancestor_rejected");
  let info;
  try { info = await lstat(full); } catch { return denied("path_missing"); }
  if (info.isSymbolicLink()) return denied("final_symlink_rejected");
  if (options.requireFile && !info.isFile()) return denied("path_not_file");
  if (!options.allowDirectory && !info.isFile()) return denied("path_not_file");
  if (options.allowDirectory && !info.isFile() && !info.isDirectory()) return denied("special_file_rejected");
  const real = await realpath(full);
  if (!inside(root, real)) return denied("path_escape_rejected");
  return { ok: true, root, full, path: requested };
}

async function readUtf8Bounded(path) {
  const before = await stat(path);
  if (!before.isFile() || before.size > MAXIMUM_FILE_BYTES) throw new Error("file_not_admitted");
  const bytes = await readFile(path);
  const after = await stat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== after.size) {
    throw new Error("file_changed_during_read");
  }
  if (bytes.length > MAXIMUM_FILE_BYTES) throw new Error("file_too_large");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function spawnBounded(executable, argv, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, argv, { ...options, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const capture = (parts, lengthName, truncatedName) => (chunk) => {
      let length = lengthName === "stdout" ? stdoutLength : stderrLength;
      if (length < MAXIMUM_PROCESS_BYTES) {
        const admitted = Buffer.from(chunk).subarray(0, MAXIMUM_PROCESS_BYTES - length);
        parts.push(admitted);
        length += admitted.length;
      }
      if (length < chunk.length || length >= MAXIMUM_PROCESS_BYTES) {
        if (truncatedName === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
      }
      if (lengthName === "stdout") stdoutLength = length;
      else stderrLength = length;
    };
    child.stdout.on("data", capture(stdout, "stdout", "stdout"));
    child.stderr.on("data", capture(stderr, "stderr", "stderr"));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { killProcess(-child.pid, "SIGKILL"); } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, TEST_TIMEOUT_MS);
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const exitCode = timedOut ? -1 : (Number.isInteger(code) ? code : signal ? -1 : -1);
      const stdoutText = decodeCaptured(stdout);
      const stderrText = decodeCaptured(stderr);
      const combined = `${stdoutText}\n--- stderr ---\n${stderrText}`;
      const output = truncateUtf8(combined, MAXIMUM_PROCESS_BYTES);
      resolvePromise({
        exitCode,
        passed: !timedOut && exitCode === 0,
        output,
        truncated: stdoutTruncated || stderrTruncated || Buffer.byteLength(combined, "utf8") > MAXIMUM_PROCESS_BYTES
      });
    });
  });
}

function decodeCaptured(parts) {
  const bytes = Buffer.concat(parts);
  for (let length = bytes.length; length >= Math.max(0, bytes.length - 3); length -= 1) {
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); } catch {}
  }
  return "";
}

function truncateUtf8(value, maximum) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximum) return value;
  for (let length = maximum; length >= maximum - 3; length -= 1) {
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); } catch {}
  }
  return "";
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function checkedU32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error("length_overflow");
  return value;
}
function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
function denied(reason) { return { ok: false, reason }; }
function responseSchemaSupports(request) {
  const statuses = request.responseSchema?.statuses;
  return Array.isArray(statuses) && statuses.includes("ok") && statuses.some((status) => status === "rejected" || status === "failed");
}
function status(request, wanted) {
  const statuses = request?.responseSchema?.statuses ?? [];
  if (statuses.includes(wanted)) return wanted;
  return statuses.includes("failed") ? "failed" : "rejected";
}
function ok(request, payload) { return { requestId: request.requestId, status: "ok", payload }; }
function reject(request, reason) { return { requestId: request?.requestId ?? "unknown", status: status(request, "rejected"), payload: { reason } }; }
function failed(request, reason) { return { requestId: request?.requestId ?? "unknown", status: status(request, "failed"), payload: { reason } }; }
function safeFailureReason(error) {
  const message = typeof error?.message === "string" ? error.message : "capability_failed";
  return /^[a-z0-9_]+$/.test(message) ? message : "capability_failed";
}
function bump(context, field) {
  switch (field) {
    case "effectAttempts": context.effectAttempts = (context.effectAttempts ?? 0) + 1; break;
    case "listings": context.listings = (context.listings ?? 0) + 1; break;
    case "fileReads": context.fileReads = (context.fileReads ?? 0) + 1; break;
    case "searches": context.searches = (context.searches ?? 0) + 1; break;
    case "testRuns": context.testRuns = (context.testRuns ?? 0) + 1; break;
    case "mutationAttempts": context.mutationAttempts = (context.mutationAttempts ?? 0) + 1; break;
    case "mutationsApplied": context.mutationsApplied = (context.mutationsApplied ?? 0) + 1; break;
    default: throw new Error("counter_not_admitted");
  }
}
