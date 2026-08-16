import { describe, expect, test } from "bun:test";

import {
  decodeAction,
  encodeAction,
  encodeListResult,
  encodeReadResult,
  encodeReplaceOutcome,
  encodeTestResult
} from "../src/v1/adequacy/router_adequacy_codecs.mjs";

describe("router adequacy portable codecs", () => {
  test("round-trips every model Action branch through the closed Boundary union", () => {
    const actions = [
      { action: "list_repository", arguments: {} },
      { action: "read_file", arguments: { slot: "methods_source", path: "src/methods.mjs" } },
      { action: "search_text", arguments: { query: "range", path_prefix: "src" } },
      { action: "run_tests", arguments: { suite: "default" } },
      {
        action: "replace_file",
        arguments: {
          slot: "methods_source",
          path: "src/methods.mjs",
          expected_sha256: "1".repeat(64),
          replacement: "replacement\n",
          rationale: "Fix the defect."
        }
      },
      {
        action: "final",
        arguments: {
          summary: "Done.",
          changed_files: ["src/methods.mjs", "src/errors.mjs", "src/router.mjs", "src/index.mjs"],
          tests_passed: true,
          mutation_count: 4
        }
      },
      { action: "abort", arguments: "authored_abort" }
    ];
    for (const action of actions) expect(decodeAction(encodeAction(action))).toEqual(action);
  });

  test("rejects open actions, extra fields, invalid digests, and trailing bytes", () => {
    expect(() => encodeAction({ action: "shell", arguments: {} })).toThrow();
    expect(() => encodeAction({ action: "read_file", arguments: { slot: "methods_source", path: "src/router.mjs" } })).toThrow();
    expect(() => encodeAction({
      action: "replace_file",
      arguments: { slot: "methods_source", path: "src/methods.mjs", expected_sha256: "no", replacement: "x", rationale: "x" }
    })).toThrow();
    const encoded = encodeAction({ action: "list_repository", arguments: {} });
    expect(() => decodeAction(Buffer.concat([encoded, Buffer.from([0])]))).toThrow();
  });

  test("encodes bounded effect outcomes", () => {
    expect(encodeListResult({ entries: [{ path: "src/methods.mjs", kind: "file" }], truncated: false }).length).toBeGreaterThan(0);
    expect(encodeReadResult({
      slot: "methods_source",
      slotCode: 2,
      path: "src/methods.mjs",
      sha256: "1".repeat(64),
      contents: "source"
    }).length).toBeGreaterThan(0);
    expect(encodeTestResult({
      exitCode: 0,
      passed: true,
      output: "pass",
      truncated: false
    }).length).toBeGreaterThan(0);
    expect(encodeReplaceOutcome({
      kind: "applied",
      payload: {
        slot: "methods_source",
        slotCode: 2,
        path: "src/methods.mjs",
        oldSha256: "1".repeat(64),
        newSha256: "2".repeat(64),
        alreadyApplied: false,
        current: {
          slot: "methods_source",
          slotCode: 2,
          path: "src/methods.mjs",
          sha256: "2".repeat(64),
          contents: "replacement"
        }
      }
    }).readUInt32LE()).toBe(0);
  });
});
