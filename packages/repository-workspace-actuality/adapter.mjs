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

const PACKAGE_NAME = "@tkersey/world-capabilities/repository-workspace-actuality";
const APPLICATION_ID = "14926c1ecd6436230718f3e1772f2946916ec0959fc81a8fab94190cc2e9a3d5";
const FORBIDDEN_EVIDENCE_KEYS = [
  "turnReceiptBytes", "archiveAppendBatchBytes", "capsuleBytes", "chronicleEventBytes",
  "chronicleCommitBytes", "actuationReceiptBytes", "boundaryModuleBytes", "executableImageBytes",
  "turnClosureBytes", "worldAuthoredEvidence", "boundaryAuthoredEvidence", "archiveMomentBytes",
  "archiveSealBytes"
];
const MAXIMUM_FILE_BYTES = 32 * 1024;
const MAXIMUM_PROCESS_BYTES = 4 * 1024;
const MAXIMUM_ENTRIES = 32;
const MAXIMUM_HITS = 8;
const MAXIMUM_EXCERPT_BYTES = 256;
const TEST_TIMEOUT_MS = 30_000;
const READABLE_ROOTS = new Set(["README.md", "package.json", "src", "test"]);
const WRITABLE_PATH = "src/range.mjs";

const packManifest = Object.freeze({
  driverId: "repository-workspace-actuality",
  packageName: PACKAGE_NAME,
  authorityLabels: ["file.read", "file.write", "human"],
  supportedActuationClasses: ["repository"],
  supportedActuatorRefs: [
    "actuator.repository-list.v1",
    "actuator.repository-read.v1",
    "actuator.repository-search.v1",
    "actuator.repository-test.v1",
    "actuator.repository-replace-approved.v1"
  ],
  supportedDescriptorFingerprints: [
    "desc.repository-list.v1",
    "desc.repository-read.v1",
    "desc.repository-search.v1",
    "desc.repository-test.v1",
    "desc.repository-replace-approved.v1"
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
        request.payload.role,
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
  if (context?.policy?.repositoryActuality !== true) return denied("repository_policy_required");
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
    if (!roleMatchesPath(payload.role, payload.path)) return denied("read_role_path_mismatch");
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
  let truncated = false;
  for (const name of ["README.md", "package.json", "src", "test"]) {
    if (entries.length === MAXIMUM_ENTRIES) { truncated = true; break; }
    const full = join(root, name);
    let info;
    try { info = await lstat(full); } catch { continue; }
    if (info.isSymbolicLink()) throw new Error("symlink_rejected");
    if (info.isFile()) entries.push({ path: name, kind: "file" });
    else if (info.isDirectory() && await walk(full, name, entries)) {
      truncated = true;
      break;
    }
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  bump(context, "effectAttempts");
  bump(context, "fileReads");
  return { entries, truncated };
}

async function walk(directory, prefix, entries) {
  const names = await readdir(directory, { withFileTypes: true });
  names.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of names) {
    if (entry.name.startsWith(".")) continue;
    if (entries.length === MAXIMUM_ENTRIES) return true;
    const path = `${prefix}/${entry.name}`;
    const full = join(directory, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error("symlink_rejected");
    if (info.isDirectory()) {
      if (await walk(full, path, entries)) return true;
    }
    else if (info.isFile()) entries.push({ path, kind: "file" });
    else throw new Error("special_file_rejected");
  }
  return false;
}

async function readRepositoryFile(context, root, role, requested) {
  const admitted = await admittedPath(root, requested, { requireFile: true, writable: false });
  if (!admitted.ok) throw new Error(admitted.reason);
  const contents = await readUtf8Bounded(admitted.full);
  bump(context, "effectAttempts");
  bump(context, "fileReads");
  return { role, path: admitted.path, sha256: sha256(contents), contents };
}

function roleMatchesPath(role, path) {
  if (role === "package") return path === "package.json";
  if (role === "source") return typeof path === "string" && path.startsWith("src/");
  if (role === "test") return typeof path === "string" && path.startsWith("test/");
  return false;
}

async function searchRepository(context, root, payload) {
  const prefix = await admittedPrefix(root, payload.pathPrefix);
  if (!prefix.ok) throw new Error(prefix.reason);
  const candidates = [];
  const info = await lstat(prefix.full);
  if (info.isFile()) candidates.push(prefix.path);
  else await collectReadableFiles(prefix.full, prefix.path, candidates);
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

async function collectReadableFiles(directory, prefix, result) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(directory, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error("symlink_rejected");
    if (info.isDirectory()) await collectReadableFiles(full, path, result);
    else if (info.isFile()) result.push(path);
    else throw new Error("special_file_rejected");
  }
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
  if (!result.passed) context.preMutationTestFailed = true;
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
  if (currentDigest === replacementDigest) {
    return {
      kind: "applied",
      payload: {
        path: admitted.path,
        oldSha256: payload.expectedSha256,
        newSha256: replacementDigest,
        alreadyApplied: true
      }
    };
  }
  if (currentDigest !== payload.expectedSha256) {
    return {
      kind: "conflict",
      payload: {
        path: admitted.path,
        expectedSha256: payload.expectedSha256,
        actualSha256: currentDigest
      }
    };
  }
  if ((context.mutationsApplied ?? 0) !== 0) {
    return { kind: "denied", payload: { reason: "second_mutation_denied" } };
  }
  const info = await stat(admitted.full);
  if (info.nlink !== 1) return { kind: "denied", payload: { reason: "hard_link_ambiguity" } };
  const temporary = join(dirname(admitted.full), `.actuality-${randomBytes(12).toString("hex")}.tmp`);
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
  bump(context, "mutationsApplied");
  return {
    kind: "applied",
    payload: {
      path: admitted.path,
      oldSha256: currentDigest,
      newSha256: replacementDigest,
      alreadyApplied: false
    }
  };
}

function approvalDenial(context, request) {
  const approval = context?.approval;
  if (!approval || approval.approved !== true) return "approval_required";
  if (approval.requestId !== request.requestId) return "approval_request_mismatch";
  const digest = proposalDigest(request.payload);
  if (approval.proposalDigest !== digest) return "approval_proposal_mismatch";
  if (approval.mode === "interactive") return null;
  if (approval.mode !== "fixture-auto") return "approval_mode_not_admitted";
  if (context.applicationId !== APPLICATION_ID || context.fixtureInitialManifestMatched !== true ||
      context.preMutationTestFailed !== true || request.payload.path !== WRITABLE_PATH ||
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
  return admittedPath(root, path, { requireFile: false, writable: false, allowDirectory: true });
}

async function admittedPath(root, requested, options) {
  if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0") ||
      requested.includes("\\") || isAbsolute(requested)) return denied("path_not_relative");
  const segments = requested.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return denied("path_not_normalized");
  if (segments.some((segment) => segment.startsWith("."))) return denied("hidden_path_denied");
  if (!READABLE_ROOTS.has(segments.at(0))) return denied("path_not_admitted");
  if (options.writable && requested !== WRITABLE_PATH) return denied("write_path_not_admitted");
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
      resolvePromise({
        exitCode,
        passed: !timedOut && exitCode === 0,
        stdout: decodeCaptured(stdout),
        stderr: decodeCaptured(stderr),
        stdoutTruncated,
        stderrTruncated
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
    case "fileReads": context.fileReads = (context.fileReads ?? 0) + 1; break;
    case "searches": context.searches = (context.searches ?? 0) + 1; break;
    case "testRuns": context.testRuns = (context.testRuns ?? 0) + 1; break;
    case "mutationAttempts": context.mutationAttempts = (context.mutationAttempts ?? 0) + 1; break;
    case "mutationsApplied": context.mutationsApplied = (context.mutationsApplied ?? 0) + 1; break;
    default: throw new Error("counter_not_admitted");
  }
}
