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
const DYNAMIC_LOADER_IDENTIFIERS = [
  /\beval\b/,
  /\bFunction\b/
];
const EVAL_PATTERNS = [
  /(?:\.|\?\.)\s*constructor\b/,
  /\[\s*["']constructor["']\s*\]/,
  /\[\s*["'][^"']*["']\s*\+/,
  /\+\s*["'][^"']*["']\s*\]/,
  /\bObject\s*(?:\.|\?\.)\s*getOwnPropertyDescriptor\b/,
  /\bObject\s*(?:\.|\?\.)\s*getPrototypeOf\b/,
  /\bReflect\s*(?:\.|\[)/,
  /\bglobalThis\s*(?:\.|\[)/,
  /\bglobal\s*(?:\.|\[)/,
  /\bself\s*(?:\.|\[)/,
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
const COMPUTED_MEMBER_ACCESS = /(?:\?\.\s*\[|(?:[#A-Za-z_$\u0080-\uFFFF][\w$#\u0080-\uFFFF]*|\)|\]|\})\s*\[)/;
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

function isScannableArtifact(artifactPath) {
  const basename = artifactPath.split(/[\\/]/).pop() ?? artifactPath;
  return EXECUTABLE_ARTIFACT.test(artifactPath) || !basename.includes(".");
}

function hasExplicitExtension(artifactPath) {
  return (artifactPath.split(/[\\/]/).pop() ?? artifactPath).includes(".");
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

function withoutStringLiterals(source, stripRegex = true) {
  let result = "";
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (ch === "\"" || ch === "'") {
      i = skipQuoted(source, i, ch);
      result += "\"\"";
      continue;
    }
    if (ch === "`") {
      const stripped = stripTemplateLiteral(source, i, stripRegex);
      result += stripped.text;
      i = stripped.end;
      continue;
    }
    if (stripRegex && ch === "/" && isRegexLiteralStart(result)) {
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

function stripTemplateLiteral(source, start, stripRegex = true) {
  let result = "`";
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "`") return { text: `${result}\``, end: i + 1 };
    if (source[i] === "$" && source[i + 1] === "{") {
      const expression = readTemplateExpression(source, i + 2);
      result += `\${${withoutStringLiterals(expression.text, stripRegex)}}`;
      i = expression.end;
      continue;
    }
    i += 1;
  }
  return { text: result, end: i };
}

function readTemplateExpression(source, start) {
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
    if (ch === "/" && isRegexLiteralStart(prefix)) {
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

function isRegexLiteralStart(result) {
  const trimmed = result.trimEnd();
  if (!trimmed) return true;
  if (/\+\+$|--$/.test(trimmed)) return false;
  if (/[\(\{\[=,:;!&|?+\-*~^<>%]$/.test(trimmed)) return true;
  if (/=>\s*$/.test(trimmed)) return true;
  if (isAfterControlStatementHead(trimmed)) return true;
  const token = trimmed.match(/([A-Za-z_$#][\w$#]*)\s*$/);
  if (!token || !["return", "throw", "case", "delete", "void", "typeof", "yield", "await", "instanceof", "in", "of", "do", "else", "extends", "new"].includes(token[1])) return false;
  const tokenStart = token.index ?? 0;
  if (tokenStart > 0 && isIdentifierPartChar(trimmed[tokenStart - 1])) return false;
  const beforeKeyword = trimmed.slice(0, tokenStart).trimEnd();
  if (beforeKeyword.endsWith(".")) return false;
  return token[1] !== "of" || isForOfOperatorPrefix(beforeKeyword);
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
    if (!token || !["if", "while", "for", "with"].includes(token[1])) return false;
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

function isPreloadFlag(arg) {
  if (typeof arg !== "string") return false;
  return arg === "-r" || /^-r\S+/.test(arg) || PRELOAD_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
}

function isSidecarOptionArg(arg) {
  return typeof arg === "string" && arg.startsWith("-");
}

function sidecarEntrypoint(pack) {
  const command = pack.manifest.metadata?.sidecar?.command;
  if (!Array.isArray(command)) return null;
  assert(!command.some(isPreloadFlag), `${pack.name}: preload flag rejected`);
  const [runtime, ...args] = command;
  assert(!args.some(isSidecarOptionArg), `${pack.name}: sidecar option argument rejected`);
  const entry = runtime === "deno" && args[0] === "run" ? args[1] : args[0];
  return isLocalSidecarEntrypoint(entry) ? entry : null;
}

function isLocalSidecarEntrypoint(entry) {
  return typeof entry === "string" &&
    EXECUTABLE_ARTIFACT.test(entry) &&
    !isAbsolute(entry) &&
    !entry.includes("://") &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(entry);
}

function sidecarRuntime(pack) {
  const command = pack.manifest.metadata?.sidecar?.command;
  return Array.isArray(command) ? command[0] : null;
}

function executableExtension(artifactPath) {
  const match = artifactPath.match(/\.(mjs|js|cjs|ts|tsx)$/);
  return match?.[0] ?? ".mjs";
}

function localImportCandidates(pack, artifactPath, specifier) {
  const imported = normalize(join(artifactPath, "..", specifier));
  const importBase = specifier.endsWith("/") ? normalize(join(imported, "index")) : imported;
  assert(!hasExplicitExtension(importBase) || EXECUTABLE_ARTIFACT.test(importBase) || importBase.endsWith(".json"), `${pack.name}: local import ${specifier} uses unsupported extension`);
  if (EXECUTABLE_ARTIFACT.test(importBase) || importBase.endsWith(".json")) return [importBase];
  const preferred = executableExtension(artifactPath);
  const extensions = [preferred, ...LOCAL_IMPORT_EXTENSIONS.filter((ext) => ext !== preferred)];
  return [importBase, ...extensions.map((ext) => `${importBase}${ext}`)];
}

function directoryImportPackageJsonCandidate(artifactPath, specifier) {
  return specifier.endsWith("/") ? normalize(join(artifactPath, "..", specifier, "package.json")) : null;
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

function hasComputedObjectPattern(source, start = 0, end = source.length, inheritedPattern = false) {
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
  for (const artifact of pack.manifest.artifacts) {
    const full = await resolvePackPath(pack, artifact.path);
    if (!isScannableArtifact(artifact.path)) continue;
    const source = await readFile(full, "utf8");
    const loaderSource = loaderScanSource(source, artifact.path);
    const codeSource = withoutStringLiterals(loaderSource);
    const importEntries = scanImportEntries(source, artifact.path);
    const specifiers = [...new Set(importEntries
      .map((entry) => entry.path)
      .filter((path) => typeof path === "string" && path.length > 0))];
    assert(!importEntries.some((entry) => entry.kind === "dynamic-import"), `${pack.name}: dynamic import rejected in ${artifact.path}`);
    assert(!DYNAMIC_IMPORT.test(loaderSource), `${pack.name}: dynamic import rejected in ${artifact.path}`);
    for (const pattern of DYNAMIC_LOADER_IDENTIFIERS) {
      assert(!pattern.test(codeSource), `${pack.name}: unsafe loader rejected in ${artifact.path}`);
    }
    for (const pattern of EVAL_PATTERNS) {
      assert(!pattern.test(codeSource), `${pack.name}: unsafe loader rejected in ${artifact.path}`);
    }
    assert(!ANY_COMMONJS_REQUIRE.test(withoutStringLiterals(stripScannedRequireCalls(loaderSource, importEntries))), `${pack.name}: dynamic require rejected in ${artifact.path}`);
    assert(!COMPUTED_MEMBER_ACCESS.test(codeSource) && !hasComputedObjectPattern(codeSource), `${pack.name}: computed member access rejected in ${artifact.path}`);
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:")) {
        assert(!FORBIDDEN_LOADER_BUILTINS.has(specifier), `${pack.name}: loader builtin ${specifier} rejected`);
        assert(allowedBuiltins.has(specifier), `${pack.name}: unchecked builtin ${specifier}`);
        assert(!FORBIDDEN_EXECUTION_BUILTINS.has(specifier), `${pack.name}: code execution builtin ${specifier} rejected`);
        continue;
      }
      assert(specifier.startsWith("./") || specifier.startsWith("../"), `${pack.name}: package import ${specifier} rejected`);
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
      const coverageCandidates = existingCandidates.length > 0 ? existingCandidates : candidates;
      assert(coverageCandidates.every((candidate) => covered.has(candidate.artifactPath)), `${pack.name}: local import ${specifier} not checksum-covered`);
    }
    const allowSidecarIo = artifact.role === "sidecar" && artifact.path === sidecarEntry;
    const allowSidecarProcessIo = allowSidecarIo && ["node", "bun"].includes(sidecarRuntimeName);
    const allowSidecarBunIo = allowSidecarIo && sidecarRuntimeName === "bun";
    const allowSidecarDenoIo = allowSidecarIo && sidecarRuntimeName === "deno";
    assert(!COMMONJS_MODULE_LOADER.test(codeSource), `${pack.name}: CommonJS module loader rejected in ${artifact.path}`);
    assert(!PROCESS_ACCESS.test(withoutAllowedProcessAccess(codeSource, allowSidecarProcessIo)), `${pack.name}: process access rejected in ${artifact.path}`);
    assert(!BUN_ACCESS.test(withoutAllowedBunAccess(codeSource, allowSidecarBunIo)), `${pack.name}: Bun access rejected in ${artifact.path}`);
    assert(!DENO_ACCESS.test(withoutAllowedDenoAccess(codeSource, allowSidecarDenoIo)), `${pack.name}: Deno access rejected in ${artifact.path}`);
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
