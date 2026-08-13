import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  PUBLIC_DETERMINISTIC_ARCHIVE,
  PUBLIC_DETERMINISTIC_ROOT,
  MAXIMUM_ARCHIVE_BYTES,
  MAXIMUM_EXPANDED_BYTES,
  admitExpandedArchiveBytes,
  admitDistributionSourcePaths,
  buildDistributionTree,
  distributionSourcePaths,
  extractDistributionArchive,
  readDistributionArchive,
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

    const oversized = path.join(root, "oversized.tar.gz");
    await Bun.write(oversized, Buffer.alloc(0));
    await truncate(oversized, MAXIMUM_ARCHIVE_BYTES + 1);
    await expect(readDistributionArchive(oversized)).rejects.toThrow("deterministic archive exceeds maximum size");

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

    const checkSource = await readFile("scripts/check-public-deterministic-v1.mjs", "utf8");
    const conformanceSource = await readFile("scripts/run-public-deterministic-v1-conformance.mjs", "utf8");
    expect(checkSource).toContain("Bun.spawn([process.execPath");
    expect(conformanceSource).toContain('[process.execPath, "run", "proof"]');
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

function writeOctal(buffer, offset, width, value) {
  buffer.write(value.toString(8).padStart(width - 2, "0"), offset, "ascii");
  buffer[offset + width - 2] = 0;
  buffer[offset + width - 1] = 0x20;
}
