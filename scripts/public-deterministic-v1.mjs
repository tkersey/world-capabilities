import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const PUBLIC_DETERMINISTIC_VERSION = "2.1.2";
export const PUBLIC_DETERMINISTIC_ROOT = `world-capabilities-v${PUBLIC_DETERMINISTIC_VERSION}-deterministic`;
export const PUBLIC_DETERMINISTIC_ARCHIVE = `${PUBLIC_DETERMINISTIC_ROOT}.tar.gz`;
export const MAXIMUM_ARCHIVE_BYTES = 32 << 20;
export const MAXIMUM_EXPANDED_BYTES = 128 << 20;
export const MAXIMUM_ENTRY_COUNT = 2048;

const SOURCE_TREES = Object.freeze(["corpus", "harness", "packages", "src/v1", "test"]);
const SOURCE_FILES = Object.freeze(["LICENSE", "scripts/build-packs.mjs", "scripts/check-corpus.mjs"]);

export async function distributionSourcePaths(repository) {
  const files = [...SOURCE_FILES];
  for (const tree of SOURCE_TREES) await walk(repository, tree, files);
  await walk(repository, "examples/negative-pack", files);
  return files.filter((relative) => relative !== "test/public_deterministic_v1.test.mjs").sort();
}

export async function buildDistributionTree(repository, outputRoot) {
  for (const relative of await distributionSourcePaths(repository)) {
    await writeTreeFile(outputRoot, relative, await readFile(path.join(repository, relative)), executable(relative));
  }
  await writeTreeFile(outputRoot, "package.json", Buffer.from(`${JSON.stringify({
    name: "@tkersey/world-capabilities-deterministic",
    version: PUBLIC_DETERMINISTIC_VERSION,
    private: true,
    license: "MIT",
    type: "module",
    engines: { bun: ">=1.3.14" },
    scripts: {
      test: "bun test",
      proof: "bun harness/check-pack.mjs --all && bun harness/run-negative.mjs && bun harness/run-sidecar-conformance.mjs && bun harness/redaction-tests.mjs && bun harness/policy-tests.mjs && bun test test/effect_protocol_v1.test.mjs test/effect_protocol_v1_manifest.test.mjs test/research_lookup_fixture.test.mjs test/agent_invoke_v1.test.mjs && bun scripts/check-corpus.mjs",
      conformance: "bun conformance/run-conformance.mjs --root .",
    },
    dependencies: {},
    devDependencies: {},
  }, null, 2)}\n`));
  await writeTreeFile(outputRoot, "README.md", Buffer.from(`# world-capabilities v${PUBLIC_DETERMINISTIC_VERSION} deterministic conformance\n\nThis source-independent distribution verifies Effect protocol v1 packs and executes only synthetic or mocked conformance. It requires Bun 1.3.14 or newer and no GitHub or provider credential. Live adapter source is inspectable, but conformance makes no live provider call. The research fixture remains bound to its exact World \`v3.0.0\` release.\n\n\`\`\`sh\nbun conformance/check-distribution.mjs --root .\nbun conformance/run-conformance.mjs --root .\n\`\`\`\n`));
  for (const [source, target] of [
    ["public-deterministic-v1.mjs", "public-deterministic-v1.mjs"],
    ["check-public-deterministic-v1.mjs", "check-distribution.mjs"],
    ["run-public-deterministic-v1-conformance.mjs", "run-conformance.mjs"],
  ]) {
    await writeTreeFile(outputRoot, `conformance/${target}`, await readFile(path.join(repository, "scripts", source)), true);
  }
  const covered = await treeFiles(outputRoot);
  const checksums = [];
  for (const relative of covered) checksums.push(`${sha256(await readFile(path.join(outputRoot, relative)))}  ${relative}`);
  await writeTreeFile(outputRoot, "checksums.sha256", Buffer.from(`${checksums.join("\n")}\n`));
  const manifest = {
    archiveRoot: PUBLIC_DETERMINISTIC_ROOT,
    bunMinimumVersion: "1.3.14",
    effectProtocolVersion: 1,
    format: "world-capabilities-public-deterministic/v1",
    githubAuthenticationRequired: false,
    githubCliRequired: false,
    liveEffectsExecuted: false,
    receiverSecretsRequired: false,
    sourceCheckoutRequired: false,
    staticInspectionImportsAdapters: false,
    verifier: "conformance/check-distribution.mjs",
    version: PUBLIC_DETERMINISTIC_VERSION,
  };
  await writeTreeFile(outputRoot, "manifest.json", Buffer.from(`${stableJson(manifest)}\n`));
  return manifest;
}

