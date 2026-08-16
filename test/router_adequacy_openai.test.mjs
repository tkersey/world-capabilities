import { describe, expect, test } from "bun:test";

import * as openai from "../packages/router-adequacy-openai/adapter.mjs";

const APPLICATION_ID = "6f26bd0ac8bd4351f4263c2f64fb68db5459d5b25f8f7ac2d060f40fea7c063c";

describe("router adequacy OpenAI capability", () => {
  test("uses one fixed Responses request with strict Action output and no tools", async () => {
    let calls = 0;
    const context = liveContext(async (url, options) => {
      calls += 1;
      expect(url).toBe(openai.RESPONSES_ENDPOINT);
      expect(options.method).toBe("POST");
      expect(options.headers.Authorization).toBe("Bearer test-secret");
      const body = JSON.parse(options.body);
      expect(body.model).toBe("test-model-2026-08-15");
      expect(body.store).toBe(false);
      expect(body.background).toBe(false);
      expect(body.tools).toEqual([]);
      expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
      expect(body.text.format.schema.properties.action.enum).toHaveLength(7);
      expect(body.text.format.schema.properties.arguments.anyOf).toHaveLength(7);
      expect(body.max_output_tokens).toBe(16_384);
      expect(body.previous_response_id).toBeUndefined();
      expect(body.conversation).toBeUndefined();
      expect(body.input[0].content[0].text).toContain("four distinct approved mutations");
      const dynamic = JSON.parse(body.input[1].content[0].text);
      expect(dynamic).toEqual({
        goal: { task: "Upgrade router policy.", repository: "fixture" },
        counters: { turns: 0, decisions: 0, effectActions: 0, childActions: 0 },
        phase: "decide",
        context: decisionContext(),
        strategy_local: {}
      });
      return response({ action: "read_file", arguments: { slot: "methods_source", path: "src/methods.mjs" } });
    });

    const resolved = await openai.resolve(context, request());
    expect(resolved.status).toBe("ok");
    expect(resolved.payload).toEqual({
      action: "read_file",
      arguments: { slot: "methods_source", path: "src/methods.mjs" }
    });
    expect(resolved.claims.store).toBe(false);
    expect(calls).toBe(1);
  });

  test("fails closed on provider and Action failures", async () => {
    const refusal = liveContext(async () => providerResponse({
      output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }]
    }));
    expect((await openai.resolve(refusal, request())).payload.reason).toBe("openai_refusal");

    const invalid = liveContext(async () => response({ action: "shell", arguments: { command: "rm" } }));
    expect((await openai.resolve(invalid, request())).payload.reason).toBe("action_unknown");

    const rateLimited = liveContext(async () => new Response("rate limited", { status: 429 }));
    expect((await openai.resolve(rateLimited, request())).payload.reason).toBe("openai_http_429");
  });

  test("rejects receiver and DecisionContract mismatches before fetch", async () => {
    const context = liveContext(async () => { throw new Error("must not fetch"); });
    delete context.secrets.OPENAI_API_KEY;
    expect((await openai.preflight(context, request())).payload.reason).toBe("openai_api_key_required");
    context.secrets.OPENAI_API_KEY = "test-secret";
    context.decisionContractDigest = "0".repeat(64);
    expect((await openai.preflight(context, request())).payload.reason).toBe("decision_contract_mismatch");
  });

  test("admits only closed slot-bound Actions", () => {
    expect(() => openai.admitAction({
      action: "read_file",
      arguments: { slot: "methods_source", path: "src/router.mjs" }
    })).toThrow("action_document_slot_path_mismatch");
    expect(() => openai.admitAction({
      action: "replace_file",
      arguments: {
        slot: "pattern_source",
        path: "src/pattern.mjs",
        expected_sha256: "0".repeat(64),
        replacement: "x",
        rationale: "x"
      }
    })).toThrow("action_replace_slot_path_mismatch");
    expect(() => openai.admitAction({
      action: "final",
      arguments: { summary: "done", changed_files: [], tests_passed: true, mutation_count: -1 }
    })).toThrow("action_mutation_count_invalid");
  });
});

function request() {
  return {
    requestId: "a".repeat(64),
    idempotencyKey: "idempotency",
    target: {
      descriptorFingerprint: "desc.router-adequacy-openai.v1",
      actuatorRef: "actuator.router-adequacy-openai.v1",
      actuationClass: "model"
    },
    responseSchema: { statuses: ["ok", "rejected", "failed"] },
    payload: {
      contractDigest: openai.DECISION_CONTRACT_DIGEST,
      goal: { task: "Upgrade router policy.", repository: "fixture" },
      counters: { turns: 0, decisions: 0, effectActions: 0, childActions: 0 },
      phase: "decide",
      context: decisionContext(),
      strategyLocal: {}
    }
  };
}

function decisionContext() {
  return {
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
  };
}

function liveContext(fetchImplementation) {
  return {
    applicationId: APPLICATION_ID,
    policy: { openaiRouterAdequacy: true },
    secrets: { OPENAI_API_KEY: "test-secret" },
    openaiModel: "test-model-2026-08-15",
    allowedModels: ["test-model-2026-08-15"],
    decisionContractDigest: openai.DECISION_CONTRACT_DIGEST,
    fetchImplementation
  };
}

function response(action) {
  return providerResponse({
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(action) }] }]
  });
}

function providerResponse(overrides) {
  return new Response(JSON.stringify({
    id: "resp_fixture",
    model: "test-model-2026-08-15",
    status: "completed",
    output: [],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    ...overrides
  }), { status: 200, headers: { "content-type": "application/json" } });
}
