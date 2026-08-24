import { describe, expect, test } from "bun:test";

import * as openai from "../packages/repository-repair-openai/adapter.mjs";

const APPLICATION_ID = "2ed225966c6a42ad4ded0501a94e37b239d9ff4b1a3817d1e3b9097038ff7d72";
const INTERPRETATION_APPLICATION_ID = "cdd619cc1342cc9d35b5105b7abf9d359025ff71040e5ee99512d18c1188d039";

describe("repository repair OpenAI capability", () => {
  test("pairs both actuality identities with their exact decision contracts", async () => {
    const pairs = [
      [APPLICATION_ID, openai.DECISION_CONTRACT_DIGEST],
      [INTERPRETATION_APPLICATION_ID, openai.INTERPRETATION_DECISION_CONTRACT_DIGEST]
    ];
    expect(openai.ADMITTED_APPLICATION_IDS).toEqual(pairs.map(([applicationId]) => applicationId));
    for (const [applicationId, contractDigest] of pairs) {
      const context = liveContext(async () => { throw new Error("must not fetch"); }, {
        applicationId,
        contractDigest
      });
      expect((await openai.preflight(context, request(contractDigest))).status).toBe("ok");
    }
    const crossed = liveContext(async () => { throw new Error("must not fetch"); }, {
      applicationId: INTERPRETATION_APPLICATION_ID,
      contractDigest: openai.DECISION_CONTRACT_DIGEST
    });
    expect((await openai.preflight(crossed, request())).payload.reason).toBe("decision_contract_mismatch");
  });

  test("uses one fixed Responses request with strict output and no tools", async () => {
    let calls = 0;
    const context = liveContext(async (url, options) => {
      calls += 1;
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(options.method).toBe("POST");
      expect(options.headers.Authorization).toBe("Bearer test-secret");
      const body = JSON.parse(options.body);
      expect(body.model).toBe("test-model-2026-08-10");
      expect(body.store).toBe(false);
      expect(body.background).toBe(false);
      expect(body.tools).toEqual([]);
      expect(body.text.format.type).toBe("json_schema");
      expect(body.text.format.strict).toBe(true);
      expect(body.text.format.schema.type).toBe("object");
      expect(body.text.format.schema.oneOf).toBeUndefined();
      expect(body.text.format.schema.properties.action.enum).toHaveLength(7);
      expect(body.text.format.schema.properties.arguments.anyOf).toHaveLength(7);
      expect(body.previous_response_id).toBeUndefined();
      expect(body.conversation).toBeUndefined();
      expect(body.input[0].content[0].text).toContain("Inspect the repository before editing");
      expect(body.input[0].content[0].text).toContain("list_repository");
      const dynamic = JSON.parse(body.input[1].content[0].text);
      expect(dynamic).toEqual({
        goal: { task: "Fix tests.", repository: "fixture" },
        counters: { turns: 0, decisions: 0, effectActions: 0, childActions: 0 },
        phase: "decide",
        context: decisionContext(),
        strategy_local: {}
      });
      expect(body.input[1].content[0].text).not.toContain("action_catalog");
      expect(body.input[1].content[0].text).not.toContain("instructions");
      return response({ action: "read_file", arguments: { role: "source", path: "src/range.mjs" } });
    });

    const resolved = await openai.resolve(context, request());
    expect(resolved.status).toBe("ok");
    expect(resolved.payload).toEqual({ action: "read_file", arguments: { role: "source", path: "src/range.mjs" } });
    expect(resolved.claims).toEqual({
      provider: "openai",
      endpointClass: "responses",
      requestedModel: "test-model-2026-08-10",
      returnedModel: "test-model-2026-08-10",
      responseId: "resp_fixture",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      store: false
    });
    expect(calls).toBe(1);
  });

  test("fails closed on refusal, multiple outputs, invalid actions, HTTP errors, and timeout", async () => {
    const refusal = liveContext(async () => providerResponse({
      output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }]
    }));
    expect((await openai.resolve(refusal, request())).payload.reason).toBe("openai_refusal");

    const multiple = liveContext(async () => providerResponse({
      output: [{ type: "message", content: [
        { type: "output_text", text: '{"action":"list_repository","arguments":{}}' },
        { type: "output_text", text: '{"action":"list_repository","arguments":{}}' }
      ] }]
    }));
    expect((await openai.resolve(multiple, request())).payload.reason).toBe("openai_multiple_outputs");

    const invalid = liveContext(async () => response({ action: "shell", arguments: { command: "rm" } }));
    expect((await openai.resolve(invalid, request())).payload.reason).toBe("action_unknown");

    const rateLimited = liveContext(async () => new Response("rate limited", { status: 429 }));
    expect((await openai.resolve(rateLimited, request())).payload.reason).toBe("openai_http_429");

    const timedOut = liveContext((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    timedOut.requestTimeoutMs = 1;
    expect((await openai.resolve(timedOut, request())).payload.reason).toBe("openai_timeout");
  });

  test("rejects missing receiver secret, model, allowlist, and exact decision contract before fetch", async () => {
    const context = liveContext(async () => { throw new Error("must not fetch"); });
    delete context.secrets.OPENAI_API_KEY;
    expect((await openai.preflight(context, request())).payload.reason).toBe("openai_api_key_required");
    context.secrets.OPENAI_API_KEY = "test-secret";
    delete context.openaiModel;
    expect((await openai.preflight(context, request())).payload.reason).toBe("openai_model_required");
    context.openaiModel = "denied";
    context.allowedModels = ["allowed"];
    expect((await openai.preflight(context, request())).payload.reason).toBe("openai_model_not_allowed");
    context.allowedModels = ["denied"];
    context.decisionContractDigest = "0".repeat(64);
    expect((await openai.preflight(context, request())).payload.reason).toBe("decision_contract_mismatch");
  });

  test("admits only exact closed Action objects and UTF-8 byte bounds", () => {
    expect(() => openai.admitAction({ action: "read_file", arguments: { role: "source", path: "x", extra: true } })).toThrow();
    expect(() => openai.admitAction({ action: "read_file", arguments: { suite: "default" } })).toThrow();
    expect(() => openai.admitAction({ action: "read_file", arguments: { role: "test", path: "src/range.mjs" } })).toThrow();
    expect(() => openai.admitAction({ action: "replace_file", arguments: {
      path: "src/range.mjs",
      expected_sha256: "not-a-digest",
      replacement: "x",
      rationale: "x"
    } })).toThrow();
    expect(() => openai.admitAction({ action: "read_file", arguments: { role: "source", path: "é".repeat(256) } })).toThrow();
  });
});

