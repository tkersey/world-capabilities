#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { stableStringify } from "../harness/assertions.mjs";

const options = parseArgs(process.argv.slice(2));
const corpusPath = "packages/research-lookup-fixture/corpus.json";
const manifestPath = "packages/research-lookup-fixture/manifest.json";
const bindingPath = "src/v1/research_lookup_fixture.mjs";
const host = await import(
  pathToFileURL(path.join(options.worldHostRoot, "src/v1/index.mjs")).href
);
const [wasmBytes, manifestBytes] = await Promise.all([
  readFile(options.applicationWasm),
  readFile(options.applicationManifest),
]);
const worker = new host.ApplicationWorker();

try {
  await worker.instantiate(wasmBytes);
  const application = worker.readManifest();
  assert.deepEqual(
    application.encodedBytes,
    manifestBytes,
    "embedded and released application manifests differ",
  );
  assert.equal(application.applicationName, "research-digest-agent");
  assert.equal(application.worldPackageVersion, "2.0.0");
  assert.equal(application.residualEffects.length, 1);

  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const initialArgsBytes = encodeResearchRequest({
    query: corpus.request.query,
    maximumItems: corpus.request.maximumItems,
  });
  const input = host.encodeStepInput(
    {
      applicationId: application.applicationId,
      initialArgsBytes,
      fuel: 10_000n,
    },
    application.limits,
  );
  const output = worker.step(input);
  assert.equal(output.frame.status, host.FrameStatus.needsEffect);
  assert.equal(output.frame.resourceCounters.internalHandlerCalls, 1n);
  const request = output.frame.pendingEffect;
  const applicationId = hex(application.applicationId);
  assert.equal(hex(request.applicationId), applicationId);
  assert.equal(hex(request.interfaceId), corpus.interface.interfaceId);
  assert.equal(hex(request.payloadSchemaId), corpus.interface.payloadSchemaId);
  assert.equal(hex(request.resultSchemaId), corpus.interface.resultSchemaId);
  assert.equal(
    request.authorityRequirements.toString(),
    corpus.interface.authorityRequirements,
  );

  corpus.worldRelease = {
    tag: options.worldTag,
    applicationWasmSha256: sha256(wasmBytes),
    applicationManifestSha256: sha256(manifestBytes),
  };
  corpus.applicationId = applicationId;
  corpus.effectRequestBase64 = Buffer.from(request.encodedBytes).toString(
    "base64",
  );
  await writeFile(corpusPath, `${stableStringify(corpus)}\n`);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const interfaces = manifest.effectProtocolV1?.interfaces;
  assert(Array.isArray(interfaces) && interfaces.length === 1);
  interfaces[0].applicationIds = [applicationId];
  manifest.metadata.worldApplicationRelease = options.worldTag;
  await writeFile(manifestPath, `${stableStringify(manifest)}\n`);

  const binding = await readFile(bindingPath, "utf8");
  const bindingIdentity =
    /(RESEARCH_DIGEST_APPLICATION_ID\s*=\s*\n\s*")([0-9a-f]{64})(";)/;
  const match = bindingIdentity.exec(binding);
  assert(match, "research capability binding application identity is missing");
  const updatedBinding = binding.replace(
    bindingIdentity,
    `$1${applicationId}$3`,
  );
  await writeFile(bindingPath, updatedBinding);

  console.log(`world_release=${options.worldTag}`);
  console.log(`application_id=${applicationId}`);
  console.log(`application_wasm_sha256=${corpus.worldRelease.applicationWasmSha256}`);
  console.log(
    `application_manifest_sha256=${corpus.worldRelease.applicationManifestSha256}`,
  );
  console.log("effect_request_from_released_application=true");
} finally {
  worker.dispose();
}

function encodeResearchRequest(value) {
  const query = Buffer.from(value.query, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(query.length);
  const maximumItems = Buffer.alloc(4);
  maximumItems.writeUInt32LE(value.maximumItems);
  return Buffer.concat([length, query, maximumItems]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function parseArgs(args) {
  const result = {
    applicationManifest: null,
    applicationWasm: null,
    worldHostRoot: null,
    worldTag: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[++index];
    if (!value) throw new Error(`missing value for ${key}`);
    switch (key) {
      case "--application-manifest":
        result.applicationManifest = path.resolve(value);
        break;
      case "--application-wasm":
        result.applicationWasm = path.resolve(value);
        break;
      case "--world-host-root":
        result.worldHostRoot = path.resolve(value);
        break;
      case "--world-tag":
        result.worldTag = value;
        break;
      default:
        throw new Error(`unknown option: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(result)) {
    if (value === null) throw new Error(`${key} is required`);
  }
  return result;
}
