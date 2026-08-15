import { describe, expect, test } from "bun:test";

import {
  decodeRepositoryRepairAction,
  encodeRepositoryListResult,
  encodeRepositoryRepairAction,
  encodeRepositoryReplaceOutcome,
  encodeRepositoryTestResult
} from "../src/v1/index.mjs";

describe("repository repair portable codecs", () => {
  test("round-trips every model Action branch through the closed Boundary union", () => {
    const actions = [
      { action: "list_repository", arguments: {} },
      { action: "read_file", arguments: { role: "source", path: "src/range.mjs" } },
      { action: "search_text", arguments: { query: "range", path_prefix: "src" } },
      { action: "run_tests", arguments: { suite: "default" } },
      {
        action: "replace_file",
        arguments: {
          path: "src/range.mjs",
          expected_sha256: "1".repeat(64),
          replacement: "replacement\n",
          rationale: "Fix the defect."
        }
      },
      {
        action: "final",
        arguments: {
          summary: "Done.",
          changed_files: ["src/range.mjs"],
          tests_passed: true,
          final_source_sha256: "2".repeat(64)
        }
      },
      { action: "abort", arguments: "authored_abort" }
    ];
    for (const action of actions) expect(decodeRepositoryRepairAction(encodeRepositoryRepairAction(action))).toEqual(action);
  });

  test("rejects open actions, extra fields, invalid digests, and trailing bytes", () => {
    expect(() => encodeRepositoryRepairAction({ action: "shell", arguments: {} })).toThrow();
    expect(() => encodeRepositoryRepairAction({ action: "read_file", arguments: { role: "source", path: "src/range.mjs", extra: true } })).toThrow();
    expect(() => encodeRepositoryRepairAction({
      action: "replace_file",
      arguments: { path: "src/range.mjs", expected_sha256: "no", replacement: "x", rationale: "x" }
    })).toThrow();
    const encoded = encodeRepositoryRepairAction({ action: "list_repository", arguments: {} });
    expect(() => decodeRepositoryRepairAction(Buffer.concat([encoded, Buffer.from([0])]))).toThrow();
  });

  test("encodes bounded effect outcomes", () => {
    expect(encodeRepositoryListResult({ entries: [{ path: "src/range.mjs", kind: "file" }], truncated: false }).length).toBeGreaterThan(0);
    expect(encodeRepositoryTestResult({
      exitCode: 0,
      passed: true,
      stdout: "pass",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false
    }).length).toBeGreaterThan(0);
    expect(encodeRepositoryReplaceOutcome({
      kind: "applied",
      payload: {
        path: "src/range.mjs",
        oldSha256: "1".repeat(64),
        newSha256: "2".repeat(64),
        alreadyApplied: false
      }
    }).readUInt32LE()).toBe(0);
  });
});
