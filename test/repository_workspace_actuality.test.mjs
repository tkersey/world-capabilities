import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import * as workspace from "../packages/repository-workspace-actuality/adapter.mjs";
import workspaceManifest from "../packages/repository-workspace-actuality/manifest.json" with { type: "json" };
import { repositoryWorkspaceBindings } from "../src/v1/actuality/repository_workspace_binding.mjs";

const APPLICATION_ID = "2ed225966c6a42ad4ded0501a94e37b239d9ff4b1a3817d1e3b9097038ff7d72";
const INTERPRETATION_APPLICATION_ID = "b2e6628424ed95648a554ab5730566476360de86c9534a375357ba152031cf4c";
const INITIAL_SOURCE = `export function normalizeRange(start, end) {
  if (start > end) {
    return { start, end };
  }
  return { start: end, end: start };
}
`;
const CORRECTED_SOURCE = `export function normalizeRange(start, end) {
  if (start <= end) {
    return { start, end };
  }
  return { start: end, end: start };
}
`;
const TEST_SOURCE = `import { describe, expect, test } from "bun:test";
import { normalizeRange } from "../src/range.mjs";
describe("normalizeRange", () => {
  test("ascending", () => expect(normalizeRange(1, 3)).toEqual({ start: 1, end: 3 }));
  test("descending", () => expect(normalizeRange(3, 1)).toEqual({ start: 1, end: 3 }));
  test("equal", () => expect(normalizeRange(2, 2)).toEqual({ start: 2, end: 2 }));
  test("negative", () => expect(normalizeRange(-1, -5)).toEqual({ start: -5, end: -1 }));
});
`;

