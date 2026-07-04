import { expect, test } from "bun:test";
import { loadPack, verifyPack, verifySelfContained } from "../harness/pack-utils.mjs";

test("negative pack is rejected", async () => {
  await expect(verifyPack(await loadPack("negative-pack", "examples"))).rejects.toThrow();
});

test("sidecar fixture imports are checksum covered", async () => {
  await verifySelfContained(await loadPack("sidecar-fixture"));
});
