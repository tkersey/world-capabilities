import { expect, test } from "bun:test";
import { assertNoForbiddenEvidence } from "../harness/pack-utils.mjs";

test("forbidden evidence keys are rejected recursively", () => {
  expect(() => assertNoForbiddenEvidence({ diagnostics: [{ capsuleBytes: "no" }] })).toThrow();
});
