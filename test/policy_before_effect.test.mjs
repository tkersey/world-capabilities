import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importAdapter, loadPack, packageNames } from "../harness/pack-utils.mjs";
import { resolve } from "../packages/generic-http-json/adapter.mjs";
import { dryRun as dryRunFile, resolve as resolveFile } from "../packages/sandbox-files/adapter.mjs";

test("missing idempotency key prevents effect", async () => {
  const context = { policy: { live: true }, effectAttempted: 0 };
  const result = await resolve(context, {
    requestId: "test",
    target: { descriptorFingerprint: "desc.generic-http-json.v0" },
    responseSchema: { statuses: ["ok", "rejected", "failed"] },
    payload: { url: "https://example.invalid", method: "GET" }
  });
  expect(result.status).toBe("rejected");
  expect(context.effectAttempted).toBe(0);
});

function fileRequest(overrides = {}) {
  return {
    requestId: "file-policy",
    idempotencyKey: "world:idem:file-policy",
    target: {
      descriptorFingerprint: "desc.sandbox-files.v0",
      actuatorRef: "actuator.sandbox-files",
      actuationClass: "file"
    },
    responseSchema: { statuses: ["ok", "rejected", "failed"] },
    payload: { operation: "read", path: "fixture.txt" },
    ...overrides
  };
}

