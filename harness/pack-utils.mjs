import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assert, fail, stableStringify } from "./assertions.mjs";
import { corpusFingerprint, readJson } from "./corpus-utils.mjs";

export const PACKAGES_ROOT = "packages";

export const REQUIRED_PACK_FILES = [
  "manifest.json",
  "adapter.mjs",
  "conformance.json",
  "non-claims.md",
  "README.md",
  "checksums.sha256"
];

export const REQUIRED_MANIFEST_FIELDS = [
  "packFormatVersion",
  "packFingerprint",
  "packageName",
  "packageVersion",
  "driverId",
  "driverAbiVersion",
  "supportedWorldProtocolVersions",
  "supportedApplianceAbiVersions",
  "supportedTurnClosureVersions",
  "supportedActuatorRefs",
  "supportedDescriptorFingerprints",
  "supportedActuationClasses",
  "supportedResponseStatuses",
  "recoveryClass",
  "secretRequirements",
  "authorityLabels",
  "maximumRequestBytes",
  "maximumResponseBytes",
  "idempotencySupport",
  "dryRunSupport",
  "shadowSupport",
  "replaySupport",
  "recoverSupport",
  "conformanceCorpusFingerprint",
  "artifacts",
  "checksums",
  "metadata"
];

export const FORBIDDEN_EVIDENCE_KEYS = [
  "turnReceiptBytes",
  "archiveAppendBatchBytes",
  "capsuleBytes",
  "chronicleEventBytes",
  "chronicleCommitBytes",
  "actuationReceiptBytes",
  "boundaryModuleBytes",
  "executableImageBytes",
  "turnClosureBytes",
  "worldAuthoredEvidence",
  "boundaryAuthoredEvidence",
  "archiveMomentBytes",
  "archiveSealBytes"
];

const PACKAGE_IMPORT = /(?:import|export)\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT = /import\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(/;
const EVAL_PATTERNS = [
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /globalThis\s*\[\s*["']Function["']\s*\]/,
  /process\s*\.\s*getBuiltinModule\s*\(/,
  /\bnew\s+Worker\s*\(/
];

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function packageNames() {
  return (await readdir(PACKAGES_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function loadPack(packName, root = PACKAGES_ROOT) {
  const dir = join(root, packName);
  return {
    name: packName,
    dir,
    manifest: await readJson(join(dir, "manifest.json")),
    conformance: await readJson(join(dir, "conformance.json"))
  };
}

export async function importAdapter(packDir) {
  const url = pathToFileURL(resolve(packDir, "adapter.mjs"));
  url.search = `v=${Date.now()}-${Math.random()}`;
  return import(url.href);
}

export function findForbiddenEvidence(value, path = "$", hits = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenEvidence(item, `${path}[${index}]`, hits));
    return hits;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const next = `${path}.${key}`;
      if (FORBIDDEN_EVIDENCE_KEYS.includes(key)) hits.push(next);
      findForbiddenEvidence(item, next, hits);
    }
  }
  return hits;
}

export function assertNoForbiddenEvidence(value, label = "value") {
  const hits = findForbiddenEvidence(value);
  assert(hits.length === 0, `${label} emitted forbidden evidence keys: ${hits.join(", ")}`);
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactByKey(key, item)]));
  }
  if (typeof value === "string") return redactString(value);
  return value;
}

function redactByKey(key, value) {
  if (/secret|token|password|api[-_]?key|authorization/i.test(key)) return "[REDACTED]";
  return redact(value);
}

export function redactString(value) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/[A-Za-z0-9._%+-]*?(token|password|api[-_]?key)[A-Za-z0-9._%+-]*[:=][A-Za-z0-9._%+\-/=:-]{4,}/gi, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [REDACTED]");
}

export function policyAllows(context, hostRequest, kind) {
  const policy = context?.policy ?? {};
  if (policy.auditOnly) return false;
  if (policy.denyPackages?.includes(context?.packageName)) return false;
  if (policy.allowPackages && !policy.allowPackages.includes(context?.packageName)) return false;
  if (policy.live === true) return true;
  if (policy[`${kind}Live`] === true) return true;
  return false;
}

