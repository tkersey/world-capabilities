import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importAdapter, loadPack, packageNames } from "../harness/pack-utils.mjs";
import { resolve } from "../packages/generic-http-json/adapter.mjs";
import { dryRun as dryRunHumanApproval, resolve as resolveHumanApproval } from "../packages/human-approval/adapter.mjs";
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

test("human approval rejection fallback does not use deferred for schema errors", async () => {
  const result = await resolveHumanApproval({ policy: { humanLive: true }, approvalMode: "deny" }, {
    requestId: "human-schema-fallback",
    idempotencyKey: "world:idem:human-schema-fallback",
    target: {
      descriptorFingerprint: "desc.human-approval.v0",
      actuatorRef: "actuator.human-approval",
      actuationClass: "approval"
    },
    responseSchema: { statuses: ["ok", "deferred"] },
    payload: { anchor: "world:host-request:1" }
  });
  expect(result.status).toBe("failed");
  expect(result.payload.reason).toBe("unsupported_response_schema");
});

test("human approval unsupported schema fallback is advertised", async () => {
  const result = await resolveHumanApproval({ policy: { humanLive: true }, approvalMode: "deny" }, {
    requestId: "human-schema-failed-fallback",
    idempotencyKey: "world:idem:human-schema-failed-fallback",
    target: {
      descriptorFingerprint: "desc.human-approval.v0",
      actuatorRef: "actuator.human-approval",
      actuationClass: "approval"
    },
    responseSchema: { statuses: ["ok", "failed"] },
    payload: { anchor: "world:host-request:1" }
  });
  expect(result.status).toBe("failed");
  expect(result.payload.reason).toBe("unsupported_response_schema");
});

test("human approval schema errors prefer failed over deferred", async () => {
  const result = await resolveHumanApproval({ policy: { humanLive: true }, approvalMode: "deny" }, {
    requestId: "human-schema-failed-before-deferred",
    idempotencyKey: "world:idem:human-schema-failed-before-deferred",
    target: {
      descriptorFingerprint: "desc.human-approval.v0",
      actuatorRef: "actuator.human-approval",
      actuationClass: "approval"
    },
    responseSchema: { statuses: ["ok", "deferred", "failed"] },
    payload: { anchor: "world:host-request:1" }
  });
  expect(result.status).toBe("failed");
  expect(result.payload.reason).toBe("unsupported_response_schema");
});

test("human approval dry-run validation failures do not look deferred", async () => {
  const result = await dryRunHumanApproval({ policy: { humanLive: true }, approvalMode: "deny" }, {
    requestId: "human-dry-run-failure-status",
    idempotencyKey: "world:idem:human-dry-run-failure-status",
    target: {
      descriptorFingerprint: "desc.human-approval.v0",
      actuatorRef: "actuator.human-approval",
      actuationClass: "approval"
    },
    responseSchema: { statuses: ["deferred", "failed"] },
    payload: { anchor: "not-a-world-anchor" }
  });
  expect(result.status).toBe("failed");
  expect(result.payload.reason).toBe("missing_world_host_request_anchor");
});

test("human approval dry-run requires a failure status for validation failures", async () => {
  const result = await dryRunHumanApproval({ policy: { humanLive: true }, approvalMode: "deny" }, {
    requestId: "human-dry-run-failure-schema",
    idempotencyKey: "world:idem:human-dry-run-failure-schema",
    target: {
      descriptorFingerprint: "desc.human-approval.v0",
      actuatorRef: "actuator.human-approval",
      actuationClass: "approval"
    },
    responseSchema: { statuses: ["deferred"] },
    payload: { anchor: "world:host-request:1" }
  });
  expect(result.status).toBe("failed");
  expect(result.payload.reason).toBe("unsupported_response_schema");
});

test("human approval dry-run returns structured errors for missing requests", async () => {
  const result = await dryRunHumanApproval({ policy: { humanLive: true }, approvalMode: "deny" }, null);
  expect(result.status).toBe("failed");
  expect(result.payload.reason).toBe("missing_request_id");
});

