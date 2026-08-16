import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const PUBLIC_DETERMINISTIC_VERSION = "2.3.1";
export const PUBLIC_DETERMINISTIC_ROOT = `world-capabilities-v${PUBLIC_DETERMINISTIC_VERSION}-deterministic`;
export const PUBLIC_DETERMINISTIC_ARCHIVE = `${PUBLIC_DETERMINISTIC_ROOT}.tar.gz`;
export const MAXIMUM_ARCHIVE_BYTES = 32 << 20;
export const MAXIMUM_EXPANDED_BYTES = 128 << 20;
export const MAXIMUM_ENTRY_COUNT = 2048;
export const MAXIMUM_CHECKSUM_SIDECAR_BYTES = 256;

const SOURCE_TREES = Object.freeze(["corpus", "harness", "packages", "src/v1", "test"]);
const SOURCE_FILES = Object.freeze(["LICENSE", "scripts/build-packs.mjs", "scripts/check-corpus.mjs"]);
const CONFORMANCE_SOURCE_FILES = Object.freeze([
  ["scripts/public-deterministic-v1.mjs", "public-deterministic-v1.mjs"],
  ["scripts/check-public-deterministic-v1.mjs", "check-distribution.mjs"],
  ["scripts/run-public-deterministic-v1-conformance.sh", "run-conformance.sh"],
  ["scripts/run-public-deterministic-v1-conformance.mjs", "run-conformance.mjs"],
]);
const DISTRIBUTION_SOURCE_PATHS_SHA256 = "2ba655fc983e9c43f2e3cc339774effa2b3de5d2d9b2a18df52feebf58373330";
const DISTRIBUTION_SOURCE_CONTENT_SHA256 = "4d9df606b2dff211ef72536a744bfa635435b0f1407610c619996a2fb6c2a65e";

export async function distributionSourcePaths(repository) {
  const admitted = await reviewedDistributionSourcePaths(repository);
  const snapshot = await snapshotFileBytes(repository, identitySourcePaths(admitted));
  admitDistributionSourceContent(distributionSourceContentDigestFromSnapshot(snapshot, identitySourcePaths(admitted)));
  return admitted;
}

async function reviewedDistributionSourcePaths(repository) {
  const files = [...SOURCE_FILES];
  for (const tree of SOURCE_TREES) await walk(repository, tree, files);
  await walk(repository, "examples/negative-pack", files);
  return admitDistributionSourcePaths(files.filter((relative) => relative !== "test/public_deterministic_v1.test.mjs").sort());
}

export function admitDistributionSourcePaths(files) {
  assert.equal(sha256(Buffer.from(`${files.join("\n")}\n`)), DISTRIBUTION_SOURCE_PATHS_SHA256,
    "distribution source path set differs from the reviewed release inputs");
  return files;
}

export async function distributionSourceContentDigest(repository, files) {
  return distributionSourceContentDigestFromSnapshot(await snapshotFileBytes(repository, files), files);
}

export async function snapshotFileBytes(repository, files) {
  const snapshot = new Map();
  for (const relative of files) snapshot.set(relative, await readFile(path.join(repository, relative)));
  return snapshot;
}

