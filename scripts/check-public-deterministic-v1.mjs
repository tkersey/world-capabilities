#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  extractDistributionArchive,
  parseChecksumSidecar,
  readChecksumSidecar,
  readDistributionArchive,
  sha256,
  verifyDistributionTree,
} from "./public-deterministic-v1.mjs";

const archive = valueAfter("--archive");
const rootArgument = valueAfter("--root");
assert((archive === null) !== (rootArgument === null), "provide exactly one of --archive or --root");
const temporary = archive === null ? null : await mkdtemp(path.join(tmpdir(), "world-capabilities-public-check-"));
try {
  const root = archive === null ? path.resolve(rootArgument) : temporary;
  let extraction = null;
  if (archive !== null) {
    const archivePath = path.resolve(archive);
    const checksum = valueAfter("--checksum");
    assert(checksum !== null, "--checksum is required with --archive");
    const bytes = await readDistributionArchive(archivePath);
    const expected = parseChecksumSidecar(await readChecksumSidecar(path.resolve(checksum)), path.basename(archivePath));
    assert.equal(sha256(bytes), expected, "release asset checksum mismatch");
    extraction = await extractDistributionArchive(archivePath, root, bytes);
  }
  const receipt = await verifyDistributionTree(root);
  process.stdout.write(`${JSON.stringify({
    schema: "world-capabilities-public-deterministic-check/v1",
    ...receipt,
    archive: extraction,
    executesArchiveCode: false,
  }, null, 2)}\n`);
} finally {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true });
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  if (index + 1 >= process.argv.length) throw new Error(`${flag} requires a value`);
  return process.argv[index + 1];
}
