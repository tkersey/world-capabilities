#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify } from "../harness/assertions.mjs";
import { corpusFingerprint } from "../harness/corpus-utils.mjs";
import { expectedPackFingerprint, loadPack, packageNames, sha256Bytes } from "../harness/pack-utils.mjs";

export async function buildPack(name, {
  root = "packages",
  globalCorpusFingerprint
} = {}) {
  const corpus = globalCorpusFingerprint ?? await corpusFingerprint();
  const dir = join(root, name);
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const conformance = JSON.parse(await readFile(join(dir, "conformance.json"), "utf8"));
  const checksums = {};
  for (const artifact of manifest.artifacts) {
    checksums[artifact.path] = sha256Bytes(await readFile(join(dir, artifact.path)));
  }
  manifest.checksums = checksums;
  manifest.conformanceCorpusFingerprint = corpus;
  conformance.driverId = manifest.driverId;
  conformance.corpusFingerprint = corpus;
  await writeFile(join(dir, "checksums.sha256"), Object.entries(checksums).map(([path, hash]) => `${hash}  ${path}`).join("\n") + "\n");
  await writeFile(join(dir, "conformance.json"), `${stableStringify(conformance)}\n`);
  await writeFile(join(dir, "manifest.json"), `${stableStringify(manifest)}\n`);
  const pack = await loadPack(name, root);
  pack.manifest.packFingerprint = await expectedPackFingerprint(pack);
  await writeFile(join(dir, "manifest.json"), `${stableStringify(pack.manifest)}\n`);
  await refreshConformanceReceipt(pack, corpus);
}

async function refreshConformanceReceipt(pack, globalCorpusFingerprint) {
  const path = join(pack.dir, "conformance-receipt.json");
  let receipt;
  try {
    receipt = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  const corpusArtifact = pack.manifest.artifacts.find(
    (artifact) => artifact.role === "conformance-corpus"
  );
  if (!corpusArtifact || !pack.manifest.checksums[corpusArtifact.path]) {
    throw new Error(`${pack.name}: conformance receipt requires a checksummed conformance corpus`);
  }

  receipt.packFingerprint = pack.manifest.packFingerprint;
  receipt.corpusFingerprint = pack.manifest.checksums[corpusArtifact.path];
  receipt.globalConformanceCorpusFingerprint = globalCorpusFingerprint;
  receipt.vectors = pack.conformance.vectors.map((vector) => vector.id);
  receipt.receiptFingerprint = "";
  receipt.receiptFingerprint = createHash("sha256")
    .update("world.effect-v1-conformance-receipt.v1")
    .update(Buffer.from([0]))
    .update(stableStringify(receipt))
    .digest("hex");
  await writeFile(path, `${stableStringify(receipt)}\n`);
}

if (import.meta.main) {
  const corpus = await corpusFingerprint();
  for (const name of await packageNames()) {
    await buildPack(name, { globalCorpusFingerprint: corpus });
    console.log(`built ${name}`);
  }
}