export async function writeDeterministicArchive(treeRoot, outputPath) {
  const entries = await treeFiles(treeRoot);
  const chunks = [];
  for (const relative of entries) {
    const bytes = await readFile(path.join(treeRoot, relative));
    chunks.push(tarHeader(`${PUBLIC_DETERMINISTIC_ROOT}/${relative}`, bytes.length, executable(relative) ? 0o755 : 0o644));
    chunks.push(bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  assert(archive.length <= MAXIMUM_ARCHIVE_BYTES, "deterministic archive exceeds maximum size");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, archive);
  return { sha256: sha256(archive), bytes: archive.length, entries: entries.length };
}

export async function extractDistributionArchive(archivePath, destination) {
  const archive = await readFile(archivePath);
  assert(archive.length <= MAXIMUM_ARCHIVE_BYTES, "deterministic archive exceeds maximum size");
  const tar = gunzipSync(archive, { maxOutputLength: MAXIMUM_EXPANDED_BYTES });
  let offset = 0;
  let expanded = 0;
  let count = 0;
  const seen = new Set();
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    count += 1;
    assert(count <= MAXIMUM_ENTRY_COUNT, "deterministic archive has too many entries");
    const storedChecksum = octal(header.subarray(148, 156));
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    assert.equal(sum(checksumHeader), storedChecksum, "invalid tar header checksum");
    const name = textField(header.subarray(0, 100));
    const prefix = textField(header.subarray(345, 500));
    const relative = prefix ? `${prefix}/${name}` : name;
    assert(relative.startsWith(`${PUBLIC_DETERMINISTIC_ROOT}/`), "unexpected archive root");
    const inside = relative.slice(PUBLIC_DETERMINISTIC_ROOT.length + 1);
    assert(safeRelative(inside), `unsafe archive path: ${relative}`);
    assert(!seen.has(inside), `duplicate archive path: ${inside}`);
    seen.add(inside);
    const type = header[156];
    assert(type === 0 || type === 0x30, `links and non-files are forbidden: ${inside}`);
    const size = octal(header.subarray(124, 136));
    expanded += size;
    assert(expanded <= MAXIMUM_EXPANDED_BYTES, "deterministic archive expansion exceeds maximum");
    assert(offset + size <= tar.length, "truncated tar entry");
    await writeTreeFile(destination, inside, tar.subarray(offset, offset + size), executable(inside));
    offset += size + ((512 - (size % 512)) % 512);
  }
  assert(count > 0, "deterministic archive is empty");
  return { sha256: sha256(archive), bytes: archive.length, entries: count, expandedBytes: expanded };
}

export async function verifyDistributionTree(root) {
  const files = await treeFiles(root);
  for (const required of [
    "LICENSE", "README.md", "package.json", "manifest.json", "checksums.sha256",
    "src/v1/router.mjs", "src/v1/protocol.mjs", "packages/repository-repair-decision-fixture/adapter.mjs",
    "packages/repository-workspace-actuality/adapter.mjs", "conformance/check-distribution.mjs",
    "conformance/run-conformance.mjs",
  ]) assert(files.includes(required), `missing deterministic file: ${required}`);
  for (const relative of files) {
    assert(!/(^|\/)(\.git|node_modules|runtime-stores?|live-runs?|provider-transcripts?|private-evidence)(\/|$)/i.test(relative), `forbidden deterministic path: ${relative}`);
    assert(!/(^|\/)\.env(?:\.|$)/i.test(relative), `environment file forbidden: ${relative}`);
  }
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest, {
    archiveRoot: PUBLIC_DETERMINISTIC_ROOT,
    bunMinimumVersion: "1.3.14",
    effectProtocolVersion: 1,
    format: "world-capabilities-public-deterministic/v1",
    githubAuthenticationRequired: false,
    githubCliRequired: false,
    liveEffectsExecuted: false,
    receiverSecretsRequired: false,
    sourceCheckoutRequired: false,
    staticInspectionImportsAdapters: false,
    verifier: "conformance/check-distribution.mjs",
    version: PUBLIC_DETERMINISTIC_VERSION,
  });
  const checksums = parseChecksums(await readFile(path.join(root, "checksums.sha256"), "utf8"));
  const covered = files.filter((file) => !["checksums.sha256", "manifest.json"].includes(file));
  assert.deepEqual([...checksums.keys()].sort(), covered, "deterministic checksum coverage mismatch");
  for (const relative of covered) {
    assert.equal(sha256(await readFile(path.join(root, relative))), checksums.get(relative), `deterministic checksum mismatch: ${relative}`);
  }
  return { fileCount: files.length, checksumCount: checksums.size, ...manifest };
}

