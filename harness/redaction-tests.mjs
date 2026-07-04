#!/usr/bin/env bun
import { assert } from "./assertions.mjs";
import { redact } from "./pack-utils.mjs";

const sample = {
  token: "abc123456",
  nested: {
    diagnostic: "Authorization: Bearer verysecrettokenvalue",
    array: ["safe", "sk-abcdef1234567890", "api_key=abcdef123456"]
  },
  nonSecretKey: "password=super-secret-value"
};

const redacted = JSON.stringify(redact(sample));
assert(!/sk-abcdef|verysecrettokenvalue|super-secret|abcdef123456/.test(redacted), "secret-shaped value leaked");
assert(redacted.includes("[REDACTED]"), "redaction marker missing");
console.log("redaction tests passed");
