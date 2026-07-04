#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listFiles, readJson } from "./corpus-utils.mjs";
import { assert } from "./assertions.mjs";
import { assertNoForbiddenEvidence, importAdapter, loadPack, packageNames } from "./pack-utils.mjs";

async function negativeFixtures() {
  return (await listFiles("corpus/negative")).filter((file) => file.endsWith(".json"));
}

async function loadFixture(path) {
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text);
  return parsed.hostRequest ?? parsed;
}

for (const name of await packageNames()) {
  const pack = await loadPack(name);
  const adapter = await importAdapter(pack.dir);
  for (const fixturePath of await negativeFixtures()) {
    const context = { packageName: pack.manifest.packageName, policy: { auditOnly: true }, effectAttempted: 0 };
    const result = await adapter.resolve(context, await loadFixture(fixturePath));
    assertNoForbiddenEvidence(result, `${name} ${fixturePath}`);
    assert(["rejected", "failed", "deferred"].includes(result.status), `${name}: negative fixture ${fixturePath} was not rejected/failed/deferred`);
    assert(context.effectAttempted === 0, `${name}: effect attempted for ${fixturePath}`);
  }
}

const forbidden = await readJson(join("corpus", "negative", "forbidden-world-evidence.json"));
assert(forbidden.hostRequest.payload.worldAuthoredEvidence, "forbidden evidence fixture missing hostile key");
console.log("negative corpus passed");
