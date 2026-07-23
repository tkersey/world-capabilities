import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import { createAgentInvokeAdapter } from "../src/v1/index.mjs";

const childId = "ab".repeat(32);

describe("agent.invoke.v1 capability", () => {
  it("checks receiver policy and approval before child execution", async () => {
    let invocations = 0;
    const adapter = createAgentInvokeAdapter({
      invokeChild: async () => {
        invocations += 1;
        return { status: "completed", result: "child=done" };
      }
    });
    const request = fixtureRequest();

    const denied = await adapter.resolve({ policy: { childAgentLive: false }, effectAttempted: 0 }, request);
    assert.equal(denied.status, "rejected");
    assert.equal(invocations, 0);

    const approvalDenied = await adapter.resolve({
      policy: { childAgentLive: true, allowedChildApplications: [childId], approvalRequired: true },
      approval: { approved: false },
      effectAttempted: 0
    }, request);
    assert.equal(approvalDenied.status, "rejected");
    assert.equal(invocations, 0);

    const overBudget = await adapter.resolve({
      policy: {
        childAgentLive: true,
        allowedChildApplications: [childId],
        maximumChildSteps: 4,
        maximumChildFuelPerStep: 50
      },
      effectAttempted: 0
    }, request);
    assert.equal(overBudget.status, "rejected");
    assert.equal(invocations, 0);
  });

  it("returns only a bounded child result projection", async () => {
    let received = null;
    const adapter = createAgentInvokeAdapter({
      invokeChild: async (request) => {
        received = request;
        return {
          status: "completed",
          result: "child=done",
          frameBytes: Buffer.from("must not escape")
        };
      }
    });
    const context = {
      policy: { childAgentLive: true, allowedChildApplications: [childId] },
      effectAttempted: 0
    };
    const outcome = await adapter.resolve(context, fixtureRequest());

    assert.equal(outcome.status, "ok");
    assert.deepEqual(outcome.payload, { result: "child=done" });
    assert.equal(Object.prototype.hasOwnProperty.call(outcome, "frameBytes"), false);
    assert.equal(context.effectAttempted, 1);
    assert.equal(received.applicationId, childId);
    assert.equal(received.maximumSteps, 8);
  });

  it("returns deferred without fabricating child state", async () => {
    const adapter = createAgentInvokeAdapter({
      invokeChild: async () => ({ status: "deferred", frameBytes: Buffer.from("private") })
    });
    const outcome = await adapter.resolve({
      policy: { childAgentLive: true, allowedChildApplications: [childId] },
      effectAttempted: 0
    }, fixtureRequest());

    assert.equal(outcome.status, "deferred");
    assert.deepEqual(outcome.payload, { reason: "child_deferred" });
  });
});

function fixtureRequest() {
  return {
    requestId: "request",
    idempotencyKey: "idempotency",
    payload: {
      applicationId: childId,
      input: "goal=child",
      maximumSteps: 8,
      fuelPerStep: 100
    }
  };
}