const temporaryRoots = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("repository workspace actuality", () => {
  test("admits the existing and Boundary 1.6 application identities only", async () => {
    expect(workspace.ADMITTED_APPLICATION_IDS).toEqual([
      APPLICATION_ID,
      INTERPRETATION_APPLICATION_ID
    ]);
    for (const effect of workspaceManifest.effectProtocolV1.interfaces) {
      expect(effect.applicationIds).toEqual(workspace.ADMITTED_APPLICATION_IDS);
    }
    for (const binding of repositoryWorkspaceBindings()) {
      expect(binding.applicationIds.map((id) => id.toString("hex")))
        .toEqual(workspace.ADMITTED_APPLICATION_IDS);
    }

    const context = await fixtureContext();
    for (const applicationId of workspace.ADMITTED_APPLICATION_IDS) {
      context.applicationId = applicationId;
      expect((await workspace.preflight(context, request("list", {}))).status).toBe("ok");
    }
    context.applicationId = "0".repeat(64);
    expect((await workspace.preflight(context, request("list", {}))).payload.reason)
      .toBe("application_not_admitted");
  });

  test("observes failure, requires request-bound approval, mutates once, then passes", async () => {
    const context = await fixtureContext();

    const listing = await workspace.resolve(context, request("list", {}));
    expect(listing.status).toBe("ok");
    expect(listing.payload.entries.map((entry) => entry.path)).toEqual([
      "README.md",
      "package.json",
      "src/range.mjs",
      "test/range.test.mjs"
    ]);
    expect(listing.payload.truncated).toBe(false);

    const read = await workspace.resolve(context, request("read", { role: "source", path: "src/range.mjs" }));
    expect(read.status).toBe("ok");
    expect(read.payload.contents).toBe(INITIAL_SOURCE);

    const search = await workspace.resolve(context, request("search", {
      query: "normalizeRange",
      pathPrefix: "src"
    }));
    expect(search.status).toBe("ok");
    expect(search.payload.hits).toHaveLength(1);
    expect(search.payload.hits[0].line).toBe(1);

    const before = await workspace.resolve(context, request("test", { suite: "default" }));
    expect(before.status).toBe("ok");
    expect(before.payload.passed).toBe(false);
    expect(before.payload.stderr).not.toContain(context.workspaceRootReal);
    expect(before.payload.stderr).not.toMatch(/\[\d+(?:\.\d+)?ms\]/);
    expect(context.preMutationTestFailed).toBe(true);

    const replacePayload = {
      path: "src/range.mjs",
      expectedSha256: read.payload.sha256,
      replacement: CORRECTED_SOURCE,
      rationale: "Swap descending bounds only."
    };
    const replaceRequest = request("replace", replacePayload);
    const proposalDigest = workspace.proposalDigest(replaceRequest.payload);

    const denied = await workspace.preflight(context, replaceRequest);
    expect(denied.status).toBe("rejected");
    expect(denied.payload.reason).toBe("approval_required");

    context.fixtureRequestDigest = proposalDigest;
    context.approval = {
      approved: true,
      requestId: replaceRequest.requestId,
      proposalDigest,
      mode: "fixture-auto"
    };
    const replaced = await workspace.resolve(context, replaceRequest);
    expect(replaced.status).toBe("ok");
    expect(replaced.payload.kind).toBe("applied");
    expect(replaced.payload.payload.alreadyApplied).toBe(false);
    expect(context.mutationsApplied).toBe(1);

    const duplicate = await workspace.resolve(context, replaceRequest);
    expect(duplicate.payload.payload.alreadyApplied).toBe(true);
    expect(context.mutationsApplied).toBe(1);
    expect(await readFile(join(context.workspaceRoot, "src/range.mjs"), "utf8")).toBe(CORRECTED_SOURCE);

    const after = await workspace.resolve(context, request("test", { suite: "default" }));
    expect(after.status).toBe("ok");
    expect(after.payload.passed).toBe(true);
  });

  test("canonicalizes every Bun duration unit from typed test results", async () => {
    const context = await fixtureContext();
    const executable = join(context.workspaceRoot, "fixture-bun");
    await writeFile(executable, `#!/bin/sh
printf 'first [1.20s]\\nsecond [250µs]\\nthird [9us]\\nfourth [7ns]\\nfifth [3ms]\\nsemantic [4ms] remains\\n'
printf 'stderr [2s]\\nsemantic stderr [8ms] remains\\n' >&2
exit 1
`, { mode: 0o755 });
    context.bunExecutable = executable;

    const result = await workspace.resolve(context, request("test", { suite: "default" }));
    expect(result.status).toBe("ok");
    expect(result.payload.stdout).toBe(
      "first\nsecond\nthird\nfourth\nfifth\nsemantic [4ms] remains\n"
    );
    expect(result.payload.stderr).toBe("stderr\nsemantic stderr [8ms] remains\n");
    expect(result.payload.passed).toBe(false);
  });

  test("canonicalizes workspace paths before enforcing the process byte ceiling", async () => {
    const context = await fixtureContext();
    const executable = join(context.workspaceRoot, "fixture-bun");
    await writeFile(executable, `#!/bin/sh
root=${JSON.stringify(context.workspaceRoot)}
i=0
while [ "$i" -lt 600 ]; do
  printf '%s' "$root"
  i=$((i + 1))
done
printf '\\n'
exit 1
`, { mode: 0o755 });
    context.bunExecutable = executable;

    const result = await workspace.resolve(context, request("test", { suite: "default" }));
    const canonical = `${"<workspace>".repeat(600)}\n`;
    expect(result.status).toBe("ok");
    expect(result.payload.stdout).toBe(canonical.slice(0, 4096));
    expect(result.payload.stdoutTruncated).toBe(true);
    expect(result.payload.stdout).not.toContain(context.workspaceRoot);
  });

  test("canonicalizes only absolute workspace aliases without rewriting its marker", async () => {
    const context = await fixtureContext();
    const absoluteRoot = context.workspaceRoot;
    const executable = join(absoluteRoot, "fixture-bun");
    await writeFile(executable, `#!/bin/sh
printf '%s\n' ${JSON.stringify(absoluteRoot)}
printf '<workspace>\nworkspace\n'
exit 1
`, { mode: 0o755 });
    context.workspaceRoot = relative(process.cwd(), absoluteRoot);
    context.bunExecutable = executable;

    const result = await workspace.resolve(context, request("test", { suite: "default" }));
    expect(result.status).toBe("ok");
    expect(result.payload.stdout).toBe("<workspace>\n<workspace>\nworkspace\n");
  });

  test("enforces the byte ceiling after removing Bun duration suffixes", async () => {
    const context = await fixtureContext("/tmp/wc-actuality-");
    const executable = join(context.workspaceRoot, "fixture-bun");
    await writeFile(executable, `#!/bin/sh
i=0
while [ "$i" -lt 3000 ]; do
  printf ' [1ms]\\n'
  i=$((i + 1))
done
printf 'late diagnostic\\n'
exit 1
`, { mode: 0o755 });
    context.bunExecutable = executable;

    const result = await workspace.resolve(context, request("test", { suite: "default" }));
    expect(result.status).toBe("ok");
    expect(result.payload.stdout).toBe(`${"\n".repeat(3000)}late diagnostic\n`);
    expect(result.payload.stdoutTruncated).toBe(false);
  });

  test("rejects traversal, metadata writes, stale approval, and stale digests before writing", async () => {
    const context = await fixtureContext();
    expect((await workspace.preflight(context, request("read", { role: "source", path: "src/../secret" }))).payload.reason)
      .toBe("path_not_normalized");
    expect((await workspace.preflight(context, request("read", { role: "test", path: "src/range.mjs" }))).payload.reason)
      .toBe("read_role_path_mismatch");

    const metadata = request("replace", {
      path: "package.json",
      expectedSha256: "0".repeat(64),
      replacement: "{}\n",
      rationale: "not admitted"
    });
    expect((await workspace.preflight(context, metadata)).payload.reason).toBe("write_path_not_admitted");

    context.preMutationTestFailed = true;
    const replacement = request("replace", {
      path: "src/range.mjs",
      expectedSha256: "0".repeat(64),
      replacement: CORRECTED_SOURCE,
      rationale: "stale"
    });
    const digest = workspace.proposalDigest(replacement.payload);
    context.approval = { approved: true, requestId: "another", proposalDigest: digest, mode: "interactive" };
    expect((await workspace.preflight(context, replacement)).payload.reason).toBe("approval_request_mismatch");

    context.approval.requestId = replacement.requestId;
    const conflict = await workspace.resolve(context, replacement);
    expect(conflict.status).toBe("ok");
    expect(conflict.payload.kind).toBe("conflict");
    expect(await readFile(join(context.workspaceRoot, "src/range.mjs"), "utf8")).toBe(INITIAL_SOURCE);
  });
});

