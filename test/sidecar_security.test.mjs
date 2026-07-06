import { expect, test } from "bun:test";
import { loadPack, validateSidecarCommand } from "../harness/pack-utils.mjs";

test("remote sidecar entrypoint is rejected", async () => {
  const pack = await loadPack("sidecar-fixture");
  pack.manifest.metadata.sidecar.command = ["bun", "https://example.invalid/sidecar.mjs"];
  expect(() => validateSidecarCommand(pack)).toThrow();
});

test("package-scheme sidecar entrypoint is rejected before artifact binding", async () => {
  const pack = await loadPack("sidecar-fixture");
  pack.manifest.metadata.sidecar.command = ["deno", "run", "npm:pkg/mod.mjs"];
  pack.manifest.artifacts.push({ path: "npm:pkg/mod.mjs", role: "sidecar" });
  expect(() => validateSidecarCommand(pack)).toThrow(/sidecar entrypoint missing/);
});
