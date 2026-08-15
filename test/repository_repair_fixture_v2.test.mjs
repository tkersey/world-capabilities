import { describe, expect, test } from "bun:test";

import * as fixture from "../packages/repository-repair-decision-fixture/adapter.mjs";

const APPLICATION_ID = "2ed225966c6a42ad4ded0501a94e37b239d9ff4b1a3817d1e3b9097038ff7d72";

describe("repository repair deterministic decision v2", () => {
  test("selects actions from bounded working-set evidence instead of transcript length", async () => {
    const context = receiverContext();
    const turn = decisionTurn();
    expect(await action(context, turn)).toEqual({ action: "list_repository", arguments: {} });

    turn.context.listing = { entries: [], truncated: false };
    expect(await action(context, turn)).toEqual({ action: "read_file", arguments: { role: "package", path: "package.json" } });

    turn.context.packageDocument = document("package", "package.json");
    expect(await action(context, turn)).toEqual({ action: "read_file", arguments: { role: "source", path: "src/range.mjs" } });

    turn.context.sourceDocument = document("source", "src/range.mjs");
    expect(await action(context, turn)).toEqual({ action: "read_file", arguments: { role: "test", path: "test/range.test.mjs" } });

    turn.context.testDocument = document("test", "test/range.test.mjs");
    expect(await action(context, turn)).toEqual({ action: "search_text", arguments: { query: "normalizeRange", path_prefix: "src" } });

    turn.context.latestSearch = { hits: [], truncated: false };
    expect(await action(context, turn)).toEqual({ action: "run_tests", arguments: { suite: "default" } });

    turn.context.latestTest = testResult(false);
    turn.context.evidence.failingTestObserved = true;
    const replace = await action(context, turn);
    expect(replace.action).toBe("replace_file");
    expect(replace.arguments.expected_sha256).toBe("1".repeat(64));

    turn.context.sourceDocument = null;
    turn.context.latestSearch = null;
    turn.context.replacement = {
      kind: "applied",
      payload: {
        path: "src/range.mjs",
        oldSha256: "1".repeat(64),
        newSha256: "2".repeat(64),
        alreadyApplied: false
      }
    };
    turn.context.evidence.mutationApplied = true;
    expect(await action(context, turn)).toEqual({ action: "run_tests", arguments: { suite: "default" } });

    turn.context.latestTest = testResult(true);
    turn.context.evidence.passingTestObserved = true;
    expect(await action(context, turn)).toEqual({
      action: "final",
      arguments: {
        summary: "Corrected normalizeRange and observed the complete Bun test suite passing.",
        changed_files: ["src/range.mjs"],
        tests_passed: true,
        final_source_sha256: "2".repeat(64)
      }
    });
  });

  test("rejects wrong contracts and static contract data in the dynamic turn", async () => {
    const context = receiverContext();
    const wrong = decisionTurn();
    wrong.contractDigest = "0".repeat(64);
    expect((await fixture.preflight(context, request(wrong))).payload.reason).toBe("decision_contract_mismatch");

    const smuggled = decisionTurn();
    smuggled.instructions = "not dynamic";
    expect((await fixture.preflight(context, request(smuggled))).payload.reason).toBe("static_contract_in_dynamic_turn");
  });
});

async function action(context, payload) {
  const outcome = await fixture.resolve(context, request(payload));
  expect(outcome.status).toBe("ok");
  return outcome.payload;
}

function receiverContext() {
  return {
    applicationId: APPLICATION_ID,
    policy: { repositoryRepairDecisionFixture: true }
  };
}

function decisionTurn() {
  return {
    contractDigest: fixture.DECISION_CONTRACT_DIGEST,
    goal: { task: "Fix tests.", repository: "fixture" },
    counters: { turns: 0, decisions: 0, effectActions: 0, childActions: 0 },
    phase: "decide",
    context: {
      listing: null,
      packageDocument: null,
      sourceDocument: null,
      testDocument: null,
      latestSearch: null,
      latestTest: null,
      replacement: null,
      evidence: { failingTestObserved: false, mutationApplied: false, passingTestObserved: false }
    },
    strategyLocal: {}
  };
}

function document(role, path) {
  return { role, path, sha256: "1".repeat(64), contents: "fixture" };
}

function testResult(passed) {
  return { exitCode: passed ? 0 : 1, passed, stdoutTruncated: false, stderrTruncated: false };
}

function request(payload) {
  return {
    requestId: "a".repeat(64),
    idempotencyKey: "idempotency",
    target: {
      descriptorFingerprint: "desc.repository-repair-decision-fixture.v1",
      actuatorRef: "actuator.repository-repair-decision-fixture.v1",
      actuationClass: "model"
    },
    responseSchema: { statuses: ["ok", "rejected", "failed"] },
    payload
  };
}