async function fixtureContext(prefix = join(tmpdir(), "agent-actuality-workspace-")) {
  const root = await mkdtemp(prefix);
  temporaryRoots.push(root);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "test"));
  await mkdir(join(root, "home"));
  await writeFile(join(root, "README.md"), "# Fixture\n");
  await writeFile(join(root, "package.json"), '{"name":"fixture","private":true,"type":"module"}\n');
  await writeFile(join(root, "src/range.mjs"), INITIAL_SOURCE);
  await writeFile(join(root, "test/range.test.mjs"), TEST_SOURCE);
  return {
    applicationId: APPLICATION_ID,
    workspaceRoot: root,
    workspaceRootReal: await realpath(root),
    temporaryHome: join(root, "home"),
    bunExecutable: process.execPath,
    fixtureInitialManifestMatched: true,
    policy: { repositoryActuality: true }
  };
}

function request(operation, payload) {
  const suffix = Math.random().toString(16).slice(2);
  return {
    requestId: `request-${operation}-${suffix}`,
    idempotencyKey: `idempotency-${operation}-${suffix}`,
    target: {
      descriptorFingerprint: `desc.repository-${operation === "replace" ? "replace-approved" : operation}.v1`,
      actuatorRef: `actuator.repository-${operation === "replace" ? "replace-approved" : operation}.v1`,
      actuationClass: "repository"
    },
    responseSchema: { statuses: ["ok", "rejected", "failed"] },
    payload: { operation, ...payload }
  };
}