function distributionSourceContentDigestFromSnapshot(snapshot, files) {
  const digest = createHash("sha256");
  for (const relative of files) {
    let bytes = snapshot.get(relative);
    assert(bytes !== undefined, `distribution source snapshot is missing: ${relative}`);
    if (relative === "scripts/public-deterministic-v1.mjs") {
      bytes = Buffer.from(bytes.toString("utf8").replace(
        /const DISTRIBUTION_SOURCE_CONTENT_SHA256 = "[^"]+";/,
        'const DISTRIBUTION_SOURCE_CONTENT_SHA256 = "<self>";',
      ));
    }
    digest.update(relative);
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

export async function distributionSourceIdentityDigest(repository, distributionPaths) {
  const files = identitySourcePaths(distributionPaths);
  return distributionSourceContentDigestFromSnapshot(await snapshotFileBytes(repository, files), files);
}

function identitySourcePaths(distributionPaths) {
  return [...distributionPaths, ...CONFORMANCE_SOURCE_FILES.map(([source]) => source)].sort();
}

export function admitDistributionSourceContent(actual) {
  assert.equal(actual, DISTRIBUTION_SOURCE_CONTENT_SHA256,
    "distribution source bytes differ from the reviewed release inputs");
}

export async function runtimeTreeDigest(repository) {
  const files = [];
  for (const tree of ["packages", "src/v1"]) await walk(repository, tree, files);
  files.sort();
  const digest = createHash("sha256");
  for (const relative of files) {
    digest.update(relative);
    digest.update("\0");
    digest.update(await readFile(path.join(repository, relative)));
    digest.update("\0");
  }
  return { fileCount: files.length, sha256: digest.digest("hex") };
}

export async function buildDistributionTree(repository, outputRoot) {
  const distributionPaths = await reviewedDistributionSourcePaths(repository);
  const snapshot = await snapshotFileBytes(repository, identitySourcePaths(distributionPaths));
  admitDistributionSourceContent(distributionSourceContentDigestFromSnapshot(snapshot, identitySourcePaths(distributionPaths)));
  for (const relative of distributionPaths) {
    await writeTreeFile(outputRoot, relative, snapshot.get(relative), executable(relative));
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
    },
    dependencies: {},
    devDependencies: {},
  }, null, 2)}\n`));
  await writeTreeFile(outputRoot, "README.md", Buffer.from(`# world-capabilities v${PUBLIC_DETERMINISTIC_VERSION} deterministic conformance\n\nThis source-independent distribution verifies Effect protocol v1 packs and executes only synthetic or mocked conformance. It requires Bun 1.3.14 or newer and no GitHub or provider credential. Live adapter source is inspectable, but conformance makes no live provider call. It includes the exact deterministic router-policy adequacy decision and workspace packs. The research fixture remains bound to its exact World \`v3.0.0\` release.\n\nAuthenticate the complete release archive before executing any bundled code, then inspect and run conformance:\n\n\`\`\`sh\n(cd .. && shasum -a 256 -c ${PUBLIC_DETERMINISTIC_ARCHIVE}.sha256)\nbun conformance/check-distribution.mjs --root .\nsh conformance/run-conformance.sh --archive ../${PUBLIC_DETERMINISTIC_ARCHIVE} --checksum ../${PUBLIC_DETERMINISTIC_ARCHIVE}.sha256\n\`\`\`\n`));
  for (const [source, target] of CONFORMANCE_SOURCE_FILES) {
    await writeTreeFile(outputRoot, `conformance/${target}`, snapshot.get(source), true);
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
  admitArchiveEntryCount(entries.length);
  const opened = [];
  try {
    let projectedBytes = 1024;
    for (const relative of entries) {
      const handle = await open(path.join(treeRoot, relative), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        assert(info.isFile(), `deterministic archive entry must be a regular file: ${relative}`);
        projectedBytes += 512 + info.size + ((512 - (info.size % 512)) % 512);
        admitExpandedArchiveBytes(projectedBytes);
        opened.push({ handle, info, relative });
      } catch (error) {
        await handle.close();
        throw error;
      }
    }

    const chunks = [];
    for (const entry of opened) {
      const current = await entry.handle.stat();
      assert.equal(current.size, entry.info.size, `deterministic archive entry changed during admission: ${entry.relative}`);
      const bytes = await entry.handle.readFile();
      assert.equal(bytes.length, entry.info.size, `deterministic archive entry changed during admission: ${entry.relative}`);
      chunks.push(tarHeader(`${PUBLIC_DETERMINISTIC_ROOT}/${entry.relative}`, bytes.length, executable(entry.relative) ? 0o755 : 0o644));
      chunks.push(bytes);
      const padding = (512 - (bytes.length % 512)) % 512;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
    chunks.push(Buffer.alloc(1024));
    const tar = Buffer.concat(chunks, projectedBytes);
    const archive = canonicalGzip(tar);
    assert(archive.length <= MAXIMUM_ARCHIVE_BYTES, "deterministic archive exceeds maximum size");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, archive);
    return { sha256: sha256(archive), bytes: archive.length, entries: entries.length };
  } finally {
    await Promise.all(opened.map(({ handle }) => handle.close()));
  }
}

export function admitExpandedArchiveBytes(bytes) {
  assert(bytes <= MAXIMUM_EXPANDED_BYTES, "deterministic archive expansion exceeds maximum");
}

export function admitArchiveEntryCount(count) {
  assert(count <= MAXIMUM_ENTRY_COUNT, "deterministic archive has too many entries");
}

export async function readDistributionArchive(archivePath) {
  const handle = await open(archivePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    assert(info.isFile(), "deterministic archive must be a regular file");
    assert(info.size <= MAXIMUM_ARCHIVE_BYTES, "deterministic archive exceeds maximum size");
    const archive = await handle.readFile();
    assert(archive.length <= MAXIMUM_ARCHIVE_BYTES, "deterministic archive exceeds maximum size");
    return archive;
  } finally {
    await handle.close();
  }
}

