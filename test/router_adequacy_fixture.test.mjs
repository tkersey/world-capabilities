import { describe, expect, test } from "bun:test";

import * as fixture from "../packages/router-adequacy-decision-fixture/adapter.mjs";

const APPLICATION_ID = "6f26bd0ac8bd4351f4263c2f64fb68db5459d5b25f8f7ac2d060f40fea7c063c";
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

describe("router adequacy deterministic decisions", () => {
  test("follows the exact 24-decision plan from admitted working-set evidence", async () => {
    const turn = decisionTurn(0);
    expect(await decide(turn)).toEqual({ action: "list_repository", arguments: {} });

    turn.counters.decisions = 12;
    turn.context.listing = { entries: [], truncated: false };
    turn.context.documents = Object.entries(PATHS).map(([slot, path], slotCode) => ({
      slot,
      slotCode,
      path,
      sha256: String(slotCode).repeat(64),
      contents: "fixture"
    }));
    turn.context.latestSearch = { hits: [], truncated: false };
    turn.context.latestTest = { exitCode: 1, passed: false, output: "fail", truncated: false };
    turn.context.evidence.baselineFailureObserved = true;
    const replacement = await decide(turn);
    expect(replacement.action).toBe("replace_file");
    expect(replacement.arguments.slot).toBe("methods_source");
    expect(replacement.arguments.expected_sha256).toBe("2".repeat(64));

    turn.counters.decisions = 23;
    turn.context.mutations = [0, 1, 2, 3].map((index) => ({ index }));
    turn.context.evidence.mutationCount = 4;
    turn.context.evidence.latestTestPassed = true;
    turn.context.evidence.lastTestMutationCount = 4;
    expect(await decide(turn)).toEqual({
      action: "final",
      arguments: {
        summary: "Implemented the method-aware router policy and observed the complete Bun test suite passing after four approved replacements.",
        changed_files: ["src/methods.mjs", "src/errors.mjs", "src/router.mjs", "src/index.mjs"],
        tests_passed: true,
        mutation_count: 4
      }
    });
  });

  test("rejects the wrong contract and unexpected working-set state", async () => {
    const wrong = decisionTurn(0);
    wrong.contractDigest = "0".repeat(64);
    expect((await fixture.preflight(receiverContext(), request(wrong))).payload.reason).toBe("decision_contract_mismatch");

    const unexpected = decisionTurn(0);
    unexpected.context.documents.push({});
    expect((await fixture.preflight(receiverContext(), request(unexpected))).payload.reason).toBe("unexpected_initial_memory");
  });
});

async function decide(turn) {
  const outcome = await fixture.resolve(receiverContext(), request(turn));
  expect(outcome.status).toBe("ok");
  return outcome.payload;
}

function receiverContext() {
  return { applicationId: APPLICATION_ID, policy: { routerAdequacyDecisionFixture: true } };
}

function decisionTurn(decisions) {
  return {
    contractDigest: fixture.DECISION_CONTRACT_DIGEST,
    goal: { task: "Upgrade router policy.", repository: "fixture" },
    counters: { turns: decisions, decisions, effectActions: 0, childActions: 0 },
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

function request(payload) {
  return {
    requestId: "a".repeat(64),
    idempotencyKey: "idempotency",
    target: {
      descriptorFingerprint: "desc.router-adequacy-decision-fixture.v1",
      actuatorRef: "actuator.router-adequacy-decision-fixture.v1",
      actuationClass: "model"
    },
    responseSchema: { statuses: ["ok", "rejected", "failed"] },
    payload
  };
}