export function parseChecksumSidecar(text, expectedName = PUBLIC_DETERMINISTIC_ARCHIVE) {
  const match = /^([0-9a-f]{64})  ([^\n]+)\n?$/.exec(text);
  assert(match, "invalid checksum sidecar");
  assert.equal(match[2], expectedName, "checksum sidecar asset mismatch");
  return match[1];
}

async function walk(root, relative, output) {
  const entries = await readdir(path.join(root, relative));
  for (const name of entries.sort()) {
    const child = path.posix.join(relative, name);
    const info = await lstat(path.join(root, child));
    assert(!info.isSymbolicLink(), `distribution source symlink forbidden: ${child}`);
    if (info.isDirectory()) await walk(root, child, output);
    else if (info.isFile()) output.push(child);
  }
}

async function treeFiles(root) {
  const output = [];
  await walk(root, ".", output);
  return output.map((value) => value.startsWith("./") ? value.slice(2) : value).sort();
}

async function writeTreeFile(root, relative, bytes, isExecutable = false) {
  assert(safeRelative(relative), `unsafe output path: ${relative}`);
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { mode: isExecutable ? 0o755 : 0o644 });
}

function tarHeader(relative, size, mode) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(relative);
  Buffer.from(name).copy(header, 0);
  Buffer.from(prefix).copy(header, 345);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  Buffer.from("ustar\0").copy(header, 257);
  Buffer.from("00").copy(header, 263);
  writeOctal(header, 148, 8, sum(header));
  return header;
}

function splitTarPath(relative) {
  if (Buffer.byteLength(relative) <= 100) return { name: relative, prefix: "" };
  for (let index = relative.lastIndexOf("/"); index > 0; index = relative.lastIndexOf("/", index - 1)) {
    const prefix = relative.slice(0, index);
    const name = relative.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`tar path is too long: ${relative}`);
}

function writeOctal(buffer, offset, width, value) {
  const encoded = value.toString(8).padStart(width - 2, "0");
  assert(encoded.length <= width - 2, "tar numeric field overflow");
  buffer.write(encoded, offset, "ascii");
  buffer[offset + width - 2] = 0;
  buffer[offset + width - 1] = 0x20;
}
function octal(bytes) {
  const value = textField(bytes).trim();
  assert(/^[0-7]*$/.test(value), "invalid tar octal field");
  return value === "" ? 0 : Number.parseInt(value, 8);
}
function textField(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}
function sum(bytes) { let result = 0; for (const byte of bytes) result += byte; return result; }
function executable(relative) { return relative.startsWith("conformance/") || relative.startsWith("harness/") || relative.startsWith("scripts/"); }
function safeRelative(value) { return value.length > 0 && !path.posix.isAbsolute(value) && !value.split("/").some((part) => part === "" || part === "." || part === ".."); }
export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function stableJson(value) { return JSON.stringify(value, Object.keys(value).sort(), 2); }
function parseChecksums(text) {
  const result = new Map();
  for (const line of text.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64})  ([^\n]+)$/.exec(line);
    assert(match, "invalid deterministic checksum line");
    assert(safeRelative(match[2]) && !result.has(match[2]), "invalid or duplicate deterministic checksum path");
    result.set(match[2], match[1]);
  }
  return result;
}