function request(contractDigest = openai.DECISION_CONTRACT_DIGEST) {
  return {
    requestId: "a".repeat(64),
    idempotencyKey: "idempotency",
    target: {
      descriptorFingerprint: "desc.repository-repair-openai.v1",
      actuatorRef: "actuator.repository-repair-openai.v1",
      actuationClass: "model"
    },
    responseSchema: { statuses: ["ok", "rejected", "failed"] },
    payload: {
      contractDigest,
      goal: { task: "Fix tests.", repository: "fixture" },
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
    packageDocument: null,
    sourceDocument: null,
    testDocument: null,
    latestSearch: null,
    latestTest: null,
    replacement: null,
    evidence: { failingTestObserved: false, mutationApplied: false, passingTestObserved: false }
  };
}

function liveContext(fetchImplementation, {
  applicationId = APPLICATION_ID,
  contractDigest = openai.DECISION_CONTRACT_DIGEST
} = {}) {
  return {
    applicationId,
    policy: { openaiRepositoryRepair: true },
    secrets: { OPENAI_API_KEY: "test-secret" },
    openaiModel: "test-model-2026-08-10",
    allowedModels: ["test-model-2026-08-10"],
    decisionContractDigest: contractDigest,
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
    model: "test-model-2026-08-10",
    status: "completed",
    output: [],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    ...overrides
  }), { status: 200, headers: { "content-type": "application/json" } });
}