test("human approval resolve does not require dry-run-only statuses", async () => {
  const request = {
    requestId: "human-resolve-schema",
    idempotencyKey: "world:idem:human-resolve-schema",
    target: {
      descriptorFingerprint: "desc.human-approval.v0",
      actuatorRef: "actuator.human-approval",
      actuationClass: "approval"
    },
    responseSchema: { statuses: ["ok", "rejected"] },
    payload: { anchor: "world:host-request:1" }
  };

  const allowed = await resolveHumanApproval({ policy: { humanLive: true }, approvalMode: "allow" }, request);
  expect(allowed.status).toBe("ok");
  expect(allowed.payload).toEqual({ approved: true });

  const denied = await resolveHumanApproval({ policy: { humanLive: true }, approvalMode: "deny" }, request);
  expect(denied.status).toBe("rejected");
  expect(denied.payload).toEqual({ approved: false });
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

test("missing sandbox reads fail before effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-file-missing-read-"));
  try {
    const context = { fixtureRoot: root, effectAttempted: 0 };
    const result = await resolveFile(context, fileRequest({
      payload: { operation: "read", path: "missing.txt" }
    }));
    expect(result.payload.reason).toBe("file_read_target_missing");
    expect(context.effectAttempted).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox directory reads fail before effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-file-directory-read-"));
  try {
    await mkdir(join(root, "directory"));
    const context = { fixtureRoot: root, effectAttempted: 0 };
    const result = await resolveFile(context, fileRequest({
      payload: { operation: "read", path: "directory" }
    }));
    expect(result.payload.reason).toBe("file_read_target_not_file");
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
  if (name === "research-lookup-fixture") {
    return { query: "portable algebraic effects", maximumItems: 2 };
  }
  if (name === "repository-repair-decision-fixture" || name === "repository-repair-openai") {
    return {
      contractDigest: "dddc4713e9cb478afc7beef464f35374fdb9aeb1b59d9307edc43438c1e192b5",
      phase: "decide",
      context: {}
    };
  }
  if (name === "router-adequacy-decision-fixture" || name === "router-adequacy-openai") {
    return {
      contractDigest: "a649bded9c3088cb82d13eaf10c6ca3a6a404e66b735e7118d94d00f63303fd2",
      goal: { task: "Upgrade router policy.", repository: "fixture" },
      counters: { turns: 0, decisions: 0, effectActions: 0, childActions: 0 },
      phase: "decide",
      context: {
        listing: null,
        documents: [],
        latestSearch: null,
        latestTest: null,
        latestReplace: null,
        mutations: [],
        evidence: {
          baselineFailureObserved: false,
          latestTestPassed: false,
          mutationCount: 0,
          lastTestMutationCount: 0,
          testCount: 0
        }
      },
      strategyLocal: {}
    };
  }
  if (name === "repository-workspace-adequacy") return { operation: "list" };
  if (name === "repository-workspace-actuality") return { operation: "list" };
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
        policy: {
          live: true,
          networkLive: true,
          fileWrite: true,
          humanLive: true,
          researchLookup: true
        },
        approvalMode: "allow",
        fixtureRoot: root,
        effectAttempted: 0
      };
      if (name === "repository-repair-decision-fixture") {
        context.applicationId = "2ed225966c6a42ad4ded0501a94e37b239d9ff4b1a3817d1e3b9097038ff7d72";
        context.policy.repositoryRepairDecisionFixture = true;
      }
      if (name === "repository-repair-openai") {
        context.applicationId = "2ed225966c6a42ad4ded0501a94e37b239d9ff4b1a3817d1e3b9097038ff7d72";
        context.policy.openaiRepositoryRepair = true;
        context.secrets = { OPENAI_API_KEY: "fixture-secret" };
        context.openaiModel = "fixture-model";
        context.decisionContractDigest = "dddc4713e9cb478afc7beef464f35374fdb9aeb1b59d9307edc43438c1e192b5";
        context.fetchImplementation = async () => { throw new Error("preflight_must_not_fetch"); };
      }
      if (name === "repository-workspace-actuality") {
        context.applicationId = "2ed225966c6a42ad4ded0501a94e37b239d9ff4b1a3817d1e3b9097038ff7d72";
        context.policy.repositoryActuality = true;
        context.workspaceRoot = root;
        context.workspaceRootReal = await realpath(root);
        context.temporaryHome = root;
        context.bunExecutable = process.execPath;
      }
      if (name === "router-adequacy-decision-fixture") {
        context.applicationId = "6f26bd0ac8bd4351f4263c2f64fb68db5459d5b25f8f7ac2d060f40fea7c063c";
        context.policy.routerAdequacyDecisionFixture = true;
      }
      if (name === "router-adequacy-openai") {
        context.applicationId = "6f26bd0ac8bd4351f4263c2f64fb68db5459d5b25f8f7ac2d060f40fea7c063c";
        context.policy.openaiRouterAdequacy = true;
        context.secrets = { OPENAI_API_KEY: "fixture-secret" };
        context.openaiModel = "fixture-model";
        context.decisionContractDigest = "a649bded9c3088cb82d13eaf10c6ca3a6a404e66b735e7118d94d00f63303fd2";
        context.fetchImplementation = async () => { throw new Error("preflight_must_not_fetch"); };
      }
      if (name === "repository-workspace-adequacy") {
        context.applicationId = "6f26bd0ac8bd4351f4263c2f64fb68db5459d5b25f8f7ac2d060f40fea7c063c";
        context.policy.repositoryAdequacy = true;
        context.workspaceRoot = root;
        context.workspaceRootReal = await realpath(root);
        context.temporaryHome = root;
        context.bunExecutable = process.execPath;
      }
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
      expect(supersetSchema.status, name).toBe("ok");

      const operationSchema = await adapter.preflight(context, {
        ...request,
        responseSchema: { statuses: ["ok", "rejected"] }
      });
      expect(operationSchema.status).toBe("ok");

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
