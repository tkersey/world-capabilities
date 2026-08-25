import { describe, expect, test } from "bun:test";

import * as fixture from "../packages/repository-repair-decision-fixture/adapter.mjs";
import fixtureManifest from "../packages/repository-repair-decision-fixture/manifest.json" with { type: "json" };
import { repositoryRepairDecisionFixtureBinding } from "../src/v1/actuality/repository_repair_fixture_binding.mjs";

const APPLICATION_ID = "2ed225966c6a42ad4ded0501a94e37b239d9ff4b1a3817d1e3b9097038ff7d72";
const INTERPRETATION_APPLICATION_ID = "b2e6628424ed95648a554ab5730566476360de86c9534a375357ba152031cf4c";

describe("repository repair deterministic decision v2", () => {
  test("admits the existing and Boundary 1.6 application identities only", async () => {
    expect(fixture.ADMITTED_APPLICATION_IDS).toEqual([
      APPLICATION_ID,
      INTERPRETATION_APPLICATION_ID
    ]);
    expect(fixtureManifest.effectProtocolV1.interfaces.at(0).applicationIds)
      .toEqual(fixture.ADMITTED_APPLICATION_IDS);
    expect(repositoryRepairDecisionFixtureBinding().applicationIds.map((id) => id.toString("hex")))
      .toEqual(fixture.ADMITTED_APPLICATION_IDS);

    const contracts = [
      fixture.DECISION_CONTRACT_DIGEST,
      fixture.INTERPRETATION_DECISION_CONTRACT_DIGEST
    ];
    for (const [index, applicationId] of fixture.ADMITTED_APPLICATION_IDS.entries()) {
      const context = receiverContext();
      context.applicationId = applicationId;
      const turn = decisionTurn();
      turn.contractDigest = contracts[index];
      expect((await fixture.preflight(context, request(turn))).status).toBe("ok");
    }
    const crossed = receiverContext();
    crossed.applicationId = INTERPRETATION_APPLICATION_ID;
    expect((await fixture.preflight(crossed, request(decisionTurn()))).payload.reason)
      .toBe("decision_contract_mismatch");
    const unknown = receiverContext();
    unknown.applicationId = "0".repeat(64);
    expect((await fixture.preflight(unknown, request(decisionTurn()))).payload.reason)
      .toBe("application_not_admitted");
  });

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
