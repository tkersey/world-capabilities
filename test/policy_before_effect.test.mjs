import { expect, test } from "bun:test";
import { resolve } from "../packages/generic-http-json/adapter.mjs";

test("missing idempotency key prevents effect", async () => {
  const context = { policy: { live: true }, effectAttempted: 0 };
  const result = await resolve(context, {
    requestId: "test",
    target: { descriptorFingerprint: "desc.generic-http-json.v0" },
    responseSchema: { statuses: ["ok", "rejected", "failed"] },
    payload: { url: "https://example.invalid", method: "GET" }
  });
  expect(result.status).toBe("rejected");
  expect(context.effectAttempted).toBe(0);
});
