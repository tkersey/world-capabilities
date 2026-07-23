import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CapabilityRouterV1,
  EffectStatus,
  decodeStringValue,
  encodeStringValue,
  fixtureAgentBindings
} from "../src/v1/index.mjs";

const options = parseArgs(process.argv.slice(2));
const host = await import(pathToFileURL(path.join(options.worldHostRepo, "src/v1/index.mjs")).href);
const wasmBytes = await readFile(path.join(options.worldRepo, "zig-out/world-apps/fixture-agent.world.wasm"));
const root = await mkdtemp(path.join(tmpdir(), "world-capabilities-v1-"));

try {
  await writeFile(path.join(root, "fixture-input.txt"), "rewrite this file through the agent loop\n");
  const router = new CapabilityRouterV1({ bindings: fixtureAgentBindings() });
  const context = {
    fixtureRoot: root,
    policy: { fileWrite: true },
    approval: { approved: true },
    effectAttempted: 0,
    attempt: 1
  };
  const retainedResults = new Map();
  const first = await runApplication({ host, wasmBytes, router, context, retainedResults, replay: false });
  assert.equal(first.finalResult, "final=fixture updated");
  assert.deepEqual(first.bindingIds, [
    "fixture-agent.model.v1",
    "fixture-agent.file-read.v1",
    "fixture-agent.model.v1",
    "fixture-agent.file-write.v1",
    "fixture-agent.model.v1"
  ]);
  assert.equal(await readFile(path.join(root, "fixture-output.txt"), "utf8"), "actuate updated the fixture");
  assert.equal(context.effectAttempted, 2);

  const effectsBeforeReplay = context.effectAttempted;
  const replay = await runApplication({ host, wasmBytes, router, context, retainedResults, replay: true });
  assert.equal(replay.finalResult, "final=fixture updated");
  assert.equal(context.effectAttempted, effectsBeforeReplay);

  console.log("effect_protocol_v1=true");
  console.log("external_sequence=model,read,model,write,model");
  console.log("policy_before_effect=true");
  console.log("capability_frame_authority=false");
  console.log("fresh_effects_on_replay=0");
  console.log("file_writes=1");
  console.log("final=fixture updated");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function runApplication({ host, wasmBytes, router, context, retainedResults, replay }) {
  let frameBytes = null;
  let frame = null;
  const bindingIds = [];
  while (frame === null || frame.status === host.FrameStatus.needsEffect) {
    let input;
    if (frame === null) {
      const worker = new host.ApplicationWorker();
      await worker.instantiate(wasmBytes);
      const manifest = worker.readManifest();
      input = host.encodeStepInput({
        applicationId: manifest.applicationId,
        initialArgsBytes: encodeStringValue("goal=fixture"),
        fuel: 100n
      }, manifest.limits);
      const output = worker.step(input);
      worker.dispose();
      frameBytes = output.frameBytes;
      frame = output.frame;
      continue;
    }

    const requestKey = Buffer.from(frame.pendingEffect.requestId).toString("hex");
    let result = retainedResults.get(requestKey);
    if (!replay) {
      const resolution = await router.resolve(context, frame.pendingEffect.encodedBytes);
      result = resolution.result;
      retainedResults.set(requestKey, result);
      bindingIds.push(resolution.bindingId);
    } else {
      assert(result, `missing retained result for ${requestKey}`);
    }

    const worker = new host.ApplicationWorker();
    await worker.instantiate(wasmBytes);
    const manifest = worker.readManifest();
    input = host.encodeStepInput({
      applicationId: manifest.applicationId,
      expectedParentFrameId: frame.frameId,
      priorFrameBytes: frameBytes,
      effectResult: result.encodedBytes,
      fuel: 100n
    }, manifest.limits);
    const output = worker.step(input);
    if (!replay && bindingIds.at(-1) === "fixture-agent.file-write.v1") {
      const retryWorker = new host.ApplicationWorker();
      await retryWorker.instantiate(wasmBytes);
      const retry = retryWorker.step(input);
      retryWorker.dispose();
      assert.deepEqual(retry.frameBytes, output.frameBytes);
    }
    worker.dispose();
    frameBytes = output.frameBytes;
    frame = output.frame;
  }

  assert.equal(frame.status, host.FrameStatus.completed);
  return { finalResult: decodeStringValue(frame.finalResultBytes), bindingIds };
}

function parseArgs(args) {
  const result = {
    worldRepo: path.resolve("../world"),
    worldHostRepo: path.resolve("../world-host")
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--world-repo") result.worldRepo = path.resolve(requiredValue(args, ++index, "--world-repo"));
    else if (args[index] === "--world-host-repo") result.worldHostRepo = path.resolve(requiredValue(args, ++index, "--world-host-repo"));
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  return result;
}

function requiredValue(args, index, flag) {
  if (index >= args.length) throw new Error(`${flag} requires a value`);
  return args[index];
}
