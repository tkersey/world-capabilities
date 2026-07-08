import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
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
  "authorityLabels",
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

const JS_IDENTIFIER_CONTINUE = String.raw`[$_#\u200c\u200d\p{ID_Continue}]`;
const JS_TOKEN_GAP = String.raw`(?:\s|//[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$)|/\*[\s\S]*?\*/)*`;
const JS_PROPERTY_QUOTE = String.raw`["'\x60]`;
const DYNAMIC_IMPORT = /\bimport\s*\(/;
const UNSAFE_LOADER_HINT = /eval|Function|globalThis|global|self|constructor|with|Object|Reflect|getOwnPropertyDescriptor|getPrototypeOf|import|process|createRequire|Worker|module|require|[\[\]]/;
const HOST_GLOBAL_HINT = /process|Bun|Deno|fetch|WebSocket|EventSource|XMLHttpRequest/;
const OPTIMIZER_ENV_ACCESS = new RegExp(
  String.raw`\bprocess${JS_TOKEN_GAP}(?:\.${JS_TOKEN_GAP}env|\[${JS_TOKEN_GAP}${JS_PROPERTY_QUOTE}env${JS_PROPERTY_QUOTE}${JS_TOKEN_GAP}\])${JS_TOKEN_GAP}(?:\.${JS_TOKEN_GAP}(?:NODE_ENV|BUN_ENV)\b|\[${JS_TOKEN_GAP}${JS_PROPERTY_QUOTE}(?:NODE_ENV|BUN_ENV)${JS_PROPERTY_QUOTE}${JS_TOKEN_GAP}\])`,
  "g"
);
const DYNAMIC_LOADER_IDENTIFIERS = [
  identifierToken("eval"),
  identifierToken("Function"),
  identifierToken("Worker"),
  identifierToken("(?:globalThis|global|self)")
];
const EVAL_PATTERNS = [
  /(?:\.|\?\.)\s*constructor\b/,
  new RegExp(String.raw`(?<!\.)${identifierTokenSource("with")}\s*\(`, "u"),
  /\[\s*["']constructor["']\s*\]/,
  new RegExp(String.raw`${identifierTokenSource("Object")}\s*(?:\.|\?\.)\s*getOwnPropertyDescriptors?(?!${JS_IDENTIFIER_CONTINUE})`, "u"),
  new RegExp(String.raw`${identifierTokenSource("Object")}\s*(?:\.|\?\.)\s*getPrototypeOf(?!${JS_IDENTIFIER_CONTINUE})`, "u"),
  identifierToken("getOwnPropertyDescriptors?|getPrototypeOf"),
  identifierToken("Reflect"),
  new RegExp(String.raw`${identifierTokenSource("Reflect")}\s*(?:\.|\[)`, "u"),
  new RegExp(String.raw`${identifierTokenSource("globalThis")}\s*(?:\.|\[)`, "u"),
  new RegExp(String.raw`${identifierTokenSource("global")}\s*(?:\.|\[)`, "u"),
  new RegExp(String.raw`${identifierTokenSource("self")}\s*(?:\.|\[)`, "u"),
  new RegExp(String.raw`${identifierTokenSource("globalThis")}\s*\[\s*["']Function["']\s*\]`, "u"),
  new RegExp(String.raw`${identifierTokenSource("process")}\s*\[`, "u"),
  new RegExp(String.raw`${identifierTokenSource("process")}\s*\.\s*constructor(?!${JS_IDENTIFIER_CONTINUE})`, "u"),
  new RegExp(String.raw`${identifierTokenSource("process")}\s*\.\s*getBuiltinModule(?!${JS_IDENTIFIER_CONTINUE})\s*\(`, "u"),
  new RegExp(String.raw`${identifierTokenSource("process")}\s*\[\s*["']getBuiltinModule["']\s*\]`, "u"),
  new RegExp(String.raw`${identifierTokenSource("process")}\s*\.\s*mainModule(?!${JS_IDENTIFIER_CONTINUE})`, "u"),
  new RegExp(String.raw`${identifierTokenSource("process")}\s*\[\s*["']mainModule["']\s*\]`, "u"),
  new RegExp(String.raw`${identifierTokenSource("globalThis")}\s*\[\s*["']process["']\s*\]`, "u"),
  new RegExp(String.raw`=\s*${identifierTokenSource("process")}`, "u"),
  new RegExp(String.raw`${identifierTokenSource("import")}\s*\.\s*meta\s*\.\s*require(?!${JS_IDENTIFIER_CONTINUE})`, "u"),
  new RegExp(String.raw`${identifierTokenSource("import")}\s*\.\s*meta\s*\[\s*["']require["']\s*\]`, "u"),
  identifierToken("createRequire"),
  new RegExp(String.raw`${identifierTokenSource("new")}\s+${identifierTokenSource("Worker")}\s*\(`, "u")
];
const JS_INTERTOKEN_SPACE = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$))*`;
const JS_REQUIRED_INTERTOKEN_SPACE = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$))+`;
const COMMONJS_REQUIRE = new RegExp(`\\brequire${JS_INTERTOKEN_SPACE}\\(${JS_INTERTOKEN_SPACE}(["'\`])([^"'\`]+)\\1${JS_INTERTOKEN_SPACE}\\)`, "g");
const COMMONJS_MODULE_LOADER = new RegExp(String.raw`${identifierTokenSource("module")}\s*(?:\.|\?\.)\s*(?:constructor|require)(?!${JS_IDENTIFIER_CONTINUE})`, "u");
const PROCESS_ACCESS = identifierToken("process");
const BUN_ACCESS = identifierToken("Bun");
const DENO_ACCESS = identifierToken("Deno");
const NETWORK_GLOBAL_NAMES = ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"];
const ARRAY_LITERAL_PREFIX_KEYWORDS = new Set(["return", "throw", "case", "delete", "void", "typeof", "new", "in", "instanceof"]);
const EXECUTABLE_ARTIFACT = /\.(mjs|js|cjs|jsx|ts|tsx|mts|cts)$/;
const PLAIN_JAVASCRIPT_ARTIFACT = /\.(mjs|js|cjs)$/;
const EXECUTABLE_EXTENSIONS = [".mjs", ".js", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"];
const LOCAL_IMPORT_EXTENSIONS = [...EXECUTABLE_EXTENSIONS, ".json"];
const UNSUPPORTED_RUNTIME_IMPORT_EXTENSIONS = [".node"];
const NODE_TYPESCRIPT_ARTIFACT = /\.(ts|mts|cts)$/;
const NODE_MTS_ARTIFACT = /\.mts$/;
const NODE_CTS_ARTIFACT = /\.cts$/;
const NODE_UNSUPPORTED_RUNTIME_ARTIFACT = /\.(jsx|tsx)$/;
const NODE_TYPESCRIPT_IDENTIFIER_START = String.raw`[$_\p{ID_Start}]`;
const NODE_TYPESCRIPT_IDENTIFIER_CONTINUE = String.raw`[$\u200c\u200d\p{ID_Continue}]*`;
const NODE_TYPESCRIPT_IDENTIFIER = `${NODE_TYPESCRIPT_IDENTIFIER_START}${NODE_TYPESCRIPT_IDENTIFIER_CONTINUE}`;
const NODE_TYPESCRIPT_TYPE_PARAMETERS = String.raw`(?:<[^)\r\n]+>\s*)?`;
const NODE_TYPESCRIPT_NESTED_TYPE_PARAMETERS = String.raw`(?:<(?:=>|[^<>\r\n]|<[^<>\r\n]*>)*>\s*)?`;
const NODE_UNSUPPORTED_TYPESCRIPT_SYNTAX = [
  new RegExp(String.raw`\benum\s+${NODE_TYPESCRIPT_IDENTIFIER_START}`, "u"),
  new RegExp(String.raw`\b(?:namespace|module)\s+${NODE_TYPESCRIPT_IDENTIFIER_START}`, "u"),
  new RegExp(String.raw`(?:^|[({[=,:;!&|?+\-*~^<>%/]|\b(?:return|throw|yield|await|case|delete|void|typeof|new)\b)\s*<\s*${NODE_TYPESCRIPT_IDENTIFIER}(?:[\s<>,[\].?&|]|${NODE_TYPESCRIPT_IDENTIFIER})*>\s*(?!\([^)]*\)\s*(?::[^=\r\n]*)?=>)(?:${NODE_TYPESCRIPT_IDENTIFIER_START}|\d|["'({[+\-!~])`, "u"),
  new RegExp(String.raw`@\s*(?:${NODE_TYPESCRIPT_IDENTIFIER_START}|\()`, "u"),
  new RegExp(String.raw`constructor\s*\((?:[^)]*,)?\s*(?:public|private|protected|readonly|override)\s+${NODE_TYPESCRIPT_IDENTIFIER_START}`, "u"),
  new RegExp(String.raw`\bimport\s+(?!type\b)${NODE_TYPESCRIPT_IDENTIFIER}\s*=`, "u"),
  new RegExp(String.raw`(?:${identifierTokenSource("declare")}\s+)?(?<!\.)${identifierTokenSource("export")}\s*=`, "u")
];
const NODE_CTS_UNSUPPORTED_MODULE_SYNTAX = [
  new RegExp(String.raw`\bimport(?:${JS_INTERTOKEN_SPACE}(?:["'{*])|${JS_REQUIRED_INTERTOKEN_SPACE}(?!type\b)${NODE_TYPESCRIPT_IDENTIFIER_START})`, "u"),
  new RegExp(String.raw`\bexport(?:${JS_INTERTOKEN_SPACE}(?:["'{*])|${JS_REQUIRED_INTERTOKEN_SPACE}(?!type\b)(?:default\b|class\b|const\b|function\b|let\b|var\b|${NODE_TYPESCRIPT_IDENTIFIER_START}))`, "u")
];
const COMMONJS_WRAPPER_BINDINGS = ["require", "exports", "module", "__filename", "__dirname"];
const NODE_TYPESCRIPT_INLINE_TYPE_FROM_IMPORT = new RegExp(
  String.raw`\b(?:import|export)${JS_INTERTOKEN_SPACE}\{[^{}]*?\btype\b[^{}]*?\}${JS_INTERTOKEN_SPACE}from${JS_INTERTOKEN_SPACE}(["'\x60])([^"'\x60]+)\1`,
  "gu"
);
const NODE_MTS_UNSUPPORTED_MODULE_SYNTAX = [
  hasNodeMtsBareRequireCall,
  hasNodeMtsCommonJsModuleMember
];
const PRELOAD_FLAGS = ["--import", "--require", "--import-map", "--preload", "--loader", "--experimental-loader"];
const FORBIDDEN_LOADER_BUILTINS = new Set(["node:module", "node:process"]);
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

function identifierTokenSource(pattern) {
  return String.raw`(?<!${JS_IDENTIFIER_CONTINUE})(?:${pattern})(?!${JS_IDENTIFIER_CONTINUE})`;
}

function identifierToken(pattern) {
  return new RegExp(identifierTokenSource(pattern), "u");
}

function isScannableArtifact(artifactPath) {
  const basename = artifactPath.split(/[\\/]/).pop() ?? artifactPath;
  return EXECUTABLE_ARTIFACT.test(artifactPath) || !basename.includes(".");
}

function hasExplicitExtension(artifactPath) {
  return (artifactPath.split(/[\\/]/).pop() ?? artifactPath).includes(".");
}

function hasSupportedImportExtension(artifactPath) {
  return EXECUTABLE_ARTIFACT.test(artifactPath) || artifactPath.endsWith(".json");
}

function hasUnsupportedExactImportExtension(artifactPath) {
  return hasExplicitExtension(artifactPath) && !hasSupportedImportExtension(artifactPath);
}

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

function nodeTypeScriptRuntimeTypeImportEntries(source, artifactPath, sidecarRuntimeName, isAdapterArtifact, nodeModuleKind) {
  if (sidecarRuntimeName !== "node" || isAdapterArtifact || nodeModuleKind !== "esm" || !NODE_TYPESCRIPT_ARTIFACT.test(artifactPath)) return [];
  const entries = [];
  const scanSource = eraseNodeTypeScriptDeclarations(stripShebang(source));
  for (const match of scanSource.matchAll(NODE_TYPESCRIPT_INLINE_TYPE_FROM_IMPORT)) {
    const offset = match.index ?? 0;
    if (!isExecutableSourceOffset(scanSource, offset)) continue;
    const path = match[2];
    if (typeof path === "string" && path.length > 0) {
      entries.push({ kind: "node-type-only-runtime-import", path });
    }
  }
  return entries;
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
  return source.replace(COMMONJS_REQUIRE, (match, _quote, specifier, offset) => {
    if (!isExecutableSourceOffset(source, offset)) return match;
    const count = requireCounts.get(specifier) ?? 0;
    if (count <= 0) return match;
    requireCounts.set(specifier, count - 1);
    return "";
  });
}

function isExecutableSourceOffset(source, offset) {
  let result = "";
  for (let i = 0; i < source.length && i <= offset;) {
    const ch = source[i];
    if (ch === "\"" || ch === "'") {
      const end = skipQuoted(source, i, ch);
      if (offset < end) return false;
      result += "\"\"";
      i = end;
      continue;
    }
    if (ch === "`") {
      const executable = templateOffsetExecutable(source, i, offset);
      if (executable !== null) return executable;
      const end = skipTemplateLiteral(source, i);
      result += "``";
      i = end;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = skipLineComment(source, i);
      if (offset < end) return false;
      result += "\n";
      i = end;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = skipBlockComment(source, i);
      if (offset < end) return false;
      result += " ";
      i = end;
      continue;
    }
    if (ch === "/" && isRegexLiteralStart(result)) {
      const end = skipRegexLiteral(source, i);
      if (end > i) {
        if (offset < end) return false;
        result += "/ /";
        i = end;
        continue;
      }
    }
    result += ch;
    i += 1;
  }
  return true;
}

function templateOffsetExecutable(source, start, offset) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      if (offset < i + 2) return false;
      i += 2;
      continue;
    }
    if (source[i] === "`") return offset < i + 1 ? false : null;
    if (source[i] === "$" && source[i + 1] === "{") {
      const expressionStart = i + 2;
      const expression = readTemplateExpression(source, expressionStart);
      const expressionEnd = expression.end - 1;
      if (offset >= expressionStart && offset < expressionEnd) {
        return isExecutableSourceOffset(expression.text, offset - expressionStart);
      }
      if (offset < expression.end) return false;
      i = expression.end;
      continue;
    }
    if (offset === i) return false;
    i += 1;
  }
  return offset < source.length ? false : null;
}

