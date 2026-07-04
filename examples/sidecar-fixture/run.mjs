import { spawnSync } from "node:child_process";

const proc = spawnSync("bun", ["sidecar.mjs"], {
  cwd: new URL("../../packages/sidecar-fixture/", import.meta.url),
  input: JSON.stringify({ requestId: "example-sidecar" }),
  encoding: "utf8",
  timeout: 2000
});
console.log(proc.stdout);