export function validateBaseRequest(hostRequest, options = {}) {
  if (!hostRequest || typeof hostRequest !== "object") return { ok: false, status: "rejected", reason: "host_request_not_object" };
  if (!hostRequest.requestId) return { ok: false, status: "rejected", reason: "missing_request_id" };
  if (!hostRequest.target || typeof hostRequest.target !== "object") return { ok: false, status: "rejected", reason: "malformed_target" };
  if (!hostRequest.target.descriptorFingerprint) return { ok: false, status: "rejected", reason: "missing_descriptor_fingerprint" };
  if (options.requireIdempotency !== false && !hostRequest.idempotencyKey) {
    return { ok: false, status: "rejected", reason: "missing_idempotency_key" };
  }
  const statuses = hostRequest.responseSchema?.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) return { ok: false, status: "rejected", reason: "unsupported_response_schema" };
  return { ok: true };
}

export function chooseStatus(hostRequest, preferred, fallback = "failed") {
  const statuses = hostRequest?.responseSchema?.statuses ?? [];
  if (statuses.includes(preferred)) return preferred;
  if (statuses.includes(fallback)) return fallback;
  return statuses[0] ?? "failed";
}

export async function verifyChecksums(pack) {
  const file = await readFile(join(pack.dir, "checksums.sha256"), "utf8");
  const expected = new Map();
  for (const line of file.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    assert(match, `${pack.name}: malformed checksum line ${line}`);
    expected.set(match[2], match[1]);
  }
  for (const artifact of pack.manifest.artifacts) {
    const checksum = expected.get(artifact.path);
    assert(checksum, `${pack.name}: artifact ${artifact.path} missing from checksums.sha256`);
    const actual = sha256Bytes(await readFile(join(pack.dir, artifact.path)));
    assert(actual === checksum, `${pack.name}: checksum mismatch for ${artifact.path}`);
    assert(pack.manifest.checksums[artifact.path] === checksum, `${pack.name}: manifest checksum mismatch for ${artifact.path}`);
  }
}

export function parseImports(source) {
  const imports = [];
  for (const regex of [PACKAGE_IMPORT, SIDE_EFFECT_IMPORT]) {
    regex.lastIndex = 0;
    for (const match of source.matchAll(regex)) imports.push(match[1]);
  }
  return [...new Set(imports)];
}

export async function verifySelfContained(pack) {
  const covered = new Set(pack.manifest.artifacts.map((artifact) => artifact.path));
  const allowedBuiltins = new Set(pack.manifest.metadata?.allowedBuiltins ?? []);
  for (const artifact of pack.manifest.artifacts) {
    if (!/\.(mjs|js|cjs|ts|tsx)$/.test(artifact.path)) continue;
    const full = join(pack.dir, artifact.path);
    const source = await readFile(full, "utf8");
    assert(!DYNAMIC_IMPORT.test(source), `${pack.name}: dynamic import rejected in ${artifact.path}`);
    for (const pattern of EVAL_PATTERNS) {
      assert(!pattern.test(source), `${pack.name}: unsafe loader rejected in ${artifact.path}`);
    }
    for (const specifier of parseImports(source)) {
      if (specifier.startsWith("node:")) {
        assert(allowedBuiltins.has(specifier), `${pack.name}: unchecked builtin ${specifier}`);
        continue;
      }
      assert(specifier.startsWith("./") || specifier.startsWith("../"), `${pack.name}: package import ${specifier} rejected`);
      const imported = normalize(join(artifact.path, "..", specifier));
      const normalized = imported.endsWith(".mjs") || imported.endsWith(".js") ? imported : `${imported}.mjs`;
      const resolved = resolve(pack.dir, normalized);
      assert(resolved.startsWith(resolve(pack.dir)), `${pack.name}: host path import ${specifier}`);
      assert(covered.has(relative(pack.dir, resolved)), `${pack.name}: local import ${specifier} not checksum-covered`);
    }
  }
  validateSidecarCommand(pack);
}

