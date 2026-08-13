#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  extractDistributionArchive,
  parseChecksumSidecar,
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
    const expected = parseChecksumSidecar(await readFile(path.resolve(checksum), "utf8"), path.basename(archivePath));
    assert.equal(sha256(bytes), expected, "release asset checksum mismatch");
    extraction = await extractDistributionArchive(archivePath, root, bytes);
  }
  const receipt = await verifyDistributionTree(root);
  let packagedVerifier = null;
  if (archive !== null) {
    const child = Bun.spawn([process.execPath, path.join(root, "conformance/check-distribution.mjs"), "--root", root], {
      cwd: root,
      env: sanitizedEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    assert.equal(exitCode, 0, stderr || "packaged deterministic verifier failed");
    packagedVerifier = JSON.parse(stdout);
    assert.equal(packagedVerifier.schema, "world-capabilities-public-deterministic-check/v1");
  }
  process.stdout.write(`${JSON.stringify({ schema: "world-capabilities-public-deterministic-check/v1", ...receipt, archive: extraction, packagedVerifier }, null, 2)}\n`);
} finally {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true });
}

function sanitizedEnvironment() {
  const env = { ...process.env };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"]) delete env[name];
  return env;
}
function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  if (index + 1 >= process.argv.length) throw new Error(`${flag} requires a value`);
  return process.argv[index + 1];
}
