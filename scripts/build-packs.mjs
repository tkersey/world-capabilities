#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify } from "../harness/assertions.mjs";
import { corpusFingerprint } from "../harness/corpus-utils.mjs";
import { expectedPackFingerprint, loadPack, packageNames, sha256Bytes } from "../harness/pack-utils.mjs";

const corpus = await corpusFingerprint();

for (const name of await packageNames()) {
  const dir = join("packages", name);
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
  const pack = await loadPack(name);
  pack.manifest.packFingerprint = await expectedPackFingerprint(pack);
  await writeFile(join(dir, "manifest.json"), `${stableStringify(pack.manifest)}\n`);
  console.log(`built ${name}`);
}
