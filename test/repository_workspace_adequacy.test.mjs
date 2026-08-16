import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as workspace from "../packages/repository-workspace-adequacy/adapter.mjs";

const APPLICATION_ID = "7eb84c4aa723014876aa7edf68d0fcbe73915af98cecc98ef382c3ed3c343aaa";
const PATHS = {
  readme: "README.md",
  package: "package.json",
  methods_source: "src/methods.mjs",
  pattern_source: "src/pattern.mjs",
  errors_source: "src/errors.mjs",
  router_source: "src/router.mjs",
  index_source: "src/index.mjs",
  methods_test: "test/methods.test.mjs",
  router_test: "test/router.test.mjs"
};
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("repository workspace adequacy", () => {
  test("enforces all-read baseline, test epochs, four unique slots, and request-bound approval", async () => {
    const { context } = await fixtureContext();
    const listing = await resolve(context, "list", {});
    expect(listing.entries).toHaveLength(9);

    for (const [slot, path] of Object.entries(PATHS)) {
      const result = await resolve(context, "read", { slot, path });
      expect(result.slotCode).toBe(Object.keys(PATHS).indexOf(slot));
    }
    expect(context.readSlots.size).toBe(9);

    await resolve(context, "search", { query: "method_not_allowed", pathPrefix: "" });
    const baseline = await resolve(context, "test", { suite: "default" });
    expect(baseline.passed).toBe(false);
    expect(baseline.output).toContain("--- stderr ---");

    const replacement = await readFile(
      new URL("../packages/router-adequacy-decision-fixture/solution/methods.txt", import.meta.url),
      "utf8"
    );
    const current = await readFile(join(context.workspaceRoot, PATHS.methods_source), "utf8");
    const payload = {
      slot: "methods_source",
      path: PATHS.methods_source,
      expectedSha256: new Bun.CryptoHasher("sha256").update(current).digest("hex"),
      replacement,
      rationale: "Apply the reviewed methods implementation."
    };
    context.fixturePlan = [{
      slot: payload.slot,
      path: payload.path,
      replacementDigest: new Bun.CryptoHasher("sha256").update(replacement).digest("hex")
    }];
    const request = hostRequest("replace", payload);
    const proposalDigest = workspace.proposalDigest(payload);
    context.approval = {
      approved: true,
      requestId: request.requestId,
      proposalDigest,
      mode: "adequacy-fixture-auto"
    };
    context.fixtureRequestDigest = proposalDigest;
    const applied = await workspace.resolve(context, request);
    expect(applied.status).toBe("ok");
    expect(applied.payload.kind).toBe("applied");
    expect(applied.payload.payload.current.slot).toBe("methods_source");
    expect(context.mutationsApplied).toBe(1);

    const repeated = await workspace.resolve(context, request);
    expect(repeated.payload.payload.alreadyApplied).toBe(true);
    expect(context.mutationsApplied).toBe(1);

    const changedAgain = {
      ...payload,
      expectedSha256: new Bun.CryptoHasher("sha256").update(replacement).digest("hex"),
      replacement: `${replacement}\n`
    };
    const changedRequest = hostRequest("replace", changedAgain);
    context.approval = {
      approved: true,
      requestId: changedRequest.requestId,
      proposalDigest: workspace.proposalDigest(changedAgain),
      mode: "interactive"
    };
    const denied = await workspace.resolve(context, changedRequest);
    expect(denied.payload.kind).toBe("denied");
    expect(denied.payload.payload.reason).toBe("second_different_replacement_denied");
  });

  test("rejects slot-path mismatch before filesystem access", async () => {
    const { context } = await fixtureContext();
    const result = await workspace.preflight(context, hostRequest("read", {
      slot: "methods_source",
      path: "src/router.mjs"
    }));
    expect(result.status).toBe("rejected");
    expect(result.payload.reason).toBe("read_slot_path_mismatch");
  });
});

async function fixtureContext() {
  const root = await mkdtemp(join(tmpdir(), "router-adequacy-workspace-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const temporaryHome = join(root, "home");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(workspaceRoot, "test"), { recursive: true });
  for (const [path, contents] of Object.entries(WORKSPACE_FILES)) {
    await writeFile(join(workspaceRoot, path), contents, "utf8");
  }
  await mkdir(temporaryHome);
  return {
    context: {
      applicationId: APPLICATION_ID,
      policy: { repositoryAdequacy: true },
      workspaceRoot,
      workspaceRootReal: await realpath(workspaceRoot),
      bunExecutable: process.execPath,
      temporaryHome,
      fixtureInitialManifestMatched: true
    }
  };
}

const WORKSPACE_FILES = Object.freeze({
  "README.md": "# Router policy workspace test\n",
  "package.json": JSON.stringify({ private: true, type: "module" }),
  "src/methods.mjs": `export function normalizeMethod(value) { return value; }
export function canonicalAllow(methods) { return [...methods]; }
`,
  "src/pattern.mjs": "export function compilePattern(pattern) { return { pattern }; }\n",
  "src/errors.mjs": "export function notFound() { return { kind: \"not_found\" }; }\n",
  "src/router.mjs": "export class Router {}\n",
  "src/index.mjs": "export {}\n",
  "test/methods.test.mjs": `import { expect, test } from "bun:test";
import { normalizeMethod } from "../src/methods.mjs";
test("normalizes methods", () => expect(normalizeMethod("get")).toBe("GET"));
`,
  "test/router.test.mjs": `import { expect, test } from "bun:test";
test("workspace fixture is controlled", () => expect(true).toBe(true));
`
});

async function resolve(context, operation, payload) {
  const outcome = await workspace.resolve(context, hostRequest(operation, payload));
  expect(outcome.status).toBe("ok");
  return outcome.payload;
}

function hostRequest(operation, payload) {
  const names = {
    list: "list",
    read: "read",
    search: "search",
    test: "test",
    replace: "replace-approved"
  };
  return {
    requestId: new Bun.CryptoHasher("sha256").update(JSON.stringify({ operation, payload })).digest("hex"),
    idempotencyKey: "idempotency",
    target: {
      descriptorFingerprint: `desc.repository-${names[operation]}.v2`,
      actuatorRef: `actuator.repository-${names[operation]}.v2`,
      actuationClass: "repository"
    },
    responseSchema: { statuses: ["ok", "rejected", "failed"] },
    payload: { operation, ...payload }
  };
}
