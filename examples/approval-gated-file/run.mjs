import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve as approve } from "../../packages/human-approval/adapter.mjs";
import { resolve as writeFileCapability } from "../../packages/sandbox-files/adapter.mjs";

const approval = await approve({ approvalMode: "allow", policy: { humanLive: true } }, {
  requestId: "example-approval",
  idempotencyKey: "world:idem:example-approval",
  target: { descriptorFingerprint: "desc.human-approval.v0", actuatorRef: "actuator.human-approval", actuationClass: "approval" },
  responseSchema: { statuses: ["ok", "rejected"] },
  payload: { anchor: "world:host-request:1", prompt: "Approve write?" }
});

const root = await mkdtemp(join(tmpdir(), "world-capabilities-"));
const file = await writeFileCapability({ fixtureRoot: root, policy: { fileWrite: true }, approval: { approved: approval.status === "ok" } }, {
  requestId: "example-file-write",
  idempotencyKey: "world:idem:example-file-write",
  target: { descriptorFingerprint: "desc.sandbox-files.v0", actuatorRef: "actuator.sandbox-files", actuationClass: "file" },
  responseSchema: { statuses: ["ok", "rejected", "failed"] },
  payload: { operation: "write", path: "fixture.txt", bytes: "approved" }
});

console.log(JSON.stringify({ approval, file }, null, 2));
