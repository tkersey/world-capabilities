import { expect, test } from "bun:test";
import { redact } from "../harness/pack-utils.mjs";

test("secret-shaped diagnostics are redacted", () => {
  const result = JSON.stringify(redact({ diagnostic: "sk-abcdef1234567890", nested: ["api_key=abcdef1234"] }));
  expect(result).not.toContain("abcdef1234567890");
  expect(result).not.toContain("abcdef1234");
});