test("unsupported file operations do not count as effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-file-op-"));
  try {
    const context = { fixtureRoot: root, policy: { fileWrite: true }, effectAttempted: 0 };
    const result = await resolveFile(context, fileRequest({
      payload: { operation: "delete", path: "fixture.txt" }
    }));
    expect(result.payload.reason).toBe("unsupported_file_operation");
    expect(context.effectAttempted).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox dry run applies pre-effect validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-file-dry-run-"));
  try {
    const result = await dryRunFile({ fixtureRoot: root }, fileRequest({ idempotencyKey: undefined }));
    expect(result.payload.reason).toBe("missing_idempotency_key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox write dry run does not require file write policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-file-dry-run-write-"));
  try {
    const context = { fixtureRoot: root, policy: {}, effectAttempted: 0 };
    const result = await dryRunFile(context, fileRequest({
      payload: { operation: "write", path: "would-write.txt", bytes: "dry" }
    }));
    expect(result.status).toBe("ok");
    expect(result.payload).toEqual({ wouldTouch: "would-write.txt", effect: false });
    expect(context.effectAttempted).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox write dry run does not require write approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-file-dry-run-approval-"));
  try {
    const context = { fixtureRoot: root, policy: { approvalRequired: true }, effectAttempted: 0 };
    const result = await dryRunFile(context, fileRequest({
      payload: { operation: "write", path: "approval-write.txt", bytes: "dry" }
    }));
    expect(result.status).toBe("ok");
    expect(result.payload).toEqual({ wouldTouch: "approval-write.txt", effect: false });
    expect(context.effectAttempted).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlink ancestors cannot escape the fixture root", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-file-root-"));
  const fixtureRoot = join(root, "fixture");
  const escapeRoot = join(root, "fixture-escape");
  try {
    await mkdir(fixtureRoot);
    await mkdir(escapeRoot);
    await writeFile(join(escapeRoot, "pwn.txt"), "outside");
    await symlink(escapeRoot, join(fixtureRoot, "link"));
    const context = { fixtureRoot, effectAttempted: 0 };
    const result = await resolveFile(context, fileRequest({
      payload: { operation: "read", path: "link/pwn.txt" }
    }));
    expect(result.payload.reason).toBe("symlink_ancestor_rejected");
    expect(context.effectAttempted).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox paths allow in-root dot-dot-prefixed names", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-file-dotdot-prefix-"));
  try {
    const fixtureRoot = join(root, "fixture");
    const cacheDir = join(fixtureRoot, "..cache");
    await mkdir(fixtureRoot);
    await mkdir(cacheDir);
    await writeFile(join(cacheDir, "fixture.txt"), "inside");
    const context = { fixtureRoot, effectAttempted: 0 };
    const result = await resolveFile(context, fileRequest({
      payload: { operation: "read", path: "..cache/fixture.txt" }
    }));
    expect(result.status).toBe("ok");
    expect(result.payload.bytes).toBe("inside");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write authority is checked before filesystem path probing", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-file-write-policy-"));
  const fixtureRoot = join(root, "fixture");
  const escapeRoot = join(root, "fixture-escape");
  try {
    await mkdir(fixtureRoot);
    await mkdir(escapeRoot);
    await symlink(escapeRoot, join(fixtureRoot, "link"));
    const context = { fixtureRoot, policy: {}, effectAttempted: 0 };
    const result = await resolveFile(context, fileRequest({
      payload: { operation: "write", path: "link/pwn.txt", bytes: "outside" }
    }));
    expect(result.payload.reason).toBe("write_policy_required");
    expect(context.effectAttempted).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function payloadFor(name) {
  if (name === "fixture-model") return { prompt: "choose fixture action" };
  if (name === "generic-http-json") return { url: "https://example.invalid/fixture", method: "GET" };
  if (name === "human-approval") return { anchor: "world:host-request:1" };
  if (name === "local-memory-kv") return { operation: "put", key: "k", value: "v" };
  if (name === "sandbox-files") return { operation: "read", path: "fixture.txt" };
  return { fixture: true };
}

test("all adapters reject unsupported targets and status sets before effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-cross-pack-policy-"));
  try {
    await writeFile(join(root, "fixture.txt"), "fixture");
    for (const name of await packageNames()) {
      const pack = await loadPack(name);
      const adapter = await importAdapter(pack.dir);
      const request = {
        requestId: `cross-pack-${name}`,
        idempotencyKey: `world:idem:${name}`,
        target: {
          descriptorFingerprint: pack.manifest.supportedDescriptorFingerprints[0],
          actuatorRef: pack.manifest.supportedActuatorRefs[0],
          actuationClass: pack.manifest.supportedActuationClasses[0]
        },
        responseSchema: { statuses: pack.manifest.supportedResponseStatuses },
        payload: payloadFor(name)
      };
      const context = {
        packageName: pack.manifest.packageName,
        policy: { live: true, networkLive: true, fileWrite: true, humanLive: true },
        approvalMode: "allow",
        fixtureRoot: root,
        effectAttempted: 0
      };
      const wrongTarget = await adapter.resolve(context, {
        ...request,
        target: { ...request.target, descriptorFingerprint: "desc.unsupported.v0" }
      });
      expect(wrongTarget.status).not.toBe("ok");
      expect(wrongTarget.payload.reason).toBe("unsupported_descriptor_fingerprint");
      expect(context.effectAttempted).toBe(0);
      expect(context.kv).toBeUndefined();

      const schemaContext = { ...context, effectAttempted: 0, kv: undefined };
      const wrongSchema = await adapter.resolve(schemaContext, {
        ...request,
        responseSchema: { statuses: ["accepted"] }
      });
      expect(wrongSchema.status).not.toBe("ok");
      expect(wrongSchema.payload.reason).toBe("unsupported_response_schema");
      expect(schemaContext.effectAttempted).toBe(0);
      expect(schemaContext.kv).toBeUndefined();

      const supersetSchema = await adapter.preflight(context, {
        ...request,
        responseSchema: { statuses: [...pack.manifest.supportedResponseStatuses, "extra-compatible-status"] }
      });
      expect(supersetSchema.status).toBe("ok");

      const deniedContext = {
        ...context,
        policy: { ...context.policy, denyPackages: [pack.manifest.packageName] },
        effectAttempted: 0,
        kv: undefined
      };
      const denied = await adapter.resolve(deniedContext, request);
      expect(denied.status).not.toBe("ok");
      expect(denied.payload.reason).toBe("package_denied");
      expect(deniedContext.effectAttempted).toBe(0);
      expect(deniedContext.kv).toBeUndefined();

      const hostileDenied = await adapter.resolve({ ...deniedContext, effectAttempted: 0, kv: undefined }, {
        ...request,
        payload: { ...request.payload, worldAuthoredEvidence: true }
      });
      expect(hostileDenied.status).not.toBe("ok");
      expect(hostileDenied.payload.reason).toBe("package_denied");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
