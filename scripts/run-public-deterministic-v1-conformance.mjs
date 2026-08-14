#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
assert(archive !== null, "--archive is required for executable conformance");
assert(rootArgument === null, "--root is forbidden for executable conformance");
const checksum = valueAfter("--checksum");
assert(checksum !== null, "--checksum is required with --archive");
const temporary = await mkdtemp(path.join(tmpdir(), "world-capabilities-public-conformance-"));
try {
  const root = temporary;
  const archivePath = path.resolve(archive);
  const bytes = await readDistributionArchive(archivePath);
  const expected = parseChecksumSidecar(await readChecksumSidecar(path.resolve(checksum)), path.basename(archivePath));
  assert.equal(sha256(bytes), expected, "release asset checksum mismatch");
  await extractDistributionArchive(archivePath, root, bytes);
  await verifyDistributionTree(root);
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"]) {
    assert(!process.env[name], `${name} must be unset for deterministic conformance`);
  }

  const packUtils = await import(pathToFileURL(path.join(root, "harness/pack-utils.mjs")).href);
  const names = await withCwd(root, () => packUtils.packageNames());
  for (const name of names) {
    await withCwd(root, async () => packUtils.inspectPack(await packUtils.loadPack(name)));
  }

  const proofCommands = [
    [process.execPath, "harness/check-pack.mjs", "--all"],
    [process.execPath, "harness/run-negative.mjs"],
    [process.execPath, "harness/run-sidecar-conformance.mjs"],
    [process.execPath, "harness/redaction-tests.mjs"],
    [process.execPath, "harness/policy-tests.mjs"],
    [process.execPath, "test", "test/effect_protocol_v1.test.mjs", "test/effect_protocol_v1_manifest.test.mjs", "test/research_lookup_fixture.test.mjs", "test/agent_invoke_v1.test.mjs"],
    [process.execPath, "scripts/check-corpus.mjs"],
  ];
  for (const command of proofCommands) await run(root, command);
  const tests = await run(root, [process.execPath, "test"]);
  const receipt = {
    schema: "world-capabilities-public-deterministic-conformance/v1",
    version: "2.1.2",
    inspectedPackCount: names.length,
    staticInspectionImportedAdapters: false,
    deterministicAdaptersExecuted: true,
    policyBeforeEffect: true,
    exactApplicationSchemaAuthorityAdmission: true,
    resultBounds: true,
    forbiddenWorldEvidenceRejected: true,
    frameAuthority: false,
    receiverSecretsRequired: false,
    liveEffectsExecuted: false,
    sourceCheckoutRequired: false,
    proofExitCode: 0,
    testExitCode: tests.exitCode,
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function run(cwd, argv) {
  const child = Bun.spawn(argv, { cwd, env: sanitizedEnvironment(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  assert.equal(exitCode, 0, `${argv.join(" ")} failed\n${stdout}\n${stderr}`);
  return { exitCode, stdout, stderr };
}
async function withCwd(cwd, operation) {
  const previous = process.cwd();
  process.chdir(cwd);
  try { return await operation(); } finally { process.chdir(previous); }
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