function stripShebang(source) {
  return source.startsWith("#!") ? source.replace(/^#![^\r\n]*(?:\r?\n|$)/, "") : source;
}

function withoutStringLiterals(source, stripRegex = true, scanOptions = {}) {
  let result = "";
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (ch === "\"" || ch === "'") {
      i = skipQuoted(source, i, ch);
      result += "\"\"";
      continue;
    }
    if (ch === "`") {
      const stripped = stripTemplateLiteral(source, i, stripRegex, scanOptions);
      result += stripped.text;
      i = stripped.end;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i = skipLineComment(source, i);
      result += "\n";
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = skipBlockComment(source, i);
      result += " ";
      continue;
    }
    if (stripRegex && ch === "/" && isRegexLiteralStart(result, scanOptions)) {
      const end = skipRegexLiteral(source, i);
      if (end > i) {
        result += "/ /";
        i = end;
        continue;
      }
    }
    result += ch;
    i += 1;
  }
  return result;
}

function skipQuoted(source, start, quote) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

function skipLineComment(source, start) {
  let i = start + 2;
  while (i < source.length && !isLineTerminator(source[i])) i += 1;
  return i;
}

function isLineTerminator(ch) {
  return ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";
}

function skipBlockComment(source, start) {
  const end = source.indexOf("*/", start + 2);
  return end === -1 ? source.length : end + 2;
}

function stripTemplateLiteral(source, start, stripRegex = true, scanOptions = {}) {
  let result = "`";
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "`") return { text: `${result}\``, end: i + 1 };
    if (source[i] === "$" && source[i + 1] === "{") {
      const expression = readTemplateExpression(source, i + 2, scanOptions);
      result += `\${${withoutStringLiterals(expression.text, stripRegex, scanOptions)}}`;
      i = expression.end;
      continue;
    }
    i += 1;
  }
  return { text: result, end: i };
}

function readTemplateExpression(source, start, scanOptions = {}) {
  let depth = 1;
  let i = start;
  let prefix = "";
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\"" || ch === "'") {
      i = skipQuoted(source, i, ch);
      prefix += "\"\"";
      continue;
    }
    if (ch === "`") {
      i = skipTemplateLiteral(source, i);
      prefix += "``";
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i = skipLineComment(source, i);
      prefix += "\n";
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = skipBlockComment(source, i);
      prefix += " ";
      continue;
    }
    if (ch === "/" && isRegexLiteralStart(prefix, scanOptions)) {
      const end = skipRegexLiteral(source, i);
      if (end > i) {
        prefix += "/ /";
        i = end;
        continue;
      }
    }
    if (ch === "{") {
      depth += 1;
      prefix += ch;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { text: source.slice(start, i), end: i + 1 };
      prefix += ch;
    }
    if (ch !== "{" && ch !== "}") prefix += ch;
    i += 1;
  }
  return { text: source.slice(start), end: i };
}

function skipTemplateLiteral(source, start) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "`") return i + 1;
    if (source[i] === "$" && source[i + 1] === "{") {
      i = readTemplateExpression(source, i + 2).end;
      continue;
    }
    i += 1;
  }
  return i;
}

