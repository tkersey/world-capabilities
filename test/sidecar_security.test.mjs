import { expect, test } from "bun:test";
import { loadPack, validateSidecarCommand } from "../harness/pack-utils.mjs";

test("remote sidecar entrypoint is rejected", async () => {
  const pack = await loadPack("sidecar-fixture");
  pack.manifest.metadata.sidecar.command = ["bun", "https://example.invalid/sidecar.mjs"];
  expect(() => validateSidecarCommand(pack)).toThrow();
});
