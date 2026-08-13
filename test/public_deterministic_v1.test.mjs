import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  PUBLIC_DETERMINISTIC_ARCHIVE,
  PUBLIC_DETERMINISTIC_ROOT,
  admitDistributionSourcePaths,
  buildDistributionTree,
  distributionSourcePaths,
  extractDistributionArchive,
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
    expect(sha256(await readFile(first))).toBe(left.sha256);
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function minimalArchive(name, contents) {
  const header = Buffer.alloc(512);
  Buffer.from(name).copy(header, 0);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contents.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  Buffer.from("ustar\0").copy(header, 257);
  Buffer.from("00").copy(header, 263);
  writeOctal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0));
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, contents, padding, Buffer.alloc(1024)]), { level: 9, mtime: 0 });
}

function writeOctal(buffer, offset, width, value) {
  buffer.write(value.toString(8).padStart(width - 2, "0"), offset, "ascii");
  buffer[offset + width - 2] = 0;
  buffer[offset + width - 1] = 0x20;
}
