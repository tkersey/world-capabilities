import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack, validateSidecarCommand } from "../harness/pack-utils.mjs";
import { preflight as sidecarPreflight } from "../packages/sidecar-fixture/adapter.mjs";

test("sidecar fixture schema rejection uses an allowed failure status", async () => {
  const result = await sidecarPreflight({}, {
    requestId: "req-sidecar-schema",
    idempotencyKey: "idem-sidecar-schema",
    target: {
      descriptorFingerprint: "desc.sidecar-fixture.v0",
      actuatorRef: "actuator.sidecar-fixture",
      actuationClass: "sidecar"
    },
    responseSchema: { statuses: ["ok", "failed"] },
    payload: {}
  });
  expect(result.status).toBe("failed");
  expect(result.payload.reason).toBe("unsupported_response_schema");
});

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

test("Node sidecar unsupported runtime entrypoints are rejected before artifact binding", async () => {
  for (const ext of [".tsx", ".jsx"]) {
    const pack = await loadPack("sidecar-fixture");
    pack.manifest.metadata.sidecar.command = ["node", `sidecar${ext}`];
    pack.manifest.artifacts.push({ path: `sidecar${ext}`, role: "sidecar" });
    expect(() => validateSidecarCommand(pack)).toThrow(/Node sidecar unsupported runtime entrypoint rejected/);
  }
});

test("parent-directory sidecar entrypoint is rejected before artifact binding", async () => {
  const pack = await loadPack("sidecar-fixture");
  pack.manifest.metadata.sidecar.command = ["bun", "../evil.mjs"];
  pack.manifest.artifacts.push({ path: "../evil.mjs", role: "sidecar" });
  expect(() => validateSidecarCommand(pack)).toThrow(/sidecar entrypoint missing/);
});

test("normalized-away parent-directory sidecar entrypoint is rejected before artifact binding", async () => {
  const pack = await loadPack("sidecar-fixture");
  pack.manifest.metadata.sidecar.command = ["bun", "subdir/../sidecar.mjs"];
  pack.manifest.artifacts.push({ path: "subdir/../sidecar.mjs", role: "sidecar" });
  expect(() => validateSidecarCommand(pack)).toThrow(/sidecar entrypoint missing/);
});

test("adapter path aliases cannot be sidecar entrypoints", async () => {
  const pack = await loadPack("sidecar-fixture");
  pack.manifest.metadata.sidecar.command = ["bun", "./adapter.mjs"];
  pack.manifest.artifacts.push({ path: "./adapter.mjs", role: "sidecar" });
  expect(() => validateSidecarCommand(pack)).toThrow(/sidecar entrypoint missing|sidecar adapter entrypoint rejected/);
});

test("adapter symlink aliases cannot be sidecar entrypoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-validator-alias-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default true;\n");
    await symlink(join(dir, "adapter.mjs"), join(dir, "adapter-link.mjs"));
    expect(() => validateSidecarCommand({
      name: "sidecar-validator-alias-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter-link.mjs", role: "sidecar" }],
        metadata: {
          sidecar: { command: ["bun", "adapter-link.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).toThrow(/sidecar adapter entrypoint rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter hard-link aliases cannot be sidecar entrypoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-validator-hardlink-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default true;\n");
    await link(join(dir, "adapter.mjs"), join(dir, "adapter-hardlink.mjs"));
    expect(() => validateSidecarCommand({
      name: "sidecar-validator-hardlink-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter-hardlink.mjs", role: "sidecar" }],
        metadata: {
          sidecar: { command: ["bun", "adapter-hardlink.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).toThrow(/sidecar adapter entrypoint rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