function isRegexLiteralStart(result, scanOptions = {}) {
  const trimmed = result.trimEnd();
  if (!trimmed) return true;
  if (/\+\+$|--$/.test(trimmed)) return false;
  if (/[\(\{\[=,:;!&|?+\-*~^<>%]$/.test(trimmed)) return true;
  if (/=>\s*$/.test(trimmed)) return true;
  if (isAfterControlStatementHead(trimmed)) return true;
  if (isAfterStatementBlock(trimmed)) return true;
  const token = trimmed.match(/([A-Za-z_$#][\w$#]*)\s*$/);
  if (!token || !["return", "throw", "case", "delete", "void", "typeof", "await", "yield", "instanceof", "in", "of", "do", "else", "extends", "new", "default"].includes(token[1])) return false;
  const tokenStart = token.index ?? 0;
  if (tokenStart > 0 && isIdentifierPartChar(trimmed[tokenStart - 1])) return false;
  const beforeKeyword = trimmed.slice(0, tokenStart).trimEnd();
  if (beforeKeyword.endsWith(".")) return false;
  if (["await", "yield"].includes(token[1]) && !contextualKeywordMayPrefixExpression(trimmed, tokenStart, token[1], scanOptions)) return false;
  return token[1] !== "of" || isForOfOperatorPrefix(beforeKeyword);
}

function contextualKeywordMayPrefixExpression(source, tokenStart, keyword, scanOptions = {}) {
  const body = nearestEnclosingFunctionBody(source, tokenStart);
  if (!body) return keyword === "await" && scanOptions.allowTopLevelAwait === true;
  return keyword === "await" ? body.async : body.generator;
}

function nearestEnclosingFunctionBody(source, start) {
  const stack = [];
  for (let i = 0; i < start; i += 1) {
    if (source[i] === "{") {
      stack.push(i);
      continue;
    }
    if (source[i] === "}") stack.pop();
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const body = functionBodyBeforeBrace(source, stack[i]);
    if (body) return body;
  }
  return null;
}

function nearestArgumentsBindingFunctionBody(source, start) {
  const stack = [];
  for (let i = 0; i < start; i += 1) {
    if (source[i] === "{") {
      stack.push(i);
      continue;
    }
    if (source[i] === "}") stack.pop();
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const body = functionBodyBeforeBrace(source, stack[i]);
    if (body?.arguments) return body;
  }
  return null;
}

function functionBodyBeforeBrace(source, openBrace) {
  const head = source.slice(0, openBrace).trimEnd();
  if (!head) return null;
  if (/=>\s*$/.test(head)) return arrowFunctionBodyBeforeArrow(head.replace(/=>\s*$/, ""));
  if (!head.endsWith(")")) return null;
  const openParen = findOpeningDelimiter(head, head.length - 1, "(", ")");
  if (openParen < 0) return null;
  const beforeParams = head.slice(0, openParen).trimEnd();
  if (/\basync\s+function\s*\*(?:\s+[A-Za-z_$#][\w$#]*)?$/.test(beforeParams)) return { async: true, generator: true, arguments: true };
  if (/\basync\s+function(?:\s+[A-Za-z_$#][\w$#]*)?$/.test(beforeParams)) return { async: true, generator: false, arguments: true };
  if (/\bfunction\s*\*(?:\s+[A-Za-z_$#][\w$#]*)?$/.test(beforeParams)) return { async: false, generator: true, arguments: true };
  if (/\bfunction(?:\s+[A-Za-z_$#][\w$#]*)?$/.test(beforeParams)) return { async: false, generator: false, arguments: true };
  if (/\basync\s*\*\s*(?:[#A-Za-z_$][\w$#]*|\[[^\]]+\])$/.test(beforeParams)) return { async: true, generator: true, arguments: true };
  if (/(?:^|[\s{;,])\*\s*(?:[#A-Za-z_$][\w$#]*|\[[^\]]+\])$/.test(beforeParams)) return { async: false, generator: true, arguments: true };
  if (/\basync\s+(?:[#A-Za-z_$][\w$#]*|\[[^\]]+\])$/.test(beforeParams)) return { async: true, generator: false, arguments: true };
  if (plainMethodBodyBeforeParams(beforeParams)) return { async: false, generator: false, arguments: true };
  return null;
}

function plainMethodBodyBeforeParams(source) {
  const name = identifierEndingAt(source, source.length - 1);
  if (!name || ["catch", "for", "if", "switch", "while", "with"].includes(name)) return false;
  const beforeName = source.slice(0, source.length - name.length);
  const previous = previousSignificant(beforeName, beforeName.length);
  return previous?.ch === "{" || previous?.ch === ",";
}

function arrowFunctionBodyBeforeArrow(head) {
  const beforeArrow = head.trimEnd();
  if (!beforeArrow) return { async: false, generator: false };
  if (beforeArrow.endsWith(")")) {
    const openParen = findOpeningDelimiter(beforeArrow, beforeArrow.length - 1, "(", ")");
    if (openParen < 0) return { async: false, generator: false, arguments: false };
    const beforeParams = beforeArrow.slice(0, openParen).trimEnd();
    return { async: identifierEndingAt(beforeParams, beforeParams.length - 1) === "async", generator: false, arguments: false };
  }
  const parameter = identifierEndingAt(beforeArrow, beforeArrow.length - 1);
  if (!parameter) return { async: false, generator: false, arguments: false };
  const beforeParameter = beforeArrow.slice(0, beforeArrow.length - parameter.length).trimEnd();
  return { async: identifierEndingAt(beforeParameter, beforeParameter.length - 1) === "async", generator: false, arguments: false };
}

function isAfterStatementBlock(prefix) {
  if (!prefix.endsWith("}")) return false;
  const open = matchingOpenBrace(prefix, prefix.length - 1);
  if (open < 0) return false;
  const beforeBrace = prefix.slice(0, open).trimEnd();
  if (isAfterControlStatementHead(beforeBrace)) return true;
  if (isAfterDeclarationStatementBlock(beforeBrace)) return true;
  const token = beforeBrace.match(/([A-Za-z_$#][\w$#]*)$/);
  if (!token || !["do", "else", "finally", "try"].includes(token[1])) return false;
  const tokenStart = token.index ?? 0;
  return tokenStart === 0 || !isIdentifierPartChar(beforeBrace[tokenStart - 1]);
}

function isAfterDeclarationStatementBlock(beforeBrace) {
  return isAfterFunctionDeclarationBlock(beforeBrace) || isAfterClassDeclarationBlock(beforeBrace);
}

function isAfterFunctionDeclarationBlock(beforeBrace) {
  if (!beforeBrace.endsWith(")")) return false;
  const openParen = findOpeningDelimiter(beforeBrace, beforeBrace.length - 1, "(", ")");
  if (openParen < 0) return false;
  const head = statementHeadAfterLastBoundary(beforeBrace.slice(0, openParen));
  const match = head.match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?(?:\s+([A-Za-z_$][\w$]*))?$/);
  return !!match && (!!match[1] || /\bexport\s+default\b/.test(head));
}

function isAfterClassDeclarationBlock(beforeBrace) {
  const head = statementHeadAfterLastBoundary(beforeBrace);
  const match = head.match(/^(?:export\s+(?:default\s+)?)?class(?:\s+([A-Za-z_$][\w$]*))?(?:\s+extends\b[\s\S]+)?$/);
  return !!match && (!!match[1] || /\bexport\s+default\b/.test(head));
}

function statementHeadAfterLastBoundary(source) {
  const boundary = Math.max(source.lastIndexOf(";"), source.lastIndexOf("{"), source.lastIndexOf("}"));
  return source.slice(boundary + 1).trim();
}

function matchingOpenBrace(source, closeIndex) {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    if (source[i] === "}") {
      depth += 1;
      continue;
    }
    if (source[i] !== "{") continue;
    depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

function isAfterControlStatementHead(prefix) {
  if (!prefix.endsWith(")")) return false;
  let depth = 0;
  for (let i = prefix.length - 1; i >= 0; i -= 1) {
    if (prefix[i] === ")") {
      depth += 1;
      continue;
    }
    if (prefix[i] !== "(") continue;
    depth -= 1;
    if (depth > 0) continue;
    const head = prefix.slice(0, i).trimEnd();
    const token = head.match(/([A-Za-z_$#][\w$#]*)$/);
    if (!token || !["catch", "if", "while", "for", "with"].includes(token[1])) return false;
    const tokenStart = token.index ?? 0;
    if (tokenStart > 0 && isIdentifierPartChar(head[tokenStart - 1])) return false;
    return head[tokenStart - 1] !== ".";
  }
  return false;
}

function isIdentifierPartChar(ch) {
  return !!ch && (/[\w$#]/.test(ch) || ch.charCodeAt(0) > 127);
}

function isIdentifierStartChar(ch) {
  return !!ch && (/[A-Za-z_$#]/.test(ch) || ch.charCodeAt(0) > 127);
}

function isForOfOperatorPrefix(prefix) {
  let depth = 0;
  for (let i = prefix.length - 1; i >= 0; i -= 1) {
    if (prefix[i] === ")") {
      depth += 1;
      continue;
    }
    if (prefix[i] !== "(") continue;
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    const headPrefix = prefix.slice(i + 1);
    if (headPrefix.includes(";")) return false;
    if (hasTopLevelOfToken(headPrefix)) return false;
    const previous = previousSignificant(prefix, prefix.length);
    if (!previous || /[\(\{\[=,:;!&|?+\-*~^<>%\/]/.test(previous.ch)) return false;
    if (["await", "delete", "in", "instanceof", "new", "typeof", "void", "yield"].includes(identifierEndingAt(prefix, previous.index))) return false;
    return /\bfor(?:\s+await)?$/.test(prefix.slice(0, i).trimEnd());
  }
  return false;
}

function skipRegexLiteral(source, start) {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n" || ch === "\r") return start;
    if (ch === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === "]" && inClass) {
      inClass = false;
      i += 1;
      continue;
    }
    if (ch === "/" && !inClass) {
      i += 1;
      while (/[A-Za-z]/.test(source[i] ?? "")) i += 1;
      return i;
    }
    i += 1;
  }
  return start;
}

function loaderScanSource(source, artifactPath) {
  return scannerForPath(artifactPath).transformSync(stripShebang(source));
}

function loaderScanInputs(source, artifactPath, scanOptions = {}) {
  const transformed = loaderScanSource(source, artifactPath);
  const optimizerResistant = optimizerResistantLoaderScanSources(source, artifactPath);
  return [...new Set([transformed, ...optimizerResistant])].map((loaderSource) => ({
    loaderSource,
    codeSource: executableCodeSource(loaderSource, scanOptions)
  }));
}

function optimizerResistantLoaderScanSources(source, artifactPath) {
  const raw = withoutOptimizerInputs(stripShebang(source));
  const transformed = scannerForPath(artifactPath).transformSync(raw);
  if (!hasExplicitExtension(artifactPath) || PLAIN_JAVASCRIPT_ARTIFACT.test(artifactPath)) return [raw, transformed];
  return [transformed];
}

function executableCodeSource(source, scanOptions = {}) {
  return normalizeIdentifierEscapes(withoutStringLiterals(source, true, scanOptions));
}

export function scannerExecutableCodeSourceForTest(source) {
  return executableCodeSource(source);
}

export function scannerHasComputedMemberAccessForTest(source) {
  return hasComputedMemberAccess(executableCodeSource(source));
}

function withoutOptimizerPragmas(source) {
  return source.replace(/([@#])__(?:PURE|NO_SIDE_EFFECTS)__/g, "$1__WORLD_DISABLED_OPTIMIZER_PRAGMA__");
}

function withoutOptimizerInputs(source) {
  return withoutOptimizerConstants(normalizeExecutableIdentifierEscapes(withoutOptimizerPragmas(source)));
}

function withoutOptimizerConstants(source) {
  return source.replace(OPTIMIZER_ENV_ACCESS, "process.env.__WORLD_ENV__");
}

function normalizeExecutableIdentifierEscapes(source) {
  let result = "";
  let scanPrefix = "";
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (ch === "\"" || ch === "'") {
      const end = skipQuoted(source, i, ch);
      result += source.slice(i, end);
      scanPrefix += "\"\"";
      i = end;
      continue;
    }
    if (ch === "`") {
      const template = normalizeTemplateExecutableIdentifierEscapes(source, i);
      result += template.text;
      scanPrefix += "``";
      i = template.end;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = skipLineComment(source, i);
      result += source.slice(i, end);
      scanPrefix += "\n";
      i = end;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = skipBlockComment(source, i);
      result += source.slice(i, end);
      scanPrefix += " ";
      i = end;
      continue;
    }
    if (ch === "/" && isRegexLiteralStart(scanPrefix)) {
      const end = skipRegexLiteral(source, i);
      if (end > i) {
        result += source.slice(i, end);
        scanPrefix += "/ /";
        i = end;
        continue;
      }
    }
    const escaped = identifierEscapeAt(source, i);
    if (escaped) {
      result += escaped.text;
      scanPrefix += escaped.text;
      i = escaped.end;
      continue;
    }
    result += ch;
    scanPrefix += ch;
    i += 1;
  }
  return result;
}

function normalizeTemplateExecutableIdentifierEscapes(source, start) {
  let result = "`";
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      result += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (source[i] === "`") return { text: `${result}\``, end: i + 1 };
    if (source[i] === "$" && source[i + 1] === "{") {
      const expression = readTemplateExpression(source, i + 2);
      result += `\${${normalizeExecutableIdentifierEscapes(expression.text)}}`;
      i = expression.end;
      continue;
    }
    result += source[i];
    i += 1;
  }
  return { text: result, end: i };
}

function normalizeIdentifierEscapes(source) {
  return source.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, (match, braced, fixed) => {
    const codePoint = Number.parseInt(braced ?? fixed, 16);
    if (!Number.isFinite(codePoint)) return match;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}

function identifierEscapeAt(source, start) {
  const match = source.slice(start).match(/^\\u\{([0-9a-fA-F]+)\}|^\\u([0-9a-fA-F]{4})/);
  if (!match) return null;
  const codePoint = Number.parseInt(match[1] ?? match[2], 16);
  if (!Number.isFinite(codePoint)) return null;
  try {
    return { text: String.fromCodePoint(codePoint), end: start + match[0].length };
  } catch {
    return null;
  }
}

function isPreloadFlag(arg) {
  if (typeof arg !== "string") return false;
  return arg === "-r" || /^-r\S+/.test(arg) || PRELOAD_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
}

function isSidecarOptionArg(arg) {
  return typeof arg === "string" && arg.startsWith("-");
}

function sidecarEntrypointIndex(command) {
  if (!Array.isArray(command) || command.length < 2) return -1;
  const [runtime, ...args] = command;
  return runtime === "deno" && args[0] === "run" ? 2 : 1;
}

function sidecarRuntimeArgsBeforeEntrypoint(command) {
  const index = sidecarEntrypointIndex(command);
  return index < 0 ? [] : command.slice(1, index);
}

function sidecarRuntimeArgsThroughEntrypoint(command) {
  const index = sidecarEntrypointIndex(command);
  return index < 0 ? command.slice(1) : command.slice(1, index + 1);
}

function sidecarEntrypoint(pack) {
  const command = pack.manifest.metadata?.sidecar?.command;
  if (!Array.isArray(command)) return null;
  const runtimeArgs = sidecarRuntimeArgsBeforeEntrypoint(command);
  const entry = command[sidecarEntrypointIndex(command)];
  assert(!runtimeArgs.some(isPreloadFlag) && !isPreloadFlag(entry), `${pack.name}: preload flag rejected`);
  assert(!runtimeArgs.some(isSidecarOptionArg) && !isSidecarOptionArg(entry), `${pack.name}: sidecar option argument rejected`);
  return isLocalSidecarEntrypoint(entry) ? entry : null;
}

function isLocalSidecarEntrypoint(entry) {
  const normalized = typeof entry === "string" ? normalize(entry) : "";
  return typeof entry === "string" &&
    EXECUTABLE_ARTIFACT.test(entry) &&
    normalized !== "adapter.mjs" &&
    !entry.split(/[\\/]/).includes("..") &&
    !normalized.split(/[\\/]/).includes("..") &&
    !isAbsolute(entry) &&
    !entry.includes("://") &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(entry);
}

function sidecarRuntime(pack) {
  const command = pack.manifest.metadata?.sidecar?.command;
  return Array.isArray(command) ? command[0] : null;
}

function executableExtension(artifactPath) {
  const match = artifactPath.match(/\.(mjs|js|cjs|jsx|ts|tsx|mts|cts)$/);
  return match?.[0] ?? ".mjs";
}

function localImportExtensions(artifactPath) {
  const preferred = executableExtension(artifactPath);
  return [preferred, ...LOCAL_IMPORT_EXTENSIONS.filter((ext) => ext !== preferred)];
}

function hasEncodedDotSegment(specifier) {
  return specifier.split(/[\\/]/).some((segment) => encodedSegmentIsDotSegment(segment));
}

function hasUrlSuffix(specifier) {
  return /[?#]/.test(specifier);
}

function hasPercentEncodedOctet(specifier) {
  return /%[0-9a-fA-F]{2}/.test(specifier);
}

function encodedSegmentIsDotSegment(segment) {
  if (!/%2e/i.test(segment)) return false;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === "." || decoded === "..";
  } catch {
    return true;
  }
}

function localImportDirectCandidates(pack, artifactPath, specifier) {
  const imported = normalize(join(artifactPath, "..", specifier));
  if (specifier.endsWith("/")) return [];
  if (hasSupportedImportExtension(imported)) return [imported];
  return [imported, ...localImportExtensions(artifactPath).map((ext) => `${imported}${ext}`)];
}

function localImportDirectoryIndexCandidates(artifactPath, specifier) {
  const imported = normalize(join(artifactPath, "..", specifier));
  if (!specifier.endsWith("/") && hasSupportedImportExtension(imported)) return [];
  const indexBase = normalize(join(imported, "index"));
  return [indexBase, ...localImportExtensions(artifactPath).map((ext) => `${indexBase}${ext}`)];
}

function localImportCandidates(pack, artifactPath, specifier) {
  return [...new Set([
    ...localImportDirectCandidates(pack, artifactPath, specifier),
    ...localImportDirectoryIndexCandidates(artifactPath, specifier)
  ])];
}

function sidecarArtifactRequiresExplicitLocalSpecifiers(sidecarRuntimeName, isAdapterArtifact) {
  return ["node", "deno"].includes(sidecarRuntimeName) && !isAdapterArtifact;
}

function sidecarRuntimeDisallowsAdapterImport(sidecarRuntimeName, isAdapterArtifact, adapterReal) {
  return ["node", "bun", "deno"].includes(sidecarRuntimeName) &&
    adapterReal !== null &&
    !isAdapterArtifact;
}

function nodeSidecarRequiresStripOnlyTypeScript(sidecarRuntimeName, artifact, isAdapterArtifact) {
  return sidecarRuntimeName === "node" && !isAdapterArtifact && NODE_TYPESCRIPT_ARTIFACT.test(artifact.path);
}

function nodeSidecarUsesUnsupportedRuntimeArtifact(sidecarRuntimeName, artifact, isAdapterArtifact) {
  return sidecarRuntimeName === "node" && !isAdapterArtifact && NODE_UNSUPPORTED_RUNTIME_ARTIFACT.test(artifact.path);
}

function nodeSidecarRequiresModuleSyntaxChecks(sidecarRuntimeName, artifact, isAdapterArtifact) {
  return sidecarRuntimeName === "node" &&
    !isAdapterArtifact &&
    EXECUTABLE_ARTIFACT.test(artifact.path) &&
    !NODE_UNSUPPORTED_RUNTIME_ARTIFACT.test(artifact.path);
}

function nodeSidecarModuleKind(sidecarRuntimeName, artifact, isAdapterArtifact, packageType, source, moduleSyntaxSource) {
  if (sidecarRuntimeName !== "node" || isAdapterArtifact) return null;
  if (/\.(mjs|mts)$/.test(artifact.path)) return "esm";
  if (/\.(cjs|cts)$/.test(artifact.path)) return "cjs";
  if (packageType === "module") return "esm";
  if (packageType === "commonjs") return "cjs";
  return nodeSourceUsesEsmSyntax(source, moduleSyntaxSource) ? "esm" : "cjs";
}

function artifactAllowsTopLevelAwait(artifactPath, nodeModuleKind, moduleSyntaxSource, sidecarRuntimeName = null, isAdapterArtifact = false, isBunModuleArtifact = false) {
  if (nodeModuleKind === "cjs") return false;
  if (nodeModuleKind === "esm") return true;
  if (/\.(mjs|mts)$/.test(artifactPath)) return true;
  if (/\.(cjs|cts)$/.test(artifactPath)) return false;
  if (isBunModuleArtifact && /\.(?:js|jsx|ts|tsx)$/.test(artifactPath)) return true;
  if (["bun", "deno"].includes(sidecarRuntimeName) && !isAdapterArtifact && /\.(?:js|jsx|ts|tsx)$/.test(artifactPath)) return true;
  return NODE_CTS_UNSUPPORTED_MODULE_SYNTAX.some((check) => sourceCheckMatches(check, moduleSyntaxSource));
}

async function bunStaticModuleArtifacts(pack, covered) {
  const staticImports = new Map();
  const modules = new Set();
  for (const artifact of pack.manifest.artifacts) {
    if (!isScannableArtifact(artifact.path)) continue;
    const source = await readFile(await resolvePackPath(pack, artifact.path), "utf8");
    staticImports.set(
      artifact.path,
      scanImportEntries(source, artifact.path).filter((entry) => entry.kind === "import-statement" && typeof entry.path === "string" && entry.path.startsWith("."))
    );
    const moduleSyntaxSource = executableCodeSource(loaderScanSource(source, artifact.path));
    if (/\.(?:mjs|mts)$/.test(artifact.path) || NODE_CTS_UNSUPPORTED_MODULE_SYNTAX.some((check) => sourceCheckMatches(check, moduleSyntaxSource))) {
      modules.add(artifact.path);
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const artifactPath of [...modules]) {
      for (const entry of staticImports.get(artifactPath) ?? []) {
        for (const candidate of [
          ...localImportDirectCandidates(pack, artifactPath, entry.path),
          ...localImportDirectoryIndexCandidates(artifactPath, entry.path)
        ]) {
          if (!covered.has(candidate) || !isScannableArtifact(candidate) || modules.has(candidate)) continue;
          modules.add(candidate);
          changed = true;
        }
      }
    }
  }
  return modules;
}

function nodeSourceUsesEsmSyntax(source, moduleSyntaxSource) {
  return NODE_CTS_UNSUPPORTED_MODULE_SYNTAX.some((check) => sourceCheckMatches(check, moduleSyntaxSource)) ||
    nodeHasImportMetaSyntax(moduleSyntaxSource) ||
    nodeCtsHasDisallowedAwait(source) ||
    nodeHasCommonJsWrapperLexicalRedeclaration(executableCodeSource(stripShebang(source)));
}

function nodeHasImportMetaSyntax(source) {
  for (let i = source.indexOf("import"); i >= 0; i = source.indexOf("import", i + "import".length)) {
    if (isIdentifierPartChar(source[i - 1]) || isIdentifierPartChar(source[i + "import".length])) continue;
    const previous = previousSignificant(source, i);
    if (previous?.ch === ".") continue;
    const dot = nextSignificant(source, i + "import".length);
    if (dot?.ch !== ".") continue;
    const meta = nextSignificant(source, dot.index + 1);
    if (!meta || identifierStartingAt(source, meta.index) !== "meta") continue;
    if (isIdentifierPartChar(source[meta.index + "meta".length])) continue;
    return true;
  }
  return false;
}

function nodeHasCommonJsWrapperLexicalRedeclaration(source) {
  return COMMONJS_WRAPPER_BINDINGS.some((name) => sourceHasTopLevelLexicalBinding(source, name));
}

function hasJsonStaticImport(importEntries) {
  return importEntries.some((entry) => entry.kind !== "require-call" && typeof entry.path === "string" && entry.path.endsWith(".json"));
}

function artifactUsesCommonJsWrapper(artifactPath, nodeModuleKind) {
  return /\.(?:cjs|cts)$/.test(artifactPath) || nodeModuleKind === "cjs";
}

function nodeStripOnlyTypeScriptSyntaxSource(source, scanOptions = {}) {
  return eraseNodeTypeScriptDeclarations(normalizeExecutableIdentifierEscapes(withoutStringLiterals(stripShebang(source), true, scanOptions)));
}

function eraseNodeTypeScriptDeclarations(source) {
  const chars = source.split("");
  for (const pattern of [
    new RegExp(String.raw`(?:${identifierTokenSource("export")}\s+)?(?:${identifierTokenSource("declare")}\s+)?${identifierTokenSource("interface")}\s+${NODE_TYPESCRIPT_IDENTIFIER}`, "gu"),
    new RegExp(String.raw`(?:${identifierTokenSource("export")}\s+)?${identifierTokenSource("declare")}\s+${identifierTokenSource("global")}\s*\{`, "gu"),
    new RegExp(String.raw`(?:${identifierTokenSource("export")}\s+)?${identifierTokenSource("declare")}\s+(?:${identifierTokenSource("namespace")}|${identifierTokenSource("module")})\s+(?:${NODE_TYPESCRIPT_IDENTIFIER}|["'][^"']*["'])\s*\{`, "gu"),
    new RegExp(String.raw`(?:${identifierTokenSource("export")}\s+)?${identifierTokenSource("declare")}\s+(?:const\s+)?${identifierTokenSource("enum")}\s+${NODE_TYPESCRIPT_IDENTIFIER}`, "gu")
  ]) {
    eraseBraceTypeDeclarations(chars, source, pattern);
  }
  eraseTypeAliases(chars, source);
  return chars.join("");
}

function eraseBraceTypeDeclarations(chars, source, pattern) {
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const braceInMatch = match[0].lastIndexOf("{");
    const brace = braceInMatch >= 0
      ? start + braceInMatch
      : typeDeclarationBodyBrace(source, start + match[0].length);
    if (brace < 0) continue;
    const end = findMatchingDelimiter(source, brace, "{", "}");
    eraseSourceRange(chars, start, end >= 0 ? end + 1 : brace + 1);
  }
}

function typeDeclarationBodyBrace(source, start) {
  let angleDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "<") angleDepth += 1;
    else if (ch === ">" && angleDepth > 0) angleDepth -= 1;
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "{" && angleDepth === 0 && bracketDepth === 0 && parenDepth === 0) return i;
  }
  return -1;
}

function eraseTypeAliases(chars, source) {
  const pattern = new RegExp(String.raw`(?:${identifierTokenSource("export")}\s+)?(?:${identifierTokenSource("declare")}\s+)?${identifierTokenSource("type")}\s+${NODE_TYPESCRIPT_IDENTIFIER}${NODE_TYPESCRIPT_NESTED_TYPE_PARAMETERS}\s*=`, "gu");
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    eraseSourceRange(chars, start, typeAliasEnd(source, start, start + match[0].length));
  }
}

function typeAliasEnd(source, start, fallbackEnd) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = fallbackEnd; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === ";" && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) return i + 1;
    else if ((ch === "\n" || ch === "\r") && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0 && typeAliasCanEndAtLineBreak(source, i)) return i;
  }
  return fallbackEnd;
}

function typeAliasCanEndAtLineBreak(source, index) {
  const previous = previousSignificant(source, index);
  if (!previous || ["=", "|", "&", "?", ":", ",", "(", "{", "[", "<"].includes(previous.ch)) return false;
  const next = nextSignificant(source, index + 1);
  if (!next) return true;
  if (["|", "&", ",", "?", ":"].includes(next.ch)) return false;
  if (["(", "["].includes(next.ch)) return true;
  return identifierStartingAt(source, next.index) !== "";
}

function eraseSourceRange(chars, start, end) {
  for (let i = start; i < end && i < chars.length; i += 1) {
    if (!/\s/.test(chars[i])) chars[i] = " ";
  }
}

function nodeUnsupportedTypeScriptModuleSyntax(moduleKind) {
  if (moduleKind === "cjs") return NODE_CTS_UNSUPPORTED_MODULE_SYNTAX;
  if (moduleKind === "esm") return NODE_MTS_UNSUPPORTED_MODULE_SYNTAX;
  return [];
}

function sourceCheckMatches(check, source) {
  return check instanceof RegExp ? check.test(source) : check(source);
}

function nodeCommonJsSyntaxParses(source, artifactPath) {
  try {
    if (nodeCtsHasDisallowedAwait(source)) return false;
    new Function("exports", "require", "module", "__filename", "__dirname", loaderScanSource(source, artifactPath));
    return true;
  } catch {
    return false;
  }
}

function nodeEsmHasTopLevelReturn(source) {
  const delimiterPairs = buildDelimiterPairs(source);
  for (let i = source.indexOf("return"); i >= 0; i = source.indexOf("return", i + "return".length)) {
    if (isIdentifierPartChar(source[i - 1]) || isIdentifierPartChar(source[i + "return".length])) continue;
    const previous = previousSignificant(source, i);
    if (previous?.ch === ".") continue;
    if (tokenIsObjectPropertyName(source, i, delimiterPairs)) continue;
    if (!nearestEnclosingFunctionBody(source, i)) return true;
  }
  return false;
}

function commonJsWrapperArgumentsAccessed(source) {
  const delimiterPairs = buildDelimiterPairs(source);
  for (let i = source.indexOf("arguments"); i >= 0; i = source.indexOf("arguments", i + "arguments".length)) {
    if (isIdentifierPartChar(source[i - 1]) || isIdentifierPartChar(source[i + "arguments".length])) continue;
    if (identifierIsFunctionParameterBinding(source, i, "arguments", delimiterPairs)) continue;
    if (identifierIsBoundByFunctionParameter(source, i, "arguments", delimiterPairs)) continue;
    if (identifierIsBoundByArrowParameter(source, i, "arguments", delimiterPairs)) continue;
    const previous = previousSignificant(source, i);
    if (previous?.ch === ".") continue;
    if (tokenIsObjectPropertyName(source, i, delimiterPairs)) continue;
    if (!nearestArgumentsBindingFunctionBody(source, i)) return true;
  }
  return false;
}

function identifierIsFunctionParameterBinding(source, index, name, delimiterPairs) {
  const parenStart = enclosingDelimiterStart(source, index, "(", ")", delimiterPairs);
  if (parenStart >= 0) {
    const parenEnd = findMatchingDelimiter(source, parenStart, "(", ")", delimiterPairs);
    if (index < parenEnd && parameterListOwnsFunctionOrArrow(source, parenStart, parenEnd) && parameterListBindsIdentifier(source.slice(parenStart + 1, parenEnd), name)) return true;
  }
  const next = nextSignificant(source, index + name.length);
  return next?.ch === "=" && source[next.index + 1] === ">";
}

function parameterListOwnsFunctionOrArrow(source, parenStart, parenEnd) {
  const after = nextSignificant(source, parenEnd + 1);
  if (after?.ch === "=" && source[after.index + 1] === ">") return true;
  return after?.ch === "{" && !!functionBodyBeforeBrace(source, after.index);
}

function identifierIsBoundByFunctionParameter(source, index, name, delimiterPairs) {
  const stack = [];
  for (let i = 0; i < index; i += 1) {
    if (source[i] === "{") {
      stack.push(i);
      continue;
    }
    if (source[i] === "}") stack.pop();
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const params = functionParameterSourceBeforeBrace(source, stack[i], delimiterPairs);
    if (params !== null && parameterListBindsIdentifier(params, name)) return true;
  }
  return false;
}

function functionParameterSourceBeforeBrace(source, openBrace, delimiterPairs) {
  const head = source.slice(0, openBrace).trimEnd();
  if (/=>\s*$/.test(head)) return arrowParameterSourceBeforeArrow(source, head.lastIndexOf("=>"), delimiterPairs);
  if (!head.endsWith(")") || !functionBodyBeforeBrace(source, openBrace)) return null;
  const openParen = findOpeningDelimiter(head, head.length - 1, "(", ")");
  return openParen >= 0 ? head.slice(openParen + 1, -1) : null;
}

function identifierIsBoundByArrowParameter(source, index, name, delimiterPairs) {
  for (let arrow = source.lastIndexOf("=>", index); arrow >= 0; arrow = source.lastIndexOf("=>", arrow - 1)) {
    const params = arrowParameterSourceBeforeArrow(source, arrow, delimiterPairs);
    if (!parameterListBindsIdentifier(params ?? "", name)) continue;
    if (arrowBodyContainsIndex(source, arrow + 2, index, delimiterPairs)) return true;
  }
  return false;
}

function arrowParameterSourceBeforeArrow(source, arrowIndex, delimiterPairs) {
  const previous = previousSignificant(source, arrowIndex);
  if (!previous) return null;
  if (previous.ch === ")") {
    const openParen = enclosingDelimiterStart(source, previous.index, "(", ")", delimiterPairs);
    return openParen >= 0 ? source.slice(openParen + 1, previous.index) : null;
  }
  const parameter = identifierEndingAt(source, previous.index);
  return parameter || null;
}

function arrowBodyContainsIndex(source, bodyStartHint, index, delimiterPairs) {
  const bodyStart = nextSignificant(source, bodyStartHint)?.index ?? bodyStartHint;
  if (index < bodyStart) return false;
  if (source[bodyStart] === "{") {
    const bodyEnd = findMatchingDelimiter(source, bodyStart, "{", "}", delimiterPairs);
    return bodyEnd < 0 || index < bodyEnd;
  }
  return index < conciseArrowBodyEnd(source, bodyStart);
}

function conciseArrowBodyEnd(source, bodyStart) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if ((ch === "," || ch === ";") && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) return i;
  }
  return source.length;
}

function parameterListBindsIdentifier(source, name) {
  for (const segment of topLevelParameterSegments(source)) {
    const candidate = segment.trim().replace(/^\.\.\.\s*/, "");
    if (!candidate.startsWith(name) || isIdentifierPartChar(candidate[name.length])) continue;
    const next = candidate.slice(name.length).trimStart();
    if (!next || next.startsWith("=")) return true;
  }
  return false;
}

function topLevelParameterSegments(source) {
  const segments = [];
  let start = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "," && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      segments.push(source.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(source.slice(start));
  return segments;
}

function commonJsWrapperArgumentScanSource(source, artifactPath) {
  if (NODE_TYPESCRIPT_ARTIFACT.test(artifactPath)) return nodeRuntimeTypeScriptScanSource(source, artifactPath);
  return executableCodeSource(withoutOptimizerInputs(stripShebang(source)));
}

function tokenIsObjectPropertyName(source, index, delimiterPairs) {
  const previous = propertyNameBoundaryPrevious(source, index);
  if (!previous || !["{", ","].includes(previous.ch)) return false;
  const objectStart = enclosingDelimiterStart(source, index, "{", "}", delimiterPairs);
  if (objectStart >= 0 && objectDelimiterIsPatternContext(source, objectStart, delimiterPairs)) return false;
  const next = nextSignificant(source, index + identifierStartingAt(source, index).length);
  if (next?.ch === ":") return true;
  if (next?.ch !== "(") return false;
  const close = findMatchingDelimiter(source, next.index, "(", ")", delimiterPairs);
  const after = close >= 0 ? nextSignificant(source, close + 1) : null;
  return after?.ch === "{";
}

function propertyNameBoundaryPrevious(source, index) {
  let start = index;
  for (;;) {
    const previous = previousSignificant(source, start);
    if (previous?.ch === "*") {
      start = previous.index;
      continue;
    }
    const modifier = previous ? identifierEndingAt(source, previous.index) : "";
    if (["async", "get", "set", "static"].includes(modifier)) {
      start = previous.index - modifier.length + 1;
      continue;
    }
    return previous;
  }
}

function objectDelimiterIsPatternContext(source, start, delimiterPairs) {
  const cache = delimiterPairs.objectPatternContexts ??= new Map();
  const cached = cache.get(start);
  if (cached !== undefined) return cached;
  const starts = [];
  for (let objectStart = start; objectStart >= 0;) {
    starts.unshift(objectStart);
    objectStart = enclosingDelimiterStart(source, objectStart, "{", "}", delimiterPairs);
  }
  let inheritedPattern = false;
  for (const objectStart of starts) {
    const cachedPattern = cache.get(objectStart);
    if (cachedPattern !== undefined) {
      inheritedPattern = cachedPattern;
      continue;
    }
    const objectEnd = findMatchingDelimiter(source, objectStart, "{", "}", delimiterPairs);
    if (objectEnd < 0) {
      cache.set(objectStart, false);
      inheritedPattern = false;
      continue;
    }
    inheritedPattern = isObjectPatternContext(source, objectStart, objectEnd, inheritedPattern, delimiterPairs);
    cache.set(objectStart, inheritedPattern);
  }
  return inheritedPattern;
}

function sourceMatchesOutsideObjectPropertyName(source, pattern, delimiterPairs = buildDelimiterPairs(source)) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  for (const match of source.matchAll(matcher)) {
    const index = match.index ?? 0;
    if (match[0].length === 0) return true;
    if (isIdentifierStartChar(source[index]) && tokenIsObjectPropertyName(source, index, delimiterPairs)) continue;
    return true;
  }
  return false;
}

function nodeRuntimeTypeScriptScanSource(source, artifactPath) {
  return executableCodeSource(loaderScanSource(withoutOptimizerInputs(stripShebang(source)), artifactPath));
}

function nodeCtsHasDisallowedAwait(source) {
  const executable = nodeStripOnlyTypeScriptSyntaxSource(source);
  const delimiterPairs = buildDelimiterPairs(executable);
  for (let i = executable.indexOf("await"); i >= 0; i = executable.indexOf("await", i + "await".length)) {
    if (isIdentifierPartChar(executable[i - 1]) || isIdentifierPartChar(executable[i + "await".length])) continue;
    const previous = previousSignificant(executable, i);
    if (previous?.ch === ".") continue;
    const next = nextSignificant(executable, i + "await".length);
    if (next?.ch === ":") continue;
    if (next?.ch === "(") {
      const close = findMatchingDelimiter(executable, next.index, "(", ")", delimiterPairs);
      const after = close >= 0 ? nextSignificant(executable, close + 1) : null;
      if (after?.ch === "{") continue;
    }
    if (!awaitInsideAsyncFunctionBody(executable, i, delimiterPairs)) return true;
  }
  return false;
}

function awaitInsideAsyncFunctionBody(source, index, delimiterPairs) {
  if (awaitInsideAsyncArrowExpression(source, index)) return true;
  for (
    let bodyStart = enclosingDelimiterStart(source, index, "{", "}", delimiterPairs);
    bodyStart >= 0;
    bodyStart = enclosingDelimiterStart(source, bodyStart, "{", "}", delimiterPairs)
  ) {
    if (isAsyncFunctionBodyStart(source, bodyStart, delimiterPairs)) return true;
  }
  return false;
}

function awaitInsideAsyncArrowExpression(source, index) {
  for (let arrow = source.lastIndexOf("=>", index); arrow >= 0; arrow = source.lastIndexOf("=>", arrow - 1)) {
    const next = nextSignificant(source, arrow + 2, index);
    if (next?.ch === "{") continue;
    if (!arrowExpressionReachesIndex(source, arrow + 2, index)) continue;
    if (prefixEndsWithAsyncArrowHead(source.slice(0, arrow).trimEnd())) return true;
  }
  return false;
}

function arrowExpressionReachesIndex(source, start, index) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = start; i < index; i += 1) {
    const ch = source[i];
    if (ch === "{") braceDepth += 1;
    if (ch === "}") braceDepth -= 1;
    if (ch === "[") bracketDepth += 1;
    if (ch === "]") bracketDepth -= 1;
    if (ch === "(") parenDepth += 1;
    if (ch === ")") parenDepth -= 1;
    if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0 && ch === ";") return false;
  }
  return true;
}

function prefixEndsWithAsyncArrowHead(prefix) {
  return new RegExp(String.raw`${identifierTokenSource("async")}\s*${NODE_TYPESCRIPT_NESTED_TYPE_PARAMETERS}(?:${NODE_TYPESCRIPT_IDENTIFIER}|\([^)]*\))(?:\s*:[\s\S]*)?$`, "u").test(prefix);
}

function isAsyncFunctionBodyStart(source, bodyStart, delimiterPairs) {
  const prefix = source.slice(0, bodyStart).trimEnd();
  if (prefix.endsWith("=>")) {
    const beforeArrow = prefix.slice(0, -2).trimEnd();
    return prefixEndsWithAsyncArrowHead(beforeArrow);
  }
  const paramClose = asyncFunctionParamCloseBeforeBody(source, bodyStart);
  if (paramClose < 0) return false;
  const paramStart = findOpeningDelimiter(source, paramClose, "(", ")");
  if (paramStart < 0) return false;
  const beforeParams = source.slice(0, paramStart).trimEnd();
  return new RegExp(String.raw`${identifierTokenSource("async")}\s+(?:function(?:\s+\*?\s*${NODE_TYPESCRIPT_IDENTIFIER}\s*${NODE_TYPESCRIPT_NESTED_TYPE_PARAMETERS})?|(?:\*?\s*)?${NODE_TYPESCRIPT_IDENTIFIER}\s*${NODE_TYPESCRIPT_NESTED_TYPE_PARAMETERS})$`, "u").test(beforeParams);
}

function asyncFunctionParamCloseBeforeBody(source, bodyStart) {
  for (
    let previous = previousSignificant(source, bodyStart);
    previous;
    previous = previousSignificant(source, previous.index)
  ) {
    if (previous.ch !== ")") continue;
    const betweenParamsAndBody = source.slice(previous.index + 1, bodyStart).trim();
    if (betweenParamsAndBody === "" || betweenParamsAndBody.startsWith(":")) return previous.index;
  }
  return -1;
}

function hasNodeMtsBareRequireCall(source) {
  const delimiterPairs = buildDelimiterPairs(source);
  for (let i = source.indexOf("require"); i >= 0; i = source.indexOf("require", i + "require".length)) {
    if (isIdentifierPartChar(source[i - 1]) || isIdentifierPartChar(source[i + "require".length])) continue;
    if (identifierIsLocalBindingOrBoundReference(source, i, "require", delimiterPairs)) continue;
    if (identifierIsImportOrReExportSpecifier(source, i, delimiterPairs)) continue;
    const previous = previousSignificant(source, i);
    if (previous?.ch === ".") continue;
    const next = nextSignificant(source, i + "require".length);
    if (next?.ch !== "(") continue;
    const close = findMatchingDelimiter(source, next.index, "(", ")");
    const after = close >= 0 ? nextSignificant(source, close + 1) : null;
    if (after?.ch === "{") continue;
    return true;
  }
  return false;
}

function hasUnboundCommonJsRequireReference(source) {
  const delimiterPairs = buildDelimiterPairs(source);
  for (let i = source.indexOf("require"); i >= 0; i = source.indexOf("require", i + "require".length)) {
    if (isIdentifierPartChar(source[i - 1]) || isIdentifierPartChar(source[i + "require".length])) continue;
    if (identifierIsLocalBindingOrBoundReference(source, i, "require", delimiterPairs)) continue;
    if (identifierIsImportOrReExportSpecifier(source, i, delimiterPairs)) continue;
    const previous = previousSignificant(source, i);
    if (previous?.ch === ".") continue;
    if (tokenIsObjectPropertyName(source, i, delimiterPairs)) continue;
    return true;
  }
  return false;
}

function hasUnboundNetworkGlobalReference(source) {
  const delimiterPairs = buildDelimiterPairs(source);
  for (const name of NETWORK_GLOBAL_NAMES) {
    for (let i = source.indexOf(name); i >= 0; i = source.indexOf(name, i + name.length)) {
      if (isIdentifierPartChar(source[i - 1]) || isIdentifierPartChar(source[i + name.length])) continue;
      if (identifierIsLocalBindingOrBoundReference(source, i, name, delimiterPairs)) continue;
      if (identifierIsImportOrReExportSpecifier(source, i, delimiterPairs)) continue;
      const previous = previousSignificant(source, i);
      if (previous?.ch === ".") continue;
      if (tokenIsObjectPropertyName(source, i, delimiterPairs)) continue;
      return true;
    }
  }
  return false;
}

function identifierIsLocalBindingOrBoundReference(source, index, name, delimiterPairs) {
  if (identifierIsFunctionParameterBinding(source, index, name, delimiterPairs)) return true;
  if (identifierIsBoundByFunctionParameter(source, index, name, delimiterPairs)) return true;
  if (identifierIsBoundByArrowParameter(source, index, name, delimiterPairs)) return true;
  if (identifierHasPriorImportBinding(source, index, name)) return true;
  if (identifierHasPriorLexicalBinding(source, index, name, delimiterPairs)) return true;
  const previous = previousSignificant(source, index);
  const previousToken = previous ? identifierEndingAt(source, previous.index) : "";
  return ["const", "let", "var", "function", "class"].includes(previousToken);
}

function sourceHasTopLevelLexicalBinding(source, name) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      braceDepth += 1;
      continue;
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      continue;
    }
    if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (braceDepth > 0 || bracketDepth > 0 || parenDepth > 0 || isIdentifierPartChar(source[i - 1])) continue;
    const keyword = identifierStartingAt(source, i);
    if (!["const", "let", "class"].includes(keyword)) continue;
    const previous = previousSignificant(source, i);
    if (previous?.ch === ".") continue;
    const next = nextSignificant(source, i + keyword.length);
    if (!next) continue;
    if (keyword === "class") {
      if (identifierStartingAt(source, next.index) === name) return true;
      continue;
    }
    const declarationEnd = topLevelLexicalDeclarationEnd(source, next.index);
    if (declarationListBindsIdentifier(source.slice(next.index, declarationEnd), name)) return true;
    i += keyword.length - 1;
  }
  return false;
}

function topLevelLexicalDeclarationEnd(source, start) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === ";" && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) return i;
  }
  return source.length;
}

function declarationListBindsIdentifier(source, name) {
  for (const segment of topLevelParameterSegments(source)) {
    const binding = segment.slice(0, topLevelAssignmentIndex(segment)).trimStart();
    if (binding.startsWith(name) && !isIdentifierPartChar(binding[name.length])) return true;
  }
  return false;
}

function topLevelAssignmentIndex(source) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "=" && source[i + 1] !== "=" && source[i + 1] !== ">" && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) return i;
  }
  return source.length;
}

function hasNodeMtsCommonJsModuleMember(source) {
  const delimiterPairs = buildDelimiterPairs(source);
  for (let i = source.indexOf("module"); i >= 0; i = source.indexOf("module", i + "module".length)) {
    if (isIdentifierPartChar(source[i - 1]) || isIdentifierPartChar(source[i + "module".length])) continue;
    if (identifierIsFunctionParameterBinding(source, i, "module", delimiterPairs)) continue;
    if (identifierIsBoundByFunctionParameter(source, i, "module", delimiterPairs)) continue;
    if (identifierIsBoundByArrowParameter(source, i, "module", delimiterPairs)) continue;
    if (identifierHasPriorLexicalBinding(source, i, "module", delimiterPairs)) continue;
    const previous = previousSignificant(source, i);
    if (previous?.ch === ".") continue;
    const previousToken = previous ? identifierEndingAt(source, previous.index) : "";
    if (["const", "let", "var", "function", "class"].includes(previousToken)) continue;
    const next = nextSignificant(source, i + "module".length);
    if (previousToken === "typeof" && !identifierIsDereferenced(source, next)) continue;
    if (tokenIsObjectPropertyName(source, i, delimiterPairs)) continue;
    if (next?.ch === "." || next?.ch === "[") return true;
    if (next?.ch === "?" && source[next.index + 1] === ".") return true;
  }
  return false;
}

function hasNodeMtsCommonJsExportsAssignment(source) {
  const delimiterPairs = buildDelimiterPairs(source);
  for (let i = source.indexOf("exports"); i >= 0; i = source.indexOf("exports", i + 1)) {
    if (isIdentifierPartChar(source[i - 1]) || isIdentifierPartChar(source[i + "exports".length])) continue;
    if (identifierIsFunctionParameterBinding(source, i, "exports", delimiterPairs)) continue;
    if (identifierIsBoundByFunctionParameter(source, i, "exports", delimiterPairs)) continue;
    if (identifierIsBoundByArrowParameter(source, i, "exports", delimiterPairs)) continue;
    if (identifierHasPriorLexicalBinding(source, i, "exports", delimiterPairs)) continue;
    const previous = previousSignificant(source, i);
    if (previous?.ch === ".") continue;
    const previousToken = previous ? identifierEndingAt(source, previous.index) : "";
    if (["const", "let", "var", "function", "class"].includes(previousToken)) continue;
    const next = nextSignificant(source, i + "exports".length);
    if (next?.ch === ":") continue;
    if (next?.ch === "." || next?.ch === "[") return true;
    if (next && isSingleAssignmentAt(source, next.index)) return true;
    if (identifierIsCommonJsExportsMutatorArgument(source, i)) return true;
  }
  return false;
}

function hasNodeMtsCommonJsGlobalRead(source) {
  const delimiterPairs = buildDelimiterPairs(source);
  for (const name of ["require", "module", "exports", "__dirname", "__filename"]) {
    for (let i = source.indexOf(name); i >= 0; i = source.indexOf(name, i + name.length)) {
      if (isIdentifierPartChar(source[i - 1]) || isIdentifierPartChar(source[i + name.length])) continue;
      if (identifierIsFunctionParameterBinding(source, i, name, delimiterPairs)) continue;
      if (identifierIsBoundByFunctionParameter(source, i, name, delimiterPairs)) continue;
      if (identifierIsBoundByArrowParameter(source, i, name, delimiterPairs)) continue;
      if (identifierHasPriorImportBinding(source, i, name)) continue;
      if (identifierHasPriorLexicalBinding(source, i, name, delimiterPairs)) continue;
      if (identifierIsImportOrReExportSpecifier(source, i, delimiterPairs)) continue;
      const previous = previousSignificant(source, i);
      if (previous?.ch === ".") continue;
      const previousToken = previous ? identifierEndingAt(source, previous.index) : "";
      const next = nextSignificant(source, i + name.length);
      if (["const", "let", "var", "function", "class"].includes(previousToken)) continue;
      if (previousToken === "typeof" && !identifierIsDereferenced(source, next)) continue;
      if (tokenIsObjectPropertyName(source, i, delimiterPairs)) continue;
      return true;
    }
  }
  return false;
}

function identifierIsDereferenced(source, next) {
  return next?.ch === "." || next?.ch === "[" || (next?.ch === "?" && source[next.index + 1] === ".");
}

function identifierIsImportOrReExportSpecifier(source, index, delimiterPairs) {
  const braceStart = enclosingDelimiterStart(source, index, "{", "}", delimiterPairs);
  const keyword = braceStart >= 0 ? importExportKeywordBefore(source, braceStart) : "";
  if (keyword === "import" || (keyword === "export" && exportSpecifierListHasFrom(source, braceStart, delimiterPairs))) {
    const previous = previousSignificant(source, index, braceStart);
    const previousToken = previous ? identifierEndingAt(source, previous.index) : "";
    const next = nextSignificant(source, index + identifierStartingAt(source, index).length);
    const nextToken = next ? identifierStartingAt(source, next.index) : "";
    return previous?.ch === "{" || previous?.ch === "," || previousToken === "as" ||
      next?.ch === "," || next?.ch === "}" || nextToken === "as";
  }
  const previous = previousSignificant(source, index);
  const previousToken = previous ? identifierEndingAt(source, previous.index) : "";
  if (previousToken === "import") return true;
  if (previousToken !== "as") return false;
  const beforeAs = previousSignificant(source, previous.index - "as".length + 1);
  return beforeAs?.ch === "*" && importExportKeywordBefore(source, beforeAs.index);
}

function importExportKeywordBefore(source, index) {
  let previous = previousSignificant(source, index);
  let keyword = previous ? identifierEndingAt(source, previous.index) : "";
  if (keyword === "type") {
    previous = previousSignificant(source, previous.index - keyword.length + 1);
    keyword = previous ? identifierEndingAt(source, previous.index) : "";
  }
  return keyword === "import" || keyword === "export" ? keyword : "";
}

function exportSpecifierListHasFrom(source, braceStart, delimiterPairs) {
  const braceEnd = findMatchingDelimiter(source, braceStart, "{", "}", delimiterPairs);
  if (braceEnd < 0) return false;
  const next = nextSignificant(source, braceEnd + 1);
  return next ? identifierStartingAt(source, next.index) === "from" : false;
}

function identifierHasPriorImportBinding(source, index, name) {
  const prefix = source.slice(0, index);
  for (const match of prefix.matchAll(/\bimport\s+(?!\()([\s\S]*?)\s+from\s*(["'`])/g)) {
    const clause = match[1].trim();
    if (clause.startsWith("type ")) continue;
    if (importClauseBindsIdentifier(clause, name)) return true;
  }
  return false;
}

function importClauseBindsIdentifier(clause, name) {
  const first = identifierStartingAt(clause, 0);
  if (first === name) return true;
  const comma = clause.indexOf(",");
  const rest = comma >= 0 ? clause.slice(comma + 1).trim() : clause;
  if (rest.startsWith("*") && new RegExp(String.raw`^\*\s+as\s+${identifierTokenSource(name)}$`, "u").test(rest)) return true;
  const braceStart = rest.indexOf("{");
  const braceEnd = rest.lastIndexOf("}");
  if (braceStart < 0 || braceEnd < braceStart) return false;
  return namedImportClauseBindsIdentifier(rest.slice(braceStart + 1, braceEnd), name);
}

function namedImportClauseBindsIdentifier(clause, name) {
  for (const rawPart of clause.split(",")) {
    const part = rawPart.trim().replace(/^type\s+/, "");
    if (!part) continue;
    const alias = part.match(/\bas\s+([A-Za-z_$][A-Za-z0-9_$]*)$/u);
    if (alias) {
      if (alias[1] === name) return true;
      continue;
    }
    if (identifierStartingAt(part, 0) === name) return true;
  }
  return false;
}

function identifierHasPriorLexicalBinding(source, index, name, delimiterPairs) {
  const blockStart = enclosingDelimiterStart(source, index, "{", "}", delimiterPairs);
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = blockStart >= 0 ? blockStart + 1 : 0; i < index; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      braceDepth += 1;
      continue;
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      continue;
    }
    if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (braceDepth > 0 || bracketDepth > 0 || parenDepth > 0 || isIdentifierPartChar(source[i - 1])) continue;
    const keyword = identifierStartingAt(source, i);
    if (!["const", "let", "var", "function", "class"].includes(keyword)) continue;
    const next = nextSignificant(source, i + keyword.length);
    if (next && identifierStartingAt(source, next.index) === name) return true;
    i += keyword.length - 1;
  }
  return false;
}

function identifierIsCommonJsExportsMutatorArgument(source, index) {
  const previous = previousSignificant(source, index);
  if (previous?.ch !== "(") return false;
  return /(?:^|[^A-Za-z0-9_$])Object\s*\.\s*(?:defineProperty|assign)$/.test(source.slice(0, previous.index).trimEnd());
}

function specifierUsesRuntimeResolution(artifactPath, specifier) {
  const imported = normalize(join(artifactPath, "..", specifier));
  return specifier.endsWith("/") || !hasSupportedImportExtension(imported);
}

function unsupportedRuntimeImportCandidates(artifactPath, specifier) {
  const imported = normalize(join(artifactPath, "..", specifier));
  const candidates = [];
  if (!specifier.endsWith("/") && !hasSupportedImportExtension(imported)) {
    candidates.push(...UNSUPPORTED_RUNTIME_IMPORT_EXTENSIONS.map((ext) => `${imported}${ext}`));
  }
  if (!hasSupportedImportExtension(imported)) {
    const indexBase = normalize(join(imported, "index"));
    candidates.push(...UNSUPPORTED_RUNTIME_IMPORT_EXTENSIONS.map((ext) => `${indexBase}${ext}`));
  }
  return candidates;
}

function directoryImportPackageJsonCandidate(artifactPath, specifier) {
  const imported = normalize(join(artifactPath, "..", specifier));
  return !hasSupportedImportExtension(imported) ? normalize(join(imported, "package.json")) : null;
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function packPackageType(root, artifactPath) {
  const packRoot = resolve(root);
  let dir = dirname(resolve(packRoot, artifactPath));
  while (true) {
    const candidate = join(dir, "package.json");
    if (await fileExists(candidate)) {
      const packageJson = await readJson(candidate);
      return {
        artifactPath: pathInside(packRoot, candidate) ? relative(packRoot, candidate) : null,
        type: typeof packageJson.type === "string" ? packageJson.type : null
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function nodeSidecarUsesPackageType(sidecarRuntimeName, artifact, isAdapterArtifact) {
  return sidecarRuntimeName === "node" && !isAdapterArtifact && /\.(js|ts)$/.test(artifact.path);
}

async function optionalRealpath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
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

function hasComputedObjectPattern(source, start = 0, end = source.length, inheritedPattern = false) {
  if (!source.includes("[") && !source.includes("constructor")) return false;
  const delimiterPairs = buildDelimiterPairs(source);
  const stack = [];
  for (let i = start; i < end; i += 1) {
    while (stack.length > 0 && i > stack[stack.length - 1].close) stack.pop();
    if (source[i] !== "{") continue;
    const close = findMatchingDelimiter(source, i, "{", "}", delimiterPairs);
    if (close < 0 || close > end) continue;
    const parentPattern = stack.length > 0 ? stack[stack.length - 1].objectPattern : inheritedPattern;
    const objectPattern = isObjectPatternContext(source, i, close, parentPattern, delimiterPairs);
    if (objectPattern && objectBodyHasComputedKey(source, i + 1, close, delimiterPairs)) return true;
    stack.push({ close, objectPattern });
  }
  return false;
}

function hasComputedMemberAccess(source, scanOptions = {}) {
  if (!source.includes("[")) return false;
  const delimiterPairs = buildDelimiterPairs(source);
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "[") continue;
    const previous = previousSignificant(source, i);
    if (!previous) continue;
    if (enclosingArrayPatternContext(source, i, false, delimiterPairs)) continue;
    if (previous.ch === "." && source[previous.index - 1] === "?") return true;
    if (previous.ch === ")" && isAfterControlStatementHead(source.slice(0, previous.index + 1))) continue;
    if ([")", "]", "}"].includes(previous.ch)) return true;
    if (literalReceiverBeforeComputedAccess(source, previous)) return true;
    const identifier = identifierEndingAt(source, previous.index);
    if (!identifier) continue;
    const start = previous.index - identifier.length + 1;
    if (ARRAY_LITERAL_PREFIX_KEYWORDS.has(identifier) && !identifierFollowsPropertyAccess(source, start)) continue;
    if (["await", "yield"].includes(identifier) && !identifierFollowsPropertyAccess(source, start) && contextualKeywordMayPrefixExpression(source, start, identifier, scanOptions)) continue;
    if (identifier === "of" && identifierLooksLikeForOfKeyword(source, start, delimiterPairs)) continue;
    return true;
  }
  return false;
}

function identifierFollowsPropertyAccess(source, start) {
  return previousSignificant(source, start)?.ch === ".";
}

function literalReceiverBeforeComputedAccess(source, previous) {
  if (previous.ch === "\"" || previous.ch === "'" || previous.ch === "`") return true;
  if (/[0-9]/.test(previous.ch)) return true;
  if (previous.ch === "n" && /[0-9]/.test(source[previous.index - 1] ?? "")) return true;
  return previous.ch === "/" && previousSignificant(source, previous.index)?.ch === "/";
}

function identifierLooksLikeForOfKeyword(source, start, delimiterPairs) {
  const parenStart = enclosingDelimiterStart(source, start, "(", ")", delimiterPairs);
  if (parenStart < 0) return false;
  const previous = previousSignificant(source, parenStart);
  const previousWord = identifierEndingAt(source, previous?.index ?? -1);
  if (!isForHeadPrefix(source, parenStart, previousWord)) return false;
  const headPrefix = source.slice(parenStart + 1, start);
  return !headPrefix.includes(";") && !hasTopLevelOfToken(headPrefix) && !hasTopLevelAssignmentToken(headPrefix);
}

function hasTopLevelOfToken(source) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      braceDepth += 1;
      continue;
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      continue;
    }
    if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (braceDepth > 0 || bracketDepth > 0 || parenDepth > 0) continue;
    if (source.slice(i, i + 2) !== "of") continue;
    if (isIdentifierPartChar(source[i - 1]) || isIdentifierPartChar(source[i + 2])) continue;
    return true;
  }
  return false;
}

function hasTopLevelAssignmentToken(source) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      braceDepth += 1;
      continue;
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      continue;
    }
    if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (braceDepth > 0 || bracketDepth > 0 || parenDepth > 0 || ch !== "=") continue;
    const previous = source[i - 1] ?? "";
    const next = source[i + 1] ?? "";
    if (next === ">" || next === "=" || ["=", "!", "<", ">"].includes(previous)) continue;
    return true;
  }
  return false;
}

function buildDelimiterPairs(source) {
  const stacks = new Map([
    ["{", []],
    ["[", []],
    ["(", []]
  ]);
  const closeToOpen = new Map([
    ["}", "{"],
    ["]", "["],
    [")", "("]
  ]);
  const pairs = new Map();
  const enclosingStarts = new Map([
    ["{", new Int32Array(source.length).fill(-1)],
    ["[", new Int32Array(source.length).fill(-1)],
    ["(", new Int32Array(source.length).fill(-1)]
  ]);
  for (let i = 0; i < source.length; i += 1) {
    for (const [open, starts] of enclosingStarts) {
      const stack = stacks.get(open) ?? [];
      starts[i] = stack.at(-1) ?? -1;
    }
    const openStack = stacks.get(source[i]);
    if (openStack) {
      openStack.push(i);
      continue;
    }
    const open = closeToOpen.get(source[i]);
    if (!open) continue;
    const start = stacks.get(open)?.pop();
    if (start !== undefined) pairs.set(start, i);
  }
  pairs.enclosingStarts = enclosingStarts;
  return pairs;
}

function objectBodyHasComputedKey(source, start, end, delimiterPairs) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = start; i < end;) {
    const ch = source[i];
    if (ch === "{") {
      braceDepth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      i += 1;
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      i += 1;
      continue;
    }
    if (ch === "[" && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      const previous = previousSignificant(source, i, start - 1);
      const close = findMatchingDelimiter(source, i, "[", "]", delimiterPairs);
      if (close < 0 || close > end) return false;
      const next = nextSignificant(source, close + 1, end);
      if ((previous?.ch === "{" || previous?.ch === ",") && next?.ch === ":") return true;
      i = close + 1;
      continue;
    }
    if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      const identifier = identifierStartingAt(source, i);
      if (identifier === "constructor") {
        const previous = previousSignificant(source, i, start - 1);
        const next = nextSignificant(source, i + identifier.length, end);
        if ((previous?.ch === "{" || previous?.ch === ",") && (!next || [":", ",", "="].includes(next.ch))) return true;
      }
      if (identifier) {
        i += identifier.length;
        continue;
      }
    }
    if (ch === "[") {
      bracketDepth += 1;
      i += 1;
      continue;
    }
    if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      i += 1;
      continue;
    }
    i += 1;
  }
  return false;
}

function isObjectPatternContext(source, start, end, inheritedPattern, delimiterPairs) {
  if (isSingleAssignmentAt(source, nextSignificant(source, end + 1)?.index ?? -1)) return true;
  const previous = previousSignificant(source, start);
  if (!previous) return false;
  if (previous.ch === "(") return enclosingParameterPatternContext(source, previous.index, end, delimiterPairs);
  if (previous.ch === "[") return enclosingArrayPatternContext(source, previous.index, inheritedPattern, delimiterPairs);
  if (previous.ch === "." && source.slice(previous.index - 2, previous.index + 1) === "...") return spreadPatternContext(source, previous.index, end, inheritedPattern, delimiterPairs);
  if (previous.ch === ",") return commaPatternContext(source, previous.index, end, inheritedPattern, delimiterPairs);
  if (inheritedPattern && (previous.ch === "{" || previous.ch === "," || (previous.ch === ":" && colonLooksLikePatternProperty(source, previous.index)))) return true;
  return ["const", "let", "var"].includes(identifierEndingAt(source, previous.index));
}

function enclosingParameterPatternContext(source, start, objectEnd, delimiterPairs) {
  const end = findMatchingDelimiter(source, start, "(", ")", delimiterPairs);
  if (end < 0) return false;
  const next = nextSignificant(source, end + 1);
  if (next && source.slice(next.index, next.index + 2) === "=>") return true;
  const previous = previousSignificant(source, start);
  const previousWord = previous ? identifierEndingAt(source, previous.index) : "";
  if (next?.ch === "{" && keywordNamedMethodContext(source, previous, previousWord, delimiterPairs)) return true;
  if (isForHeadPrefix(source, start, previousWord)) {
    if (["of", "in"].includes(identifierStartingAt(source, nextSignificant(source, objectEnd + 1)?.index ?? -1))) return true;
    return false;
  }
  if (previousWord === "catch") return true;
  if (["if", "while", "switch", "with"].includes(previousWord)) return false;
  if (next?.ch === "{" && isFunctionParameterPrefix(source, start)) return true;
  if (next?.ch === "{" && isExtendsExpressionContext(source, start)) return false;
  return next?.ch === "{";
}

function isForHeadPrefix(source, parenStart, previousWord) {
  return previousWord === "for" || (previousWord === "await" && /\bfor\s+await\s*$/.test(source.slice(0, parenStart)));
}

function isExtendsExpressionContext(source, parenStart) {
  const prefix = source.slice(0, parenStart);
  const extendsIndex = lastKeywordIndex(prefix, "extends");
  if (extendsIndex < 0) return false;
  return heritageExpressionContinues(source, extendsIndex + "extends".length, parenStart);
}

function heritageExpressionContinues(source, start, end) {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let i = start; i < end; i += 1) {
    const ch = source[i];
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "{" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      const bodyEnd = heritageExpressionBodyEnd(source, start, i);
      if (bodyEnd >= 0) {
        i = bodyEnd;
        continue;
      }
      return false;
    }
    else if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === ";" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return false;
  }
  return true;
}

function heritageExpressionBodyEnd(source, heritageStart, braceIndex) {
  if (!braceStartsFunctionExpressionBody(source, braceIndex) && !braceStartsClassExpressionBody(source, heritageStart, braceIndex)) return -1;
  return findMatchingDelimiter(source, braceIndex, "{", "}");
}

function braceStartsFunctionExpressionBody(source, braceIndex) {
  const previous = previousSignificant(source, braceIndex);
  if (previous?.ch !== ")") return false;
  const paramsStart = findOpeningDelimiter(source, previous.index, "(", ")");
  return paramsStart >= 0 && isFunctionParameterPrefix(source, paramsStart);
}

function braceStartsClassExpressionBody(source, heritageStart, braceIndex) {
  return lastKeywordIndex(source.slice(heritageStart, braceIndex), "class") >= 0;
}

function isFunctionParameterPrefix(source, parenStart) {
  const prefix = source.slice(0, parenStart).trimEnd();
  if (/\bfunction\s*\*?\s*$/.test(prefix)) return true;
  const name = identifierEndingAt(prefix, prefix.length - 1);
  if (!name) return false;
  return /\bfunction\s*\*?\s*$/.test(prefix.slice(0, -name.length).trimEnd());
}

function colonLooksLikePatternProperty(source, colonIndex) {
  for (let i = colonIndex - 1; i >= 0; i -= 1) {
    const ch = source[i];
    if (ch === "?") return false;
    if (ch === "=") return false;
    if (ch === "{" || ch === ",") return true;
    if (ch === ";" || ch === "(" || ch === "[") return false;
  }
  return false;
}

function keywordNamedMethodContext(source, previous, previousWord, delimiterPairs) {
  if (previous?.ch === "]") {
    const computedStart = enclosingDelimiterStart(source, previous.index, "[", "]", delimiterPairs);
    return computedStart >= 0 && methodBoundaryContext(source, computedStart);
  }
  if (!previousWord) return literalNamedMethodContext(source, previous);
  const wordStart = previous.index - previousWord.length + 1;
  if (previousWord === "n" && /[0-9]/.test(source[wordStart - 1] ?? "")) return literalNamedMethodContext(source, previous);
  const nameStart = source[wordStart - 1] === "#" ? wordStart - 1 : wordStart;
  return methodBoundaryContext(source, nameStart);
}

function literalNamedMethodContext(source, previous) {
  if (!previous) return false;
  if (previous.ch === "\"" || previous.ch === "'" || previous.ch === "`") {
    const literalStart = stringLiteralStart(source, previous.index);
    return literalStart >= 0 && methodBoundaryContext(source, literalStart);
  }
  if (!/[0-9]/.test(previous.ch) && !(previous.ch === "n" && /[0-9]/.test(source[previous.index - 1] ?? ""))) return false;
  let start = previous.index;
  while (start > 0 && /[0-9A-Za-z_$._]/.test(source[start - 1])) start -= 1;
  return methodBoundaryContext(source, start);
}

function stringLiteralStart(source, end) {
  const quote = source[end];
  for (let i = end - 1; i >= 0; i -= 1) {
    if (source[i] !== quote) continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && source[j] === "\\"; j -= 1) slashes += 1;
    if (slashes % 2 === 0) return i;
  }
  return -1;
}

function methodBoundaryContext(source, nameStart) {
  let beforeName = previousSignificant(source, nameStart);
  for (;;) {
    if (beforeName?.ch === "*") {
      beforeName = previousSignificant(source, beforeName.index);
      continue;
    }
    const modifier = beforeName ? identifierEndingAt(source, beforeName.index) : "";
    if (!["async", "get", "set", "static"].includes(modifier)) break;
    beforeName = previousSignificant(source, beforeName.index - modifier.length + 1);
  }
  if (beforeName?.ch === ",") return true;
  if (beforeName?.ch !== "{") return false;
  const beforeBrace = previousSignificant(source, beforeName.index);
  if (!beforeBrace) return false;
  if (beforeBrace.ch === ")") return braceStartsClassBody(source, beforeName.index);
  return beforeBrace.ch === "=" || beforeBrace.ch === "(" || beforeBrace.ch === "[" || beforeBrace.ch === ":" || /[A-Za-z_$\]]/.test(beforeBrace.ch);
}

function braceStartsClassBody(source, braceIndex) {
  const prefix = source.slice(0, braceIndex);
  const classIndex = lastKeywordIndex(prefix, "class");
  if (classIndex < 0) return false;
  const boundary = Math.max(prefix.lastIndexOf(";"), prefix.lastIndexOf("{"), prefix.lastIndexOf("}"));
  return classIndex > boundary;
}

function lastKeywordIndex(source, keyword) {
  let result = -1;
  for (let index = source.indexOf(keyword); index >= 0; index = source.indexOf(keyword, index + 1)) {
    if (!isIdentifierPartChar(source[index - 1]) && !isIdentifierPartChar(source[index + keyword.length])) result = index;
  }
  return result;
}

function enclosingArrayPatternContext(source, start, inheritedPattern, delimiterPairs) {
  const end = findMatchingDelimiter(source, start, "[", "]", delimiterPairs);
  if (end < 0) return false;
  if (isSingleAssignmentAt(source, nextSignificant(source, end + 1)?.index ?? -1)) return true;
  const previous = previousSignificant(source, start);
  const previousWord = previous ? identifierEndingAt(source, previous.index) : "";
  if (["const", "let", "var"].includes(previousWord)) return true;
  if (previous?.ch === "(" && enclosingParameterPatternContext(source, previous.index, end, delimiterPairs)) return true;
  if (previous?.ch === "[" && enclosingArrayPatternContext(source, previous.index, inheritedPattern, delimiterPairs)) return true;
  if (previous?.ch === "." && source.slice(previous.index - 2, previous.index + 1) === "...") return spreadPatternContext(source, previous.index, end, inheritedPattern, delimiterPairs);
  if (previous?.ch === ",") return commaPatternContext(source, previous.index, end, inheritedPattern, delimiterPairs);
  if (!inheritedPattern) return false;
  return previous?.ch === "{" || previous?.ch === "," || (previous?.ch === ":" && colonLooksLikePatternProperty(source, previous.index));
}

function spreadPatternContext(source, spreadEnd, patternEnd, inheritedPattern, delimiterPairs) {
  const previous = previousSignificant(source, spreadEnd - 2);
  if (previous?.ch === "[") return enclosingArrayPatternContext(source, previous.index, inheritedPattern, delimiterPairs);
  if (previous?.ch === "(") return enclosingParameterPatternContext(source, previous.index, patternEnd, delimiterPairs);
  if (previous?.ch === ",") return commaPatternContext(source, previous.index, patternEnd, inheritedPattern, delimiterPairs);
  if (!inheritedPattern) return false;
  return previous?.ch === "{" || previous?.ch === "," || (previous?.ch === ":" && colonLooksLikePatternProperty(source, previous.index));
}

function commaPatternContext(source, commaIndex, objectEnd, inheritedPattern, delimiterPairs) {
  const arrayStart = enclosingDelimiterStart(source, commaIndex, "[", "]", delimiterPairs);
  const parenStart = enclosingDelimiterStart(source, commaIndex, "(", ")", delimiterPairs);
  if (parenStart > arrayStart) return enclosingParameterPatternContext(source, parenStart, objectEnd, delimiterPairs);
  if (arrayStart >= 0) return enclosingArrayPatternContext(source, arrayStart, inheritedPattern, delimiterPairs);
  if (parenStart >= 0) return enclosingParameterPatternContext(source, parenStart, objectEnd, delimiterPairs);
  return false;
}

function enclosingDelimiterStart(source, index, open, close, delimiterPairs) {
  const start = delimiterPairs?.enclosingStarts?.get(open)?.[index] ?? -1;
  if (start >= 0) {
    const end = findMatchingDelimiter(source, start, open, close, delimiterPairs);
    if (end >= index) return start;
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    if (source[i] !== open) continue;
    const end = findMatchingDelimiter(source, i, open, close, delimiterPairs);
    if (end >= index) return i;
  }
  return -1;
}

function isSingleAssignmentAt(source, index) {
  return source[index] === "=" && source[index + 1] !== "=" && source[index + 1] !== ">";
}

function findMatchingDelimiter(source, start, open, close, delimiterPairs) {
  const paired = delimiterPairs?.get(start);
  if (paired !== undefined && source[start] === open && source[paired] === close) return paired;
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === open) {
      depth += 1;
      continue;
    }
    if (source[i] !== close) continue;
    depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

function findOpeningDelimiter(source, end, open, close) {
  let depth = 0;
  for (let i = end; i >= 0; i -= 1) {
    if (source[i] === close) {
      depth += 1;
      continue;
    }
    if (source[i] !== open) continue;
    depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

function previousSignificant(source, start, min = 0) {
  for (let i = start - 1; i >= min; i -= 1) {
    if (!/\s/.test(source[i])) return { ch: source[i], index: i };
  }
  return null;
}

function nextSignificant(source, start, max = source.length) {
  for (let i = start; i < max; i += 1) {
    if (!/\s/.test(source[i])) return { ch: source[i], index: i };
  }
  return null;
}

function identifierEndingAt(source, end) {
  if (!isIdentifierPartChar(source[end])) return "";
  let start = end;
  while (start > 0 && isIdentifierPartChar(source[start - 1])) start -= 1;
  if (!isIdentifierStartChar(source[start])) return "";
  return source.slice(start, end + 1);
}

function identifierStartingAt(source, start) {
  if (!isIdentifierStartChar(source[start])) return "";
  let end = start + 1;
  while (end < source.length && isIdentifierPartChar(source[end])) end += 1;
  return source.slice(start, end);
}

export async function verifySelfContained(pack) {
  const covered = new Set(pack.manifest.artifacts.map((artifact) => artifact.path));
  const allowedBuiltins = new Set(pack.manifest.metadata?.allowedBuiltins ?? []);
  const sidecarEntry = sidecarEntrypoint(pack);
  const sidecarRuntimeName = sidecarRuntime(pack);
  const root = resolve(pack.dir);
  const adapterReal = await optionalRealpath(resolve(root, "adapter.mjs"));
  const sidecarEntryPath = sidecarEntry && pack.manifest.artifacts.some((artifact) => artifact.path === sidecarEntry)
    ? await resolvePackPath(pack, sidecarEntry)
    : null;
  const sidecarEntryReal = sidecarEntryPath ? await realpath(sidecarEntryPath) : null;
  const bunModuleArtifacts = sidecarRuntimeName === "node" ? new Set() : await bunStaticModuleArtifacts(pack, covered);
  for (const artifact of pack.manifest.artifacts) {
    const full = await resolvePackPath(pack, artifact.path);
    if (!isScannableArtifact(artifact.path)) continue;
    assert(!(await lstat(full)).isSymbolicLink(), `${pack.name}: symlinked executable artifact rejected in ${artifact.path}`);
    const artifactReal = await realpath(full);
    const isAdapterArtifact = adapterReal !== null && artifactReal === adapterReal;
    const source = await readFile(full, "utf8");
    const packageTypeInput = nodeSidecarUsesPackageType(sidecarRuntimeName, artifact, isAdapterArtifact)
      ? await packPackageType(root, artifact.path)
      : null;
    assert(!packageTypeInput || (packageTypeInput.artifactPath && covered.has(packageTypeInput.artifactPath)), `${pack.name}: Node sidecar package.json not checksum-covered for ${artifact.path}`);
    const packageType = packageTypeInput?.type ?? null;
    const moduleSyntaxSource = executableCodeSource(loaderScanSource(source, artifact.path));
    const nodeModuleKind = nodeSidecarModuleKind(sidecarRuntimeName, artifact, isAdapterArtifact, packageType, source, moduleSyntaxSource);
    const scanOptions = { allowTopLevelAwait: artifactAllowsTopLevelAwait(artifact.path, nodeModuleKind, moduleSyntaxSource, sidecarRuntimeName, isAdapterArtifact, bunModuleArtifacts.has(artifact.path)) };
    const moduleScanSource = scanOptions.allowTopLevelAwait
      ? executableCodeSource(loaderScanSource(source, artifact.path), scanOptions)
      : moduleSyntaxSource;
    assert(!nodeSidecarUsesUnsupportedRuntimeArtifact(sidecarRuntimeName, artifact, isAdapterArtifact), `${pack.name}: Node sidecar unsupported runtime artifact rejected in ${artifact.path}`);
    const typeScriptSyntaxSource = nodeSidecarRequiresStripOnlyTypeScript(sidecarRuntimeName, artifact, isAdapterArtifact)
      ? nodeStripOnlyTypeScriptSyntaxSource(source, scanOptions)
      : null;
    if (typeScriptSyntaxSource) {
      for (const pattern of NODE_UNSUPPORTED_TYPESCRIPT_SYNTAX) {
        assert(!pattern.test(typeScriptSyntaxSource), `${pack.name}: Node sidecar unsupported TypeScript syntax rejected in ${artifact.path}`);
      }
    }
    if (nodeSidecarRequiresModuleSyntaxChecks(sidecarRuntimeName, artifact, isAdapterArtifact)) {
      const nodeModuleSyntaxSource = typeScriptSyntaxSource && nodeModuleKind === "cjs"
        ? typeScriptSyntaxSource
        : PLAIN_JAVASCRIPT_ARTIFACT.test(artifact.path)
          ? executableCodeSource(stripShebang(source), scanOptions)
          : moduleScanSource;
      const nodeCommonJsGlobalSyntaxSource = typeScriptSyntaxSource ?? executableCodeSource(stripShebang(source), scanOptions);
      for (const check of nodeUnsupportedTypeScriptModuleSyntax(nodeModuleKind)) {
        assert(!sourceCheckMatches(check, nodeModuleSyntaxSource), `${pack.name}: Node sidecar unsupported module syntax rejected in ${artifact.path}`);
      }
      assert(nodeModuleKind !== "esm" || !hasNodeMtsCommonJsExportsAssignment(nodeModuleSyntaxSource), `${pack.name}: Node sidecar unsupported module syntax rejected in ${artifact.path}`);
      assert(nodeModuleKind !== "esm" || !hasNodeMtsCommonJsGlobalRead(nodeCommonJsGlobalSyntaxSource), `${pack.name}: Node sidecar unsupported module syntax rejected in ${artifact.path}`);
      assert(nodeModuleKind !== "esm" || !nodeEsmHasTopLevelReturn(nodeModuleSyntaxSource), `${pack.name}: Node sidecar unsupported module syntax rejected in ${artifact.path}`);
      assert(nodeModuleKind !== "cjs" || nodeCommonJsSyntaxParses(source, artifact.path), `${pack.name}: Node sidecar unsupported module syntax rejected in ${artifact.path}`);
    }
    const scanInputs = loaderScanInputs(source, artifact.path, scanOptions);
    const importEntries = [
      ...scanImportEntries(source, artifact.path),
      ...scanInputs.flatMap(({ loaderSource }) => scanImportEntries(loaderSource, artifact.path)),
      ...nodeTypeScriptRuntimeTypeImportEntries(source, artifact.path, sidecarRuntimeName, isAdapterArtifact, nodeModuleKind)
    ];
    const specifiers = [...new Set(importEntries
      .map((entry) => entry.path)
      .filter((path) => typeof path === "string" && path.length > 0))];
    assert(!importEntries.some((entry) => entry.kind === "dynamic-import"), `${pack.name}: dynamic import rejected in ${artifact.path}`);
    assert(
      !(nodeModuleKind === "esm" || (sidecarRuntimeName === "deno" && !isAdapterArtifact)) || !hasJsonStaticImport(importEntries),
      `${pack.name}: sidecar JSON import requires verifiable import attributes in ${artifact.path}`
    );
    if (artifactUsesCommonJsWrapper(artifact.path, nodeModuleKind)) {
      assert(!commonJsWrapperArgumentsAccessed(commonJsWrapperArgumentScanSource(source, artifact.path)), `${pack.name}: CommonJS wrapper arguments rejected in ${artifact.path}`);
    }
    for (const { loaderSource, codeSource } of scanInputs) {
      if (UNSAFE_LOADER_HINT.test(codeSource)) {
        const codeDelimiterPairs = buildDelimiterPairs(codeSource);
        assert(!sourceMatchesOutsideObjectPropertyName(codeSource, DYNAMIC_IMPORT, codeDelimiterPairs), `${pack.name}: dynamic import rejected in ${artifact.path}`);
        for (const pattern of DYNAMIC_LOADER_IDENTIFIERS) {
          assert(!sourceMatchesOutsideObjectPropertyName(codeSource, pattern, codeDelimiterPairs), `${pack.name}: unsafe loader rejected in ${artifact.path}`);
        }
        for (const pattern of EVAL_PATTERNS) {
          assert(!sourceMatchesOutsideObjectPropertyName(codeSource, pattern, codeDelimiterPairs), `${pack.name}: unsafe loader rejected in ${artifact.path}`);
        }
        assert(!hasComputedMemberAccess(codeSource, scanOptions) && !hasComputedObjectPattern(codeSource), `${pack.name}: computed member access rejected in ${artifact.path}`);
      }
      if (loaderSource.includes("require")) {
        const requireScanSource = withoutStringLiterals(stripScannedRequireCalls(loaderSource, importEntries), true, scanOptions);
        assert(!hasUnboundCommonJsRequireReference(requireScanSource), `${pack.name}: dynamic require rejected in ${artifact.path}`);
      }
    }
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:")) {
        assert(!FORBIDDEN_LOADER_BUILTINS.has(specifier), `${pack.name}: loader builtin ${specifier} rejected`);
        assert(allowedBuiltins.has(specifier), `${pack.name}: unchecked builtin ${specifier}`);
        assert(!FORBIDDEN_EXECUTION_BUILTINS.has(specifier), `${pack.name}: code execution builtin ${specifier} rejected`);
        continue;
      }
      assert(specifier.startsWith("./") || specifier.startsWith("../"), `${pack.name}: package import ${specifier} rejected`);
      assert(!specifier.includes("\\"), `${pack.name}: backslash local import ${specifier} rejected`);
      assert(!hasUrlSuffix(specifier), `${pack.name}: URL-suffixed local import ${specifier} rejected`);
      assert(!hasEncodedDotSegment(specifier), `${pack.name}: encoded dot segment import ${specifier} rejected`);
      assert(!hasPercentEncodedOctet(specifier), `${pack.name}: percent-encoded local import ${specifier} rejected`);
      assert(
        !sidecarArtifactRequiresExplicitLocalSpecifiers(sidecarRuntimeName, isAdapterArtifact) ||
          !specifierUsesRuntimeResolution(artifact.path, specifier),
        `${pack.name}: non-Bun sidecar extensionless local import ${specifier} rejected`
      );
      const directCandidates = localImportDirectCandidates(pack, artifact.path, specifier)
        .map((candidate) => {
          const resolved = resolve(root, candidate);
          return { resolved, artifactPath: relative(root, resolved) };
        });
      for (const candidate of directCandidates) {
        assert(pathInside(root, candidate.resolved), `${pack.name}: host path import ${specifier}`);
      }
      const importedDirect = normalize(join(artifact.path, "..", specifier));
      if (!specifier.endsWith("/") && hasUnsupportedExactImportExtension(importedDirect)) {
        const resolved = resolve(root, importedDirect);
        assert(pathInside(root, resolved), `${pack.name}: host path import ${specifier}`);
        assert(!await fileExists(resolved), `${pack.name}: local import ${specifier} uses unsupported extension`);
      }
      for (const candidate of unsupportedRuntimeImportCandidates(artifact.path, specifier)) {
        const resolved = resolve(root, candidate);
        assert(pathInside(root, resolved), `${pack.name}: host path import ${specifier}`);
        assert(!await fileExists(resolved), `${pack.name}: local import ${specifier} uses unsupported runtime extension`);
      }
      const packageJsonCandidate = directoryImportPackageJsonCandidate(artifact.path, specifier);
      if (packageJsonCandidate) {
        const resolved = resolve(root, packageJsonCandidate);
        assert(pathInside(root, resolved), `${pack.name}: host path import ${specifier}`);
        assert(!await fileExists(resolved), `${pack.name}: package-backed directory import ${specifier} rejected`);
      }
      const candidates = localImportCandidates(pack, artifact.path, specifier)
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
      if (sidecarEntryPath && !(await sameFilePathIdentity(full, sidecarEntryPath))) {
        for (const candidate of existingCandidates) {
          assert(
            await realpath(candidate.resolved) !== sidecarEntryReal &&
              !(await sameFilePathIdentity(candidate.resolved, sidecarEntryPath)),
            `${pack.name}: sidecar entrypoint import rejected in ${artifact.path}`
          );
        }
      }
      if (sidecarRuntimeDisallowsAdapterImport(sidecarRuntimeName, isAdapterArtifact, adapterReal)) {
        for (const candidate of existingCandidates) {
          assert(
            await realpath(candidate.resolved) !== adapterReal &&
              !(await sameFilePathIdentity(candidate.resolved, resolve(root, "adapter.mjs"))),
            `${pack.name}: sidecar adapter import rejected in ${artifact.path}`
          );
        }
      }
      const coverageCandidates = existingCandidates.length > 0 ? existingCandidates : candidates;
      assert(coverageCandidates.every((candidate) => covered.has(candidate.artifactPath)), `${pack.name}: local import ${specifier} not checksum-covered`);
    }
    const allowSidecarIo = artifact.role === "sidecar" && artifact.path === sidecarEntry && (!adapterReal || sidecarEntryReal !== adapterReal);
    const allowSidecarProcessIo = allowSidecarIo && ["node", "bun"].includes(sidecarRuntimeName);
    const allowSidecarBunIo = allowSidecarIo && sidecarRuntimeName === "bun";
    const allowSidecarDenoIo = allowSidecarIo && sidecarRuntimeName === "deno";
    const allowNetworkGlobals = pack.manifest.authorityLabels?.includes("network.http") === true;
    for (const { codeSource } of scanInputs) {
      if (codeSource.includes("module")) {
        assert(!COMMONJS_MODULE_LOADER.test(codeSource), `${pack.name}: CommonJS module loader rejected in ${artifact.path}`);
      }
      if (HOST_GLOBAL_HINT.test(codeSource)) {
        assert(!sourceMatchesOutsideObjectPropertyName(withoutAllowedProcessAccess(codeSource, allowSidecarProcessIo), PROCESS_ACCESS), `${pack.name}: process access rejected in ${artifact.path}`);
        assert(!sourceMatchesOutsideObjectPropertyName(withoutAllowedBunAccess(codeSource, allowSidecarBunIo), BUN_ACCESS), `${pack.name}: Bun access rejected in ${artifact.path}`);
        assert(!sourceMatchesOutsideObjectPropertyName(withoutAllowedDenoAccess(codeSource, allowSidecarDenoIo), DENO_ACCESS), `${pack.name}: Deno access rejected in ${artifact.path}`);
        assert(allowNetworkGlobals || !hasUnboundNetworkGlobalReference(codeSource), `${pack.name}: network global access rejected in ${artifact.path}`);
      }
    }
  }
  validateSidecarCommand(pack);
}

async function sameFilePathIdentity(left, right) {
  const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

export function validateSidecarCommand(pack) {
  const sidecar = pack.manifest.metadata?.sidecar;
  if (!sidecar) return;
  const command = sidecar.command ?? [];
  assert(Array.isArray(command) && command.length >= 2, `${pack.name}: sidecar command required`);
  assert(command.every((part) => typeof part === "string"), `${pack.name}: sidecar command must contain strings`);
  const [runtime, ...args] = command;
  assert(["node", "bun", "deno"].includes(runtime), `${pack.name}: sidecar bare executable rejected`);
  assert(runtime !== "deno" || args[0] === "run", `${pack.name}: deno run subcommand required`);
  assert(!command.some((part) => /^https?:\/\//.test(part)), `${pack.name}: remote sidecar entrypoint rejected`);
  assert(!["bunx", "npx"].includes(runtime), `${pack.name}: package runner rejected`);
  assert(!(runtime === "bun" && args[0] === "x"), `${pack.name}: bun package runner rejected`);
  assert(!(runtime === "npm" && args[0] === "exec"), `${pack.name}: npm exec package runner rejected`);
  assert(!(runtime === "node" && args[0] === "--run"), `${pack.name}: node --run package runner rejected`);
  const runtimeSelectionArgs = sidecarRuntimeArgsThroughEntrypoint(command);
  assert(!runtimeSelectionArgs.some((arg) => ["-e", "--eval", "eval"].includes(arg)), `${pack.name}: eval flag rejected`);
  assert(!runtimeSelectionArgs.some(isPreloadFlag), `${pack.name}: preload flag rejected`);
  const entry = sidecarEntrypoint(pack);
  assert(entry, `${pack.name}: sidecar entrypoint missing`);
  assert(!(runtime === "node" && NODE_UNSUPPORTED_RUNTIME_ARTIFACT.test(entry)), `${pack.name}: Node sidecar unsupported runtime entrypoint rejected`);
  assert(pack.manifest.artifacts.some((artifact) => artifact.path === entry), `${pack.name}: sidecar entrypoint not artifact-bound`);
  assert(!sidecarEntrypointAliasesAdapter(pack, entry), `${pack.name}: sidecar adapter entrypoint rejected`);
  assert(sidecar.stdoutBytes <= 8192, `${pack.name}: stdout bound too high`);
  assert(sidecar.stderrBytes <= 8192, `${pack.name}: stderr bound too high`);
  assert(sidecar.timeoutMs > 0 && sidecar.timeoutMs <= 5000, `${pack.name}: timeout bound missing`);
}

function sidecarEntrypointAliasesAdapter(pack, entry) {
  const root = resolve(pack.dir);
  const adapterPath = resolve(root, "adapter.mjs");
  const entryPath = resolve(root, entry);
  if (!pathInside(root, entryPath)) return false;
  try {
    const entryStat = statSync(entryPath);
    const adapterStat = statSync(adapterPath);
    return realpathSync(entryPath) === realpathSync(adapterPath) ||
      (entryStat.dev === adapterStat.dev && entryStat.ino === adapterStat.ino);
  } catch {
    return normalize(entry) === "adapter.mjs";
  }
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
