#!/usr/bin/env bun
import { assert } from "./assertions.mjs";
import { loadPack, packageNames, verifyPack, expectedPackFingerprint } from "./pack-utils.mjs";

async function expectNegativePackRejected() {
  try {
    const pack = await loadPack("negative-pack", "examples");
    await verifyPack(pack);
  } catch (error) {
    return String(error.message);
  }
  throw new Error("examples/negative-pack unexpectedly passed pack verification");
}

async function main() {
  const all = process.argv.includes("--all");
  const names = all ? await packageNames() : process.argv.slice(2);
  assert(names.length > 0, "no packages selected");
  for (const name of names) {
    const pack = await loadPack(name);
    await verifyPack(pack);
    const expected = await expectedPackFingerprint(pack);
    assert(pack.manifest.packFingerprint === expected, `${name}: pack fingerprint mismatch`);
  }
  if (all) await expectNegativePackRejected();
  console.log(`checked ${names.length} capability packs`);
}

export async function checkAllPacks() {
  const names = await packageNames();
  for (const name of names) {
    const pack = await loadPack(name);
    await verifyPack(pack);
    const expected = await expectedPackFingerprint(pack);
    assert(pack.manifest.packFingerprint === expected, `${name}: pack fingerprint mismatch`);
  }
  await expectNegativePackRejected();
  return names.length;
}

if (import.meta.main) await main();
