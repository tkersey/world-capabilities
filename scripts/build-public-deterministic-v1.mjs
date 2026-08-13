#!/usr/bin/env bun
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_DETERMINISTIC_ARCHIVE,
  PUBLIC_DETERMINISTIC_ROOT,
  buildDistributionTree,
  writeDeterministicArchive,
} from "./public-deterministic-v1.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.resolve(valueAfter("--output-dir") ?? "zig-out/public-deterministic");
const temporary = await mkdtemp(path.join(tmpdir(), "world-capabilities-public-deterministic-"));
try {
  const tree = path.join(temporary, PUBLIC_DETERMINISTIC_ROOT);
  await buildDistributionTree(repository, tree);
  const archive = path.join(outputDir, PUBLIC_DETERMINISTIC_ARCHIVE);
  const result = await writeDeterministicArchive(tree, archive);
  await writeFile(`${archive}.sha256`, `${result.sha256}  ${PUBLIC_DETERMINISTIC_ARCHIVE}\n`);
  process.stdout.write(`${JSON.stringify({ schema: "world-capabilities-public-deterministic-build/v1", archive, ...result }, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  if (index + 1 >= process.argv.length) throw new Error(`${flag} requires a value`);
  return process.argv[index + 1];
}
