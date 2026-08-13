import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PUBLIC_DETERMINISTIC_ARCHIVE,
  PUBLIC_DETERMINISTIC_ROOT,
  buildDistributionTree,
  extractDistributionArchive,
  sha256,
  verifyDistributionTree,
  writeDeterministicArchive,
} from "../scripts/public-deterministic-v1.mjs";

test("v2.1.2 readiness preserves v2.1.1 production runtime bytes", async () => {
  const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", "v2.1.1", "src/v1", "packages"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  for (const relative of paths) {
    const prior = execFileSync("git", ["show", `v2.1.1:${relative}`]);
    expect(await readFile(relative)).toEqual(prior);
  }
});

test("deterministic distribution is reproducible and safely self-verifying", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "world-capabilities-public-test-"));
  try {
    const tree = path.join(root, PUBLIC_DETERMINISTIC_ROOT);
    await buildDistributionTree(process.cwd(), tree);
    const first = path.join(root, PUBLIC_DETERMINISTIC_ARCHIVE);
    const second = path.join(root, `second-${PUBLIC_DETERMINISTIC_ARCHIVE}`);
    const left = await writeDeterministicArchive(tree, first);
    const right = await writeDeterministicArchive(tree, second);
    expect(left.sha256).toBe(right.sha256);
    expect(sha256(await readFile(first))).toBe(left.sha256);
    const extracted = path.join(root, "extracted");
    await extractDistributionArchive(first, extracted);
    const receipt = await verifyDistributionTree(extracted);
    expect(receipt.sourceCheckoutRequired).toBe(false);
    expect(receipt.receiverSecretsRequired).toBe(false);
    expect(receipt.staticInspectionImportsAdapters).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