export async function extractDistributionArchive(archivePath, destination, authenticatedArchive = null) {
  const archive = authenticatedArchive ?? await readDistributionArchive(archivePath);
  assert(archive.length <= MAXIMUM_ARCHIVE_BYTES, "deterministic archive exceeds maximum size");
  assert.deepEqual(archive.subarray(0, 10), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]),
    "deterministic archive has non-canonical gzip metadata");
  const inflated = inflateRawSync(archive.subarray(10), { info: true, maxOutputLength: MAXIMUM_EXPANDED_BYTES });
  assert.equal(10 + inflated.engine.bytesWritten + 8, archive.length,
    "deterministic archive must contain exactly one gzip member");
  const tar = gunzipSync(archive, { maxOutputLength: MAXIMUM_EXPANDED_BYTES });
  assert(archive.equals(canonicalGzip(tar)), "deterministic archive gzip encoding is not canonical");
  assert.equal(tar.length % 512, 0, "tar payload is not block aligned");
  let offset = 0;
  let expanded = 0;
  let count = 0;
  let terminated = false;
  const seen = new Set();
  const portableSeen = new Set();
  const entries = [];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      assert(offset + 512 <= tar.length, "tar terminator is incomplete");
      assert(tar.subarray(offset, offset + 512).every((byte) => byte === 0), "tar terminator is incomplete");
      offset += 512;
      assert(tar.subarray(offset).every((byte) => byte === 0), "non-zero data follows tar terminator");
      terminated = true;
      break;
    }
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
    const portable = inside.normalize("NFC").toLowerCase();
    assert(!portableSeen.has(portable), `non-portable archive path collision: ${inside}`);
    portableSeen.add(portable);
    const type = header[156];
    assert(type === 0 || type === 0x30, `links and non-files are forbidden: ${inside}`);
    const size = octal(header.subarray(124, 136));
    assert(header.equals(tarHeader(relative, size, executable(inside) ? 0o755 : 0o644)),
      `non-canonical tar header: ${inside}`);
    expanded += size;
    assert(expanded <= MAXIMUM_EXPANDED_BYTES, "deterministic archive expansion exceeds maximum");
    const padding = (512 - (size % 512)) % 512;
    assert(offset + size + padding <= tar.length, "truncated tar entry");
    entries.push({ inside, bytes: tar.subarray(offset, offset + size), isExecutable: executable(inside) });
    offset += size;
    assert(tar.subarray(offset, offset + padding).every((byte) => byte === 0), `non-zero tar padding: ${inside}`);
    offset += padding;
  }
  assert(count > 0, "deterministic archive is empty");
  assert(terminated, "deterministic archive has no complete terminator");
  for (const entry of entries) {
    await writeTreeFile(destination, entry.inside, entry.bytes, entry.isExecutable);
  }
  return { sha256: sha256(archive), bytes: archive.length, entries: count, expandedBytes: expanded };
}

export function canonicalGzip(bytes) {
  const blocks = [];
  for (let offset = 0; offset < bytes.length || blocks.length === 0;) {
    const length = Math.min(0xffff, bytes.length - offset);
    const final = offset + length === bytes.length;
    const header = Buffer.alloc(5);
    header[0] = final ? 1 : 0;
    header.writeUInt16LE(length, 1);
    header.writeUInt16LE(length ^ 0xffff, 3);
    blocks.push(header, bytes.subarray(offset, offset + length));
    offset += length;
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  return Buffer.concat([
    Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]),
    ...blocks,
    trailer,
  ]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function verifyDistributionTree(root) {
  const files = await treeFiles(root);
  for (const required of [
    "LICENSE", "README.md", "package.json", "manifest.json", "checksums.sha256",
    "src/v1/router.mjs", "src/v1/protocol.mjs", "packages/repository-repair-decision-fixture/adapter.mjs",
    "packages/repository-workspace-actuality/adapter.mjs",
    "packages/router-adequacy-decision-fixture/adapter.mjs",
    "packages/repository-workspace-adequacy/adapter.mjs",
    "src/v1/adequacy/router_adequacy_codecs.mjs",
    "conformance/check-distribution.mjs",
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

export async function readChecksumSidecar(sidecarPath) {
  const handle = await open(sidecarPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    assert(info.isFile(), "checksum sidecar must be a regular file");
    assert(info.size <= MAXIMUM_CHECKSUM_SIDECAR_BYTES, "checksum sidecar exceeds maximum size");
    const bytes = await handle.readFile();
    assert(bytes.length <= MAXIMUM_CHECKSUM_SIDECAR_BYTES, "checksum sidecar exceeds maximum size");
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function walk(root, relative, output) {
  const entries = await readdir(path.join(root, relative));
  for (const name of entries.sort()) {
    const child = path.posix.join(relative, name);
    const info = await lstat(path.join(root, child));
    assert(!info.isSymbolicLink(), `distribution source symlink forbidden: ${child}`);
    if (info.isDirectory()) await walk(root, child, output);
    else if (info.isFile()) output.push(child);
    else assert.fail(`unsupported distribution entry: ${child}`);
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
function safeRelative(value) { return value.length > 0 && !value.includes("\\") && !path.posix.isAbsolute(value) && !value.split("/").some((part) => part === "" || part === "." || part === ".."); }
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
