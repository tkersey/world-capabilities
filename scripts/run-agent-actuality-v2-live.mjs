#!/usr/bin/env bun
import { isAbsolute, resolve } from "node:path";

if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY_required");
if (!process.env.OPENAI_MODEL) throw new Error("OPENAI_MODEL_required");
if (!process.env.AGENT_ROOT) throw new Error("AGENT_ROOT_required");

const agentRoot = resolve(process.env.AGENT_ROOT);
const hostRoot = process.env.AGENT_WORLD_HOST_ROOT;
if (hostRoot && !isAbsolute(hostRoot)) throw new Error("AGENT_WORLD_HOST_ROOT_must_be_absolute");

const child = Bun.spawn(["zig", "build", "check-agent-actuality-live"], {
  cwd: agentRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    AGENT_WORLD_CAPABILITIES_ROOT: process.cwd(),
    ...(hostRoot ? { AGENT_WORLD_HOST_ROOT: hostRoot } : {})
  }
});
const exitCode = await child.exited;
if (exitCode !== 0) process.exit(exitCode);