export function validateSidecarCommand(pack) {
  const sidecar = pack.manifest.metadata?.sidecar;
  if (!sidecar) return;
  const command = sidecar.command ?? [];
  assert(Array.isArray(command) && command.length >= 2, `${pack.name}: sidecar command required`);
  const [runtime, ...args] = command;
  assert(["node", "bun", "deno"].includes(runtime), `${pack.name}: sidecar bare executable rejected`);
  assert(!command.some((part) => /^https?:\/\//.test(part)), `${pack.name}: remote sidecar entrypoint rejected`);
  assert(!["bunx", "npx"].includes(runtime), `${pack.name}: package runner rejected`);
  assert(!(runtime === "bun" && args[0] === "x"), `${pack.name}: bun package runner rejected`);
  assert(!(runtime === "npm" && args[0] === "exec"), `${pack.name}: npm exec package runner rejected`);
  assert(!(runtime === "node" && args[0] === "--run"), `${pack.name}: node --run package runner rejected`);
  assert(!args.some((arg) => ["-e", "--eval", "eval"].includes(arg)), `${pack.name}: eval flag rejected`);
  assert(!args.some((arg) => ["--import", "--require", "--import-map"].includes(arg)), `${pack.name}: preload flag rejected`);
  const entry = args.find((arg) => /\.(mjs|js|cjs|ts|tsx)$/.test(arg));
  assert(entry, `${pack.name}: sidecar entrypoint missing`);
  assert(pack.manifest.artifacts.some((artifact) => artifact.path === entry), `${pack.name}: sidecar entrypoint not artifact-bound`);
  assert(sidecar.stdoutBytes <= 8192, `${pack.name}: stdout bound too high`);
  assert(sidecar.stderrBytes <= 8192, `${pack.name}: stderr bound too high`);
  assert(sidecar.timeoutMs > 0 && sidecar.timeoutMs <= 5000, `${pack.name}: timeout bound missing`);
}

export async function verifyPack(pack) {
  for (const file of REQUIRED_PACK_FILES) {
    await readFile(join(pack.dir, file));
  }
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    assert(pack.manifest[field] !== undefined, `${pack.name}: missing manifest field ${field}`);
  }
  assert(!isAbsolute(pack.manifest.packageName), `${pack.name}: absolute package identity rejected`);
  assert(!stableStringify(pack.manifest).match(/AKIA|sk-[A-Za-z0-9_-]{8,}|password=/i), `${pack.name}: credential-shaped manifest value`);
  assert(pack.conformance.driverId === pack.manifest.driverId, `${pack.name}: conformance driverId mismatch`);
  const corpus = await corpusFingerprint();
  assert(pack.conformance.corpusFingerprint === corpus, `${pack.name}: conformance corpus mismatch`);
  assert(pack.manifest.conformanceCorpusFingerprint === corpus, `${pack.name}: manifest corpus mismatch`);
  for (const vector of pack.conformance.vectors ?? []) {
    assert(vector.passed === true, `${pack.name}: failed vector ${vector.id}`);
  }
  await verifyChecksums(pack);
  await verifySelfContained(pack);
  const adapter = await importAdapter(pack.dir);
  for (const name of ["manifest", "preflight", "resolve", "dryRun"]) {
    assert(typeof adapter[name] === "function", `${pack.name}: adapter missing export ${name}`);
  }
  assert(adapter.manifest().driverId === pack.manifest.driverId, `${pack.name}: adapter manifest mismatch`);
}

export async function expectedPackFingerprint(pack) {
  const material = {
    packageName: pack.manifest.packageName,
    packageVersion: pack.manifest.packageVersion,
    driverId: pack.manifest.driverId,
    driverAbiVersion: pack.manifest.driverAbiVersion,
    conformanceCorpusFingerprint: pack.manifest.conformanceCorpusFingerprint,
    artifacts: pack.manifest.artifacts,
    checksums: pack.manifest.checksums
  };
  return createHash("sha256").update(stableStringify(material)).digest("hex");
}
