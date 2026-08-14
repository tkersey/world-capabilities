import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  PUBLIC_DETERMINISTIC_ARCHIVE,
  PUBLIC_DETERMINISTIC_ROOT,
  MAXIMUM_ARCHIVE_BYTES,
  MAXIMUM_ENTRY_COUNT,
  MAXIMUM_EXPANDED_BYTES,
  admitArchiveEntryCount,
  admitExpandedArchiveBytes,
  admitDistributionSourceContent,
  admitDistributionSourcePaths,
  buildDistributionTree,
  distributionSourceContentDigest,
  distributionSourceIdentityDigest,
  distributionSourcePaths,
  extractDistributionArchive,
  readDistributionArchive,
  readChecksumSidecar,
  runtimeTreeDigest,
  sha256,
  verifyDistributionTree,
  writeDeterministicArchive,
} from "../scripts/public-deterministic-v1.mjs";

test("v2.1.2 readiness preserves v2.1.1 production runtime bytes", async () => {
  expect(await runtimeTreeDigest(process.cwd())).toEqual({
    fileCount: 85,
    sha256: "3cc6cd5fec37f58ec6c1fa9112195d2c5fb1c4ec33015d4afd898fd3b15d5053",
  });
});

test("release inputs are closed over the reviewed source path set", async () => {
  const paths = await distributionSourcePaths(process.cwd());
  expect(() => admitDistributionSourcePaths([...paths, "packages/fixture-model/local-debug.txt"])).toThrow(
    "distribution source path set differs from the reviewed release inputs",
  );
  const digest = await distributionSourceIdentityDigest(process.cwd(), paths);
  expect(() => admitDistributionSourceContent(digest)).not.toThrow();

  const root = await mkdtemp(path.join(tmpdir(), "world-capabilities-source-identity-"));
  try {
    await Bun.write(path.join(root, "source.mjs"), "export const value = 1;\n");
    const before = await distributionSourceContentDigest(root, ["source.mjs"]);
    await Bun.write(path.join(root, "source.mjs"), "export const value = 2;\n");
    const after = await distributionSourceContentDigest(root, ["source.mjs"]);
    expect(after).not.toBe(before);
    expect(() => admitDistributionSourceContent(after)).toThrow(
      "distribution source bytes differ from the reviewed release inputs",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deterministic distribution is reproducible and safely self-verifying", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "world-capabilities-public-test-"));
  try {
    const tree = path.join(root, PUBLIC_DETERMINISTIC_ROOT);
    await buildDistributionTree(process.cwd(), tree);
    const first = path.join(root, PUBLIC_DETERMINISTIC_ARCHIVE);
    const second = path.join(root, `second-${PUBLIC_DETERMINISTIC_ARCHIVE}`);
    const left = await writeDeterministicArchive(tree, first);
    const right = await writeDeterministicArchive(tree, second);
    expect(left.sha256).toBe(right.sha256);
    const firstBytes = await readFile(first);
    expect(sha256(firstBytes)).toBe(left.sha256);
    expect(firstBytes[9]).toBe(0xff);
    expect(() => admitExpandedArchiveBytes(MAXIMUM_EXPANDED_BYTES + 1)).toThrow(
      "deterministic archive expansion exceeds maximum",
    );
    expect(() => admitArchiveEntryCount(MAXIMUM_ENTRY_COUNT + 1)).toThrow(
      "deterministic archive has too many entries",
    );
    const extracted = path.join(root, "extracted");
    await extractDistributionArchive(first, extracted);
    const receipt = await verifyDistributionTree(extracted);
    expect(receipt.sourceCheckoutRequired).toBe(false);
    expect(receipt.receiverSecretsRequired).toBe(false);
    expect(receipt.staticInspectionImportsAdapters).toBe(false);

    const traversal = path.join(root, "traversal.tar.gz");
    await Bun.write(traversal, minimalArchive(`${PUBLIC_DETERMINISTIC_ROOT}/..\\outside.txt`, Buffer.from("escape")));
    await expect(extractDistributionArchive(traversal, path.join(root, "traversal-output"))).rejects.toThrow("unsafe archive path");

    const trailing = path.join(root, "trailing.tar.gz");
    await Bun.write(trailing, gzipSync(Buffer.concat([gunzipSync(await readFile(first)), Buffer.alloc(512, 0x41)])), { createPath: true });
    await expect(extractDistributionArchive(trailing, path.join(root, "trailing-output"))).rejects.toThrow(
      "non-zero data follows tar terminator",
    );
    await expect(readdir(path.join(root, "trailing-output"))).rejects.toThrow();

    const collision = path.join(root, "collision.tar.gz");
    await Bun.write(collision, minimalArchive([
      [`${PUBLIC_DETERMINISTIC_ROOT}/LICENSE`, Buffer.from("same")],
      [`${PUBLIC_DETERMINISTIC_ROOT}/license`, Buffer.from("same")],
    ]));
    await expect(extractDistributionArchive(collision, path.join(root, "collision-output"))).rejects.toThrow(
      "non-portable archive path collision",
    );

    const nonCanonical = path.join(root, "non-canonical.tar.gz");
    await Bun.write(nonCanonical, mutateArchiveHeader(
      minimalArchive(`${PUBLIC_DETERMINISTIC_ROOT}/LICENSE`, Buffer.from("same")),
      (header) => writeOctal(header, 108, 8, 1),
    ));
    await expect(extractDistributionArchive(nonCanonical, path.join(root, "non-canonical-output"))).rejects.toThrow(
      "non-canonical tar header",
    );

    const nonZeroPadding = path.join(root, "non-zero-padding.tar.gz");
    const paddedTar = gunzipSync(minimalArchive(`${PUBLIC_DETERMINISTIC_ROOT}/LICENSE`, Buffer.from("x")));
    paddedTar[513] = 1;
    await Bun.write(nonZeroPadding, gzipSync(paddedTar, { level: 9, mtime: 0 }));
    await expect(extractDistributionArchive(nonZeroPadding, path.join(root, "non-zero-padding-output"))).rejects.toThrow(
      "non-zero tar padding",
    );

    const oversized = path.join(root, "oversized.tar.gz");
    await Bun.write(oversized, Buffer.alloc(0));
    await truncate(oversized, MAXIMUM_ARCHIVE_BYTES + 1);
    await expect(readDistributionArchive(oversized)).rejects.toThrow("deterministic archive exceeds maximum size");

    const oversizedTree = path.join(root, "oversized-tree");
    await mkdir(oversizedTree);
    const oversizedEntry = path.join(oversizedTree, "payload.bin");
    await Bun.write(oversizedEntry, "");
    await truncate(oversizedEntry, MAXIMUM_EXPANDED_BYTES + 1);
    await expect(writeDeterministicArchive(oversizedTree, path.join(root, "oversized-output.tar.gz"))).rejects.toThrow(
      "deterministic archive expansion exceeds maximum",
    );

    const hugeSidecar = path.join(root, "huge.sha256");
    await Bun.write(hugeSidecar, "");
    await truncate(hugeSidecar, 257);
    await expect(readChecksumSidecar(hugeSidecar)).rejects.toThrow("checksum sidecar exceeds maximum size");

    const fifoSidecar = path.join(root, "checksum.fifo");
    const mkfifoSidecar = Bun.spawnSync(["mkfifo", fifoSidecar]);
    expect(mkfifoSidecar.exitCode).toBe(0);
    await expect(readChecksumSidecar(fifoSidecar)).rejects.toThrow("checksum sidecar must be a regular file");

    const fifo = path.join(extracted, "uncovered-fifo");
    const mkfifo = Bun.spawnSync(["mkfifo", fifo]);
    expect(mkfifo.exitCode).toBe(0);
    await expect(verifyDistributionTree(extracted)).rejects.toThrow("unsupported distribution entry");

    for (const script of [
      "scripts/check-public-deterministic-v1.mjs",
      "scripts/run-public-deterministic-v1-conformance.mjs",
    ]) {
      const missingChecksum = Bun.spawn(["bun", script, "--archive", first], {
        cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
      });
      const [missingChecksumError, missingChecksumExit] = await Promise.all([
        new Response(missingChecksum.stderr).text(), missingChecksum.exited,
      ]);
      expect(missingChecksumExit).not.toBe(0);
      expect(missingChecksumError).toContain("--checksum is required with --archive");
    }

    const rootConformance = Bun.spawn([process.execPath, "scripts/run-public-deterministic-v1-conformance.mjs", "--root", extracted], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [rootConformanceError, rootConformanceExit] = await Promise.all([
      new Response(rootConformance.stderr).text(), rootConformance.exited,
    ]);
    expect(rootConformanceExit).not.toBe(0);
    expect(rootConformanceError).toContain("--archive is required for executable conformance");

    const checkSource = await readFile("scripts/check-public-deterministic-v1.mjs", "utf8");
    const conformanceSource = await readFile("scripts/run-public-deterministic-v1-conformance.mjs", "utf8");
    expect(checkSource).toContain("Bun.spawn([process.execPath");
    expect(conformanceSource).not.toContain('[process.execPath, "run", "proof"]');
    expect(conformanceSource).toContain('[process.execPath, "harness/check-pack.mjs", "--all"]');
    expect(conformanceSource).toContain('[process.execPath, "scripts/check-corpus.mjs"]');
    expect(conformanceSource).toContain('[process.execPath, "test"]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function minimalArchive(nameOrEntries, contents = null) {
  const entries = Array.isArray(nameOrEntries) ? nameOrEntries : [[nameOrEntries, contents]];
  const chunks = [];
  for (const [name, entryContents] of entries) {
    const header = Buffer.alloc(512);
    Buffer.from(name).copy(header, 0);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entryContents.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    Buffer.from("ustar\0").copy(header, 257);
    Buffer.from("00").copy(header, 263);
    writeOctal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0));
    chunks.push(header, entryContents, Buffer.alloc((512 - (entryContents.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]), { level: 9, mtime: 0 });
}

function mutateArchiveHeader(archive, mutate) {
  const tar = gunzipSync(archive);
  const header = tar.subarray(0, 512);
  mutate(header);
  header.fill(0x20, 148, 156);
  writeOctal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0));
  return gzipSync(tar, { level: 9, mtime: 0 });
}

function writeOctal(buffer, offset, width, value) {
  buffer.write(value.toString(8).padStart(width - 2, "0"), offset, "ascii");
  buffer[offset + width - 2] = 0;
  buffer[offset + width - 1] = 0x20;
}
