import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
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

export const ADAPTER_MANIFEST_PARITY_FIELDS = [
  "packageName",
  "driverId",
  "supportedActuationClasses",
  "supportedActuatorRefs",
  "supportedDescriptorFingerprints",
  "supportedResponseStatuses",
  "secretRequirements"
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

const DYNAMIC_IMPORT = /\bimport\s*\(/;
const EVAL_PATTERNS = [
  /\beval\b/,
  /\bFunction\b/,
  /\bconstructor\b/,
  /\[\s*["'][^"']*["']\s*\+/,
  /\+\s*["'][^"']*["']\s*\]/,
  /\bReflect\b/,
  /\bglobalThis\b/,
  /\bglobal\b/,
  /\bself\b/,
  /globalThis\s*\[\s*["']Function["']\s*\]/,
  /import\s*\.\s*meta\b/,
  /process\s*\[/,
  /process\s*\.\s*constructor\b/,
  /process\s*\.\s*getBuiltinModule\s*\(/,
  /process\s*\[\s*["']getBuiltinModule["']\s*\]/,
  /process\s*\.\s*mainModule\b/,
  /process\s*\[\s*["']mainModule["']\s*\]/,
  /globalThis\s*\[\s*["']process["']\s*\]/,
  /=\s*process\b/,
  /import\s*\.\s*meta\s*\.\s*require\b/,
  /import\s*\.\s*meta\s*\[\s*["']require["']\s*\]/,
  /\bcreateRequire\b/,
  /\bnew\s+Worker\s*\(/
];
const COMMONJS_REQUIRE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const ANY_COMMONJS_REQUIRE = /\brequire\b/;
const COMMONJS_MODULE_LOADER = /\bmodule\s*(?:\.|\?\.)\s*(?:constructor|require)\b/;
const PROCESS_ACCESS = /\bprocess\b/;
const BUN_ACCESS = /\bBun\b/;
const DENO_ACCESS = /\bDeno\b/;
const COMPUTED_MEMBER_ACCESS = /(?:\?\.\s*\[|\{\s*[^}\n]*\[[^\]]+\]\s*:|(?:\b[A-Za-z_$][\w$]*|\)|\]|\})\s*\[)/;
const EXECUTABLE_ARTIFACT = /\.(mjs|js|cjs|jsx|ts|tsx|mts|cts)$/;
const EXECUTABLE_EXTENSIONS = [".mjs", ".js", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"];
const LOCAL_IMPORT_EXTENSIONS = [...EXECUTABLE_EXTENSIONS, ".json"];
const PRELOAD_FLAGS = ["--import", "--require", "--import-map", "--preload", "--loader", "--experimental-loader"];
const FORBIDDEN_LOADER_BUILTINS = new Set(["node:module"]);
const FORBIDDEN_EXECUTION_BUILTINS = new Set(["node:child_process", "node:cluster", "node:vm", "node:worker_threads"]);
const IMPORT_SCANNERS = {
  cjs: new Bun.Transpiler({ loader: "js" }),
  cts: new Bun.Transpiler({ loader: "ts" }),
  js: new Bun.Transpiler({ loader: "js" }),
  jsx: new Bun.Transpiler({ loader: "jsx" }),
  mjs: new Bun.Transpiler({ loader: "js" }),
  mts: new Bun.Transpiler({ loader: "ts" }),
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" })
};

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function pathInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!!rel && rel.split(/[\\/]/, 1).join("") !== ".." && !isAbsolute(rel));
}

async function resolvePackPath(pack, artifactPath) {
  assert(typeof artifactPath === "string" && artifactPath.length > 0, `${pack.name}: empty artifact path rejected`);
  assert(!isAbsolute(artifactPath), `${pack.name}: absolute artifact path rejected`);
  assert(!artifactPath.split(/[\\/]/).includes(".."), `${pack.name}: artifact path escapes pack root`);
  const root = resolve(pack.dir);
  const full = resolve(root, artifactPath);
  assert(pathInside(root, full), `${pack.name}: artifact path escapes pack root`);
  const rootReal = await realpath(root);
  const fullReal = await realpath(full);
  assert(pathInside(rootReal, fullReal), `${pack.name}: artifact path escapes pack root`);
  return full;
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
    const full = await resolvePackPath(pack, artifact.path);
    const checksum = expected.get(artifact.path);
    assert(checksum, `${pack.name}: artifact ${artifact.path} missing from checksums.sha256`);
    const actual = sha256Bytes(await readFile(full));
    assert(actual === checksum, `${pack.name}: checksum mismatch for ${artifact.path}`);
    assert(pack.manifest.checksums[artifact.path] === checksum, `${pack.name}: manifest checksum mismatch for ${artifact.path}`);
  }
}

export function parseImports(source) {
  const imports = scanImportEntries(source)
    .map((entry) => entry.path)
    .filter((path) => typeof path === "string" && path.length > 0);
  return [...new Set(imports)];
}

export function scanImportEntries(source, artifactPath = "artifact.js") {
  return scannerForPath(artifactPath).scanImports(stripShebang(source));
}

function scannerForPath(artifactPath) {
  const ext = artifactPath.split(".").pop();
  return IMPORT_SCANNERS[ext] ?? IMPORT_SCANNERS.js;
}

function stripScannedRequireCalls(source, importEntries) {
  const requireCounts = new Map();
  for (const entry of importEntries) {
    if (entry.kind !== "require-call" || typeof entry.path !== "string") continue;
    requireCounts.set(entry.path, (requireCounts.get(entry.path) ?? 0) + 1);
  }
  return source.replace(COMMONJS_REQUIRE, (match, specifier) => {
    const count = requireCounts.get(specifier) ?? 0;
    if (count <= 0) return match;
    requireCounts.set(specifier, count - 1);
    return "";
  });
}

function stripShebang(source) {
  return source.startsWith("#!") ? source.replace(/^#![^\r\n]*(?:\r?\n|$)/, "") : source;
}

function loaderScanSource(source, artifactPath) {
  return scannerForPath(artifactPath).transformSync(stripShebang(source));
}

function isPreloadFlag(arg) {
  if (typeof arg !== "string") return false;
  return arg === "-r" || /^-r\S+/.test(arg) || PRELOAD_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
}

function sidecarEntrypoint(pack) {
  const command = pack.manifest.metadata?.sidecar?.command;
  if (!Array.isArray(command)) return null;
  assert(!command.some(isPreloadFlag), `${pack.name}: preload flag rejected`);
  const [, ...args] = command;
  return args.find((arg) => EXECUTABLE_ARTIFACT.test(arg)) ?? null;
}

function sidecarRuntime(pack) {
  const command = pack.manifest.metadata?.sidecar?.command;
  return Array.isArray(command) ? command[0] : null;
}

function executableExtension(artifactPath) {
  const match = artifactPath.match(/\.(mjs|js|cjs|ts|tsx)$/);
  return match?.[0] ?? ".mjs";
}

function localImportCandidates(artifactPath, specifier) {
  const imported = normalize(join(artifactPath, "..", specifier));
  const importBase = specifier.endsWith("/") ? normalize(join(imported, "index")) : imported;
  if (EXECUTABLE_ARTIFACT.test(importBase) || importBase.endsWith(".json")) return [importBase];
  const preferred = executableExtension(artifactPath);
  const extensions = [preferred, ...LOCAL_IMPORT_EXTENSIONS.filter((ext) => ext !== preferred)];
  return extensions.map((ext) => `${importBase}${ext}`);
}

async function fileExists(path) {
  try {
    await realpath(path);
    return true;
  } catch {
    return false;
  }
}

function withoutAllowedProcessAccess(source, allowSidecarIo) {
  if (allowSidecarIo) {
    return source
      .replace(/\bprocess\s*\.\s*(?:stdout|stderr)\s*\.\s*write\b/g, "")
      .replace(/\bprocess\s*\.\s*stdin\b/g, "");
  }
  return source;
}

function withoutAllowedBunAccess(source, allowSidecarIo) {
  if (allowSidecarIo) return source.replace(/\bBun\s*\.\s*stdin\s*\.\s*stream\b/g, "");
  return source;
}

function withoutAllowedDenoAccess(source, allowSidecarIo) {
  if (allowSidecarIo) {
    return source
      .replace(/\bDeno\s*\.\s*stdin\b/g, "")
      .replace(/\bDeno\s*\.\s*(?:stdout|stderr)\s*\.\s*write\b/g, "");
  }
  return source;
}

export async function verifySelfContained(pack) {
  const covered = new Set(pack.manifest.artifacts.map((artifact) => artifact.path));
  const allowedBuiltins = new Set(pack.manifest.metadata?.allowedBuiltins ?? []);
  const sidecarEntry = sidecarEntrypoint(pack);
  const sidecarRuntimeName = sidecarRuntime(pack);
  const root = resolve(pack.dir);
  for (const artifact of pack.manifest.artifacts) {
    const full = await resolvePackPath(pack, artifact.path);
    if (!EXECUTABLE_ARTIFACT.test(artifact.path)) continue;
    const source = await readFile(full, "utf8");
    const loaderSource = loaderScanSource(source, artifact.path);
    const importEntries = scanImportEntries(source, artifact.path);
    const specifiers = [...new Set(importEntries
      .map((entry) => entry.path)
      .filter((path) => typeof path === "string" && path.length > 0))];
    assert(!importEntries.some((entry) => entry.kind === "dynamic-import"), `${pack.name}: dynamic import rejected in ${artifact.path}`);
    assert(!DYNAMIC_IMPORT.test(loaderSource), `${pack.name}: dynamic import rejected in ${artifact.path}`);
    for (const pattern of EVAL_PATTERNS) {
      assert(!pattern.test(loaderSource), `${pack.name}: unsafe loader rejected in ${artifact.path}`);
    }
    assert(!ANY_COMMONJS_REQUIRE.test(stripScannedRequireCalls(loaderSource, importEntries)), `${pack.name}: dynamic require rejected in ${artifact.path}`);
    assert(!COMPUTED_MEMBER_ACCESS.test(loaderSource), `${pack.name}: computed member access rejected in ${artifact.path}`);
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:")) {
        assert(!FORBIDDEN_LOADER_BUILTINS.has(specifier), `${pack.name}: loader builtin ${specifier} rejected`);
        assert(allowedBuiltins.has(specifier), `${pack.name}: unchecked builtin ${specifier}`);
        assert(!FORBIDDEN_EXECUTION_BUILTINS.has(specifier), `${pack.name}: code execution builtin ${specifier} rejected`);
        continue;
      }
      assert(specifier.startsWith("./") || specifier.startsWith("../"), `${pack.name}: package import ${specifier} rejected`);
      const candidates = localImportCandidates(artifact.path, specifier)
        .map((candidate) => {
          const resolved = resolve(root, candidate);
          return { resolved, artifactPath: relative(root, resolved) };
        });
      for (const candidate of candidates) {
        assert(pathInside(root, candidate.resolved), `${pack.name}: host path import ${specifier}`);
      }
      const existingCandidates = [];
      for (const candidate of candidates) {
        if (await fileExists(candidate.resolved)) existingCandidates.push(candidate);
      }
      const coverageCandidates = existingCandidates.length > 0 ? existingCandidates : candidates;
      assert(coverageCandidates.every((candidate) => covered.has(candidate.artifactPath)), `${pack.name}: local import ${specifier} not checksum-covered`);
    }
    const allowSidecarIo = artifact.role === "sidecar" && artifact.path === sidecarEntry;
    const allowSidecarProcessIo = allowSidecarIo && ["node", "bun"].includes(sidecarRuntimeName);
    const allowSidecarBunIo = allowSidecarIo && sidecarRuntimeName === "bun";
    const allowSidecarDenoIo = allowSidecarIo && sidecarRuntimeName === "deno";
    assert(!COMMONJS_MODULE_LOADER.test(loaderSource), `${pack.name}: CommonJS module loader rejected in ${artifact.path}`);
    assert(!PROCESS_ACCESS.test(withoutAllowedProcessAccess(loaderSource, allowSidecarProcessIo)), `${pack.name}: process access rejected in ${artifact.path}`);
    assert(!BUN_ACCESS.test(withoutAllowedBunAccess(loaderSource, allowSidecarBunIo)), `${pack.name}: Bun access rejected in ${artifact.path}`);
    assert(!DENO_ACCESS.test(withoutAllowedDenoAccess(loaderSource, allowSidecarDenoIo)), `${pack.name}: Deno access rejected in ${artifact.path}`);
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
  assert(runtime !== "deno" || args[0] === "run", `${pack.name}: deno run subcommand required`);
  assert(!command.some((part) => /^https?:\/\//.test(part)), `${pack.name}: remote sidecar entrypoint rejected`);
  assert(!["bunx", "npx"].includes(runtime), `${pack.name}: package runner rejected`);
  assert(!(runtime === "bun" && args[0] === "x"), `${pack.name}: bun package runner rejected`);
  assert(!(runtime === "npm" && args[0] === "exec"), `${pack.name}: npm exec package runner rejected`);
  assert(!(runtime === "node" && args[0] === "--run"), `${pack.name}: node --run package runner rejected`);
  assert(!args.some((arg) => ["-e", "--eval", "eval"].includes(arg)), `${pack.name}: eval flag rejected`);
  assert(!args.some(isPreloadFlag), `${pack.name}: preload flag rejected`);
  const entry = sidecarEntrypoint(pack);
  assert(entry, `${pack.name}: sidecar entrypoint missing`);
  assert(pack.manifest.artifacts.some((artifact) => artifact.path === entry), `${pack.name}: sidecar entrypoint not artifact-bound`);
  assert(sidecar.stdoutBytes <= 8192, `${pack.name}: stdout bound too high`);
  assert(sidecar.stderrBytes <= 8192, `${pack.name}: stderr bound too high`);
  assert(sidecar.timeoutMs > 0 && sidecar.timeoutMs <= 5000, `${pack.name}: timeout bound missing`);
}

export function assertAdapterManifestParity(pack, adapterManifest) {
  assert(adapterManifest && typeof adapterManifest === "object", `${pack.name}: adapter manifest must be an object`);
  for (const field of ADAPTER_MANIFEST_PARITY_FIELDS) {
    assert(Object.prototype.hasOwnProperty.call(adapterManifest, field), `${pack.name}: adapter manifest missing ${field}`);
    assert(
      stableStringify(adapterManifest[field]) === stableStringify(pack.manifest[field]),
      `${pack.name}: adapter manifest ${field} mismatch`
    );
  }
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
  assertAdapterManifestParity(pack, adapter.manifest());
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
