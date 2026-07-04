import { test } from "bun:test";
import { loadPack, packageNames, verifyPack } from "../harness/pack-utils.mjs";

test("all package manifests verify", async () => {
  for (const name of await packageNames()) await verifyPack(await loadPack(name));
});
