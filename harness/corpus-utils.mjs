import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { stableStringify } from "./assertions.mjs";

export const CORPUS_ROOT = "corpus";
export const GENERATED_CORPUS_FILES = new Set([
  "corpus/agent-runtime-v0.1/checksums.json",
  "corpus/agent-runtime-v0.1/expected-fingerprints.json"
]);

export function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path, value) {
  await writeFile(path, `${stableStringify(value)}\n`);
}

export async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      if (entry.isFile()) out.push(full);
    }
  }
  await walk(root);
  return out.sort();
}

export async function corpusChecksums() {
  const files = await listFiles(CORPUS_ROOT);
  const checksums = {};
  for (const file of files) {
    const rel = relative(".", file);
    if (GENERATED_CORPUS_FILES.has(rel)) continue;
    checksums[rel] = sha256Bytes(await readFile(file));
  }
  return checksums;
}

export async function corpusFingerprint() {
  const checksums = await corpusChecksums();
  return sha256Text(stableStringify(checksums));
}
