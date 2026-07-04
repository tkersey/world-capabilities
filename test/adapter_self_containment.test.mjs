import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack, verifyPack, verifySelfContained } from "../harness/pack-utils.mjs";

test("negative pack is rejected", async () => {
  await expect(verifyPack(await loadPack("negative-pack", "examples"))).rejects.toThrow();
});

test("sidecar fixture imports are checksum covered", async () => {
  await verifySelfContained(await loadPack("sidecar-fixture"));
});

test("CommonJS requires are self-containment checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const childProcess = require(\"node:child_process\");\nconst childProcessRef = childProcess;\n");
    await expect(verifySelfContained({
      name: "cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unchecked builtin node:child_process/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic CommonJS requires are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-dynamic-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const mod = \"node:child_process\";\nconst childProcessRef = require(mod);\n");
    await expect(verifySelfContained({
      name: "dynamic-cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/dynamic require rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("escaped dynamic CommonJS requires are normalized before rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-escaped-dynamic-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const mod = \"node:child_process\";\nconst childProcessRef = requ\\u0069re(mod);\n");
    await expect(verifySelfContained({
      name: "escaped-dynamic-cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/dynamic require rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("folded CommonJS require specifiers are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-folded-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const childProcessRef = require(\"node:\" + \"child_process\");\n");
    await expect(verifySelfContained({
      name: "folded-cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: ["node:child_process"] }
      }
    })).rejects.toThrow(/dynamic require rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createRequire alias loaders are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-create-require-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "import { createRequire as cr } from \"node:module\";\nconst r = cr(import.meta.url);\nexport default r(\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "create-require-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: ["node:module"] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indirect eval and optional Function calls are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-indirect-eval-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "(0, eval)(\"1 + 1\");\nFunction?.(\"return 1\");\n");
    await expect(verifySelfContained({
      name: "indirect-eval-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node module loader builtin is rejected even with computed access", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-node-module-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "import * as mod from /* comment */ \"node:module\";\nconst r = mod[\"create\" + \"Require\"](\"file:///tmp/adapter.mjs\");\nexport default r(\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "node-module-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: ["node:module"] }
      }
    })).rejects.toThrow(/unsafe loader rejected|loader builtin node:module rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CommonJS module loader aliases are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-cjs-module-loader-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "module.exports = module.constructor._load(\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "cjs-module-loader-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: ["node:child_process"] }
      }
    })).rejects.toThrow(/unsafe loader rejected|CommonJS module loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("literal CommonJS requires still honor allowed builtins", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-literal-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const crypto = require(\"node:crypto\");\nconst cryptoRef = crypto;\n");
    await verifySelfContained({
      name: "literal-cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: ["node:crypto"] }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code execution builtins are rejected even when allowlisted", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-code-exec-builtin-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "import childProcess from \"node:child_process\";\nexport default childProcess;\n");
    await expect(verifySelfContained({
      name: "code-exec-builtin-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: ["node:child_process"] }
      }
    })).rejects.toThrow(/code execution builtin node:child_process rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process spawning builtins are rejected even when allowlisted", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-process-spawn-builtin-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "import cluster from \"node:cluster\";\nexport default cluster;\n");
    await expect(verifySelfContained({
      name: "process-spawn-builtin-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: ["node:cluster"] }
      }
    })).rejects.toThrow(/code execution builtin node:cluster rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("comment-hidden dynamic imports are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-comment-dynamic-import-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default import/*hide*/(\"node:fs/promises\");\n");
    await expect(verifySelfContained({
      name: "comment-dynamic-import-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: ["node:fs/promises"] }
      }
    })).rejects.toThrow(/dynamic import rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Bun import.meta.require loaders are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-import-meta-require-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default import.meta.require(\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "import-meta-require-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bracketed process builtin loaders are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-process-loader-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default process[\"getBuiltinModule\"](\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "process-loader-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("computed reflective loader access is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-reflect-loader-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default Reflect.get(process, \"getBuiltinModule\")(\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "reflect-loader-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indirect Function constructors are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-constructor-loader-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default ({}).constructor.constructor(\"return this\")()[\"pro\" + \"cess\"];\n");
    await expect(verifySelfContained({
      name: "constructor-loader-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("computed constructor property loaders are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-computed-constructor-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default ({})[\"constr\" + \"uctor\"];\n");
    await expect(verifySelfContained({
      name: "computed-constructor-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("split computed member loader construction is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-split-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = [\"con\", \"structor\"].join(\"\");\nexport default ({})[key];\n");
    await expect(verifySelfContained({
      name: "split-computed-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/computed member access rejected|unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional and destructured computed members are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-optional-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"process\";\nconst { safe, [key]: p } = {};\nexport default p?.[\"stdout\"];\n");
    await expect(verifySelfContained({
      name: "optional-computed-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/computed member access rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process loader aliases are rejected while stdout sidecar remains allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-process-alias-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default ((p) => p.getBuiltinModule(\"node:child_process\"))(process);\n");
    await expect(verifySelfContained({
      name: "process-alias-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/process access rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process stdout is allowed only for sidecar artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-process-stdout-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "process.stdout.write(\"leak\");\n");
    await writeFile(join(dir, "sidecar.mjs"), "process.stdout.write(\"ok\");\n");
    await expect(verifySelfContained({
      name: "process-stdout-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs", role: "adapter" }, { path: "sidecar.mjs", role: "sidecar" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/process access rejected/);
    await verifySelfContained({
      name: "process-stdout-sidecar-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
        metadata: { allowedBuiltins: [] }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Bun and global host aliases are rejected outside sidecar stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-bun-global-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "Bun.spawn([\"echo\", \"x\"]);\n");
    await writeFile(join(dir, "sidecar.mjs"), "for await (const chunk of Bun.stdin.stream()) {}\n");
    await expect(verifySelfContained({
      name: "bun-global-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs", role: "adapter" }, { path: "sidecar.mjs", role: "sidecar" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/Bun access rejected/);
    await verifySelfContained({
      name: "bun-stdin-sidecar-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
        metadata: { allowedBuiltins: [] }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional-chained CommonJS globals are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-optional-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const childProcess = module?.constructor._load(\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "optional-cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: ["node:child_process"] }
      }
    })).rejects.toThrow(/unsafe loader rejected|CommonJS module loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("escaped CommonJS globals are normalized before rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-escaped-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "mod\\u0075le.constructor._load(\"node:\" + \"child_process\");\n");
    await expect(verifySelfContained({
      name: "escaped-cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: ["node:child_process"] }
      }
    })).rejects.toThrow(/unsafe loader rejected|CommonJS module loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pack artifacts and imports must stay inside the pack root", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-pack-root-"));
  try {
    const packDir = join(root, "foo");
    const siblingDir = join(root, "foo-extra");
    await mkdir(packDir);
    await mkdir(siblingDir);
    await writeFile(join(packDir, "adapter.mjs"), "import \"../foo-extra/helper.mjs\";\n");
    await writeFile(join(siblingDir, "helper.mjs"), "export const helper = true;\n");
    await expect(verifySelfContained({
      name: "foo",
      dir: packDir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }, { path: "../foo-extra/helper.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/host path import|artifact path escapes pack root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlinked pack artifacts must not point outside the pack root", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-pack-symlink-"));
  try {
    const packDir = join(root, "pack");
    const siblingDir = join(root, "pack-extra");
    await mkdir(packDir);
    await mkdir(siblingDir);
    await writeFile(join(packDir, "adapter.mjs"), "import \"./helper.mjs\";\n");
    await writeFile(join(siblingDir, "helper.mjs"), "export const helper = true;\n");
    await symlink(join(siblingDir, "helper.mjs"), join(packDir, "helper.mjs"));
    await expect(verifySelfContained({
      name: "symlink-pack",
      dir: packDir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }, { path: "helper.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/artifact path escapes pack root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
